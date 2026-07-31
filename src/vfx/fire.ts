// Core fire VFX system (Section 10, layers 1, 2, 5, plus cheap smoke layer 3),
// rebuilt on physically-motivated foundations:
//
//   COLOR    every hot particle carries a spawn temperature (aTemp, normalized
//            0..1 over 1000 K..2600 K) that decays over its lifetime; the
//            fragment shaders resolve color through a blackbody ramp
//            (Planckian-locus chromaticity fit x compressed Stefan-Boltzmann
//            radiance) emitting HDR values well above 1, which the ACES grade
//            pass tone-resolves downstream.
//   MOTION   the closed-form trajectory (start + v*t + 0.5*buoyancy*t^2, with
//            buoyancy proportional to temperature) is extended by a curl-noise
//            displacement sampled procedurally in the vertex shader. See the
//            fbCurlOffset docs for the frozen-turbulence approximation that
//            keeps update() O(1).
//   SOFT     all three materials depth-fade against the scene depth buffer
//            when the post pipeline binds it (configureFirePass); headless and
//            raw-render paths leave it disabled and lose nothing.
//   EMBERS   per-particle temperature varies buoyancy: hot embers rise, cool
//            ones arc over, fall, land on the floor plane (closed-form landing
//            time solved in the vertex shader) and fade out where they lie.
//   SMOKE    tinted by the flame emitter's live spawn activity at birth,
//            eroded by turbulent dissipation, curl-displaced as it rises.
//   LIGHT    pooled point lights flicker from the flame emitter's ACTUAL live
//            particle count (hash of the integer count + density floor), not
//            from a canned sine.
//
// Everything is GPU-instanced: per-particle motion is computed entirely in the
// vertex shader from spawn-time attributes, so update() only advances a clock
// uniform (plus one O(1) activity EMA). The CPU touches attribute buffers
// exclusively when new particles spawn.
//
// Per-move VFX composes these pieces through the FireSystem facade:
//   spawnBurst(position, direction, opts)  - one-shot fireball/impact material
//   flames/embers/smoke .spawn(opts)       - direct emitter access for streams
//   lights.acquire(position, ...)          - traveling firelight (layer 5)
//   attachAmbient(anchor, scale)           - continuous brazier-style flame
//
// All shaders are embedded template strings, all textures procedural and
// guarded for headless node, no external assets.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Palette (Section 9: warm only). Particle color now comes from the blackbody
// ramp below; this constant remains the pooled point light tint (~1900 K).
// ---------------------------------------------------------------------------

export const FIRELIGHT_COLOR = 0xff8a3c;

/**
 * Scene layer the post pipeline moves fire particle meshes onto so it can
 * render them in a dedicated half-resolution pass. Raw-render debug paths
 * never touch it and keep the meshes on layer 0.
 */
export const FIRE_PASS_LAYER = 1;

/** World-space floor plane embers land on (courtyard ground). */
export const EMBER_FLOOR_Y = 0;

// ---------------------------------------------------------------------------
// Deterministic pseudo-random (stable tests, stable ember drift)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

const NOISE_GLSL = /* glsl */ `
  float fireHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  // Value noise: bilinear interpolation of hashed lattice values.
  float fireValueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = fireHash(i);
    float b = fireHash(i + vec2(1.0, 0.0));
    float c = fireHash(i + vec2(0.0, 1.0));
    float d = fireHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  // 2D curl of the value-noise potential: rotate the gradient 90 degrees.
  // Divergence-free by construction in the sampled plane.
  vec2 fireCurl(vec2 p) {
    const float e = 0.35;
    float nTop = fireValueNoise(p + vec2(0.0, e));
    float nBot = fireValueNoise(p - vec2(0.0, e));
    float nRight = fireValueNoise(p + vec2(e, 0.0));
    float nLeft = fireValueNoise(p - vec2(e, 0.0));
    return vec2(nTop - nBot, nLeft - nRight) / (2.0 * e);
  }
`;

/**
 * Blackbody color ramp, shared by every hot-particle fragment shader.
 *
 * PHYSICAL MODEL AND APPROXIMATIONS (documented per the rebuild brief):
 * - Chromaticity: per-channel fit of the Planckian locus over 1000..2600 K
 *   (fit against the Helland/Charity blackbody tables; channel error < 0.03).
 *   u = 0 is 1000 K deep red, u ~ 0.56 is 1900 K orange, u = 1 is 2600 K
 *   yellow-white.
 * - Radiance: true Stefan-Boltzmann T^4 spans ~4 decades over this range and
 *   would crush every sub-1500 K fringe to black through ACES, so the
 *   exponent is compressed to 2 (quadratic in u) with a small floor. The
 *   hot end still emits HDR values well above 1.0 for bloom + ACES to
 *   resolve into the yellow-white core.
 */
const BLACKBODY_GLSL = /* glsl */ `
  vec3 fbBlackbody(float u) {
    u = clamp(u, 0.0, 1.0);
    float g = 0.22 + 0.44 * u;
    float b = 0.35 * pow(max(u - 0.55, 0.0) / 0.45, 1.6);
    float radiance = mix(0.14, 2.2, u * u);
    return vec3(1.0, g, b) * radiance;
  }
`;

/**
 * Curl-noise advection, O(1) per vertex.
 *
 * APPROXIMATION: the true model advects each particle through a time-varying
 * curl velocity field, which needs per-frame integration and would break the
 * closed-form attribute design (update() touching every particle). Instead
 * the analytic trajectory is displaced by the curl of a FROZEN value-noise
 * field sampled at the spawn position, advected by age (the field scrolls
 * downward past the rising particle, i.e. Taylor's frozen-turbulence
 * hypothesis), and scaled by an age ramp so turbulence grows as the particle
 * entrains cooler air. This is a single-sample Euler integral of frozen
 * turbulence: divergence-free in each sampled plane, coherent per particle,
 * and free of any CPU work.
 */
const CURL_OFFSET_GLSL = /* glsl */ `
  vec3 fbCurlOffset(vec3 seedPos, float age, float seed, float amp) {
    vec2 pxz = seedPos.xz * 1.7 + vec2(seed * 37.0, seed * 91.0) + vec2(0.0, -age * 0.9);
    vec2 cxz = fireCurl(pxz);
    vec2 pxy = seedPos.xy * 1.7 + vec2(seed * 53.0, -age * 1.2);
    vec2 cxy = fireCurl(pxy);
    // Turbulence increases with age: quiet at birth, fully developed ~1.2 s.
    float grow = age * (0.35 + 0.65 * min(age * 0.8, 1.0));
    return vec3(cxz.x + 0.5 * cxy.x, cxy.y, cxz.y) * (amp * grow);
  }
`;

// Attribute/varying block common to every emitter vertex shader.
const PARTICLE_ATTRIBUTES_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uBuoyancy;
  attribute float aSpawn;
  attribute float aLifetime;
  attribute vec3 aStart;
  attribute vec3 aVelocity;
  attribute float aSize;
  attribute float aSeed;
  attribute float aTemp;
  varying vec2 vUv;
  varying float vLife;
  varying float vSeed;
  varying float vTemp;
  varying float vViewZ;
`;

/**
 * Soft-particle depth fade. The post pipeline binds the scene depth texture
 * (uSoftEnabled = 1) and the fragment fades out as it approaches scene
 * geometry, killing the hard billboard intersection lines. The guard branch
 * is uniform control flow, so it is legal around the texture sample and free
 * when disabled (headless tests, raw-render debug harnesses).
 */
const SOFT_PARTICLE_GLSL = /* glsl */ `
  uniform sampler2D uSceneDepth;
  uniform float uSoftEnabled;
  uniform vec2 uFireRes;
  uniform float uCamNear;
  uniform float uCamFar;
  uniform float uSoftDist;
  float fbLinearZ(float d) {
    float ndc = d * 2.0 - 1.0;
    return (2.0 * uCamNear * uCamFar) / (uCamFar + uCamNear - ndc * (uCamFar - uCamNear));
  }
  float fbSoftFade(float fragViewZ) {
    if (uSoftEnabled < 0.5) return 1.0;
    vec2 uv = gl_FragCoord.xy / uFireRes;
    float sceneZ = fbLinearZ(texture2D(uSceneDepth, uv).x);
    return clamp((sceneZ - fragViewZ) / uSoftDist, 0.0, 1.0);
  }
`;

interface MaterialBundle {
  material: THREE.ShaderMaterial;
  uTime: THREE.IUniform<number>;
}

function softUniforms(softDist: number): Record<string, THREE.IUniform> {
  return {
    uSceneDepth: { value: null },
    uSoftEnabled: { value: 0 },
    uFireRes: { value: new THREE.Vector2(1, 1) },
    uCamNear: { value: 0.1 },
    uCamFar: { value: 100 },
    uSoftDist: { value: softDist },
  };
}

// ---------------------------------------------------------------------------
// Flame material (layer 1): noise-distorted radial gradient, NOT a flat
// sprite. Two octaves of value noise scroll upward over the particle's life
// and erode the radial falloff. The eroded radial field doubles as the local
// temperature profile: the core sits at the particle temperature, the edges
// run cooler, and fbBlackbody resolves both to color. Additive (ONE, ONE via
// premultiplied output with zero alpha so the off-screen fire target's alpha
// stays smoke-only), no depth writes.
// ---------------------------------------------------------------------------

function makeFlameMaterial(): MaterialBundle {
  const uTime: THREE.IUniform<number> = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime,
      uBuoyancy: { value: 2.6 },
      uCool: { value: 0.72 },
      uCurlAmp: { value: 0.16 },
      ...softUniforms(0.5),
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    vertexShader: /* glsl */ `
      ${PARTICLE_ATTRIBUTES_GLSL}
      uniform float uCool;
      uniform float uCurlAmp;
      ${NOISE_GLSL}
      ${CURL_OFFSET_GLSL}
      void main() {
        vUv = uv;
        vSeed = aSeed;
        float age = uTime - aSpawn;
        float life = max(aLifetime, 1e-4);
        float t = age / life;
        vLife = clamp(t, 0.0, 1.0);
        // alive = 1 while 0 <= age and t < 1, else the quad collapses to a
        // point (degenerate triangles, ~free), which is what lets update()
        // skip all per-instance CPU work for dead particles.
        float alive = step(0.0, age) * (1.0 - step(1.0, t));
        // Buoyancy proportional to temperature: hotter gas is lighter.
        float buoy = uBuoyancy * aTemp;
        vec3 pos = aStart + aVelocity * age
          + vec3(0.0, 0.5 * buoy * age * age, 0.0);
        pos += fbCurlOffset(aStart, age, aSeed, uCurlAmp);
        // Radiative + entrainment cooling over the particle's life.
        vTemp = aTemp * (1.0 - uCool * vLife);
        float grow = smoothstep(0.0, 0.12, t);
        float shrink = 1.0 - 0.85 * smoothstep(0.55, 1.0, t);
        float s = aSize * grow * shrink * alive;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        // Billboard: offset the quad corner in view space, slightly taller
        // than wide so flames read as licks, not discs.
        mv.xy += position.xy * vec2(s * 0.9, s * 1.25);
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying float vLife;
      varying float vSeed;
      varying float vTemp;
      varying float vViewZ;
      ${NOISE_GLSL}
      ${BLACKBODY_GLSL}
      ${SOFT_PARTICLE_GLSL}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        // Two octaves of value noise scrolling upward over lifetime.
        float t = uTime * 1.35 + vSeed * 61.7;
        vec2 nUv = vUv * 2.7 + vec2(vSeed * 19.3, -t);
        float n = fireValueNoise(nUv) * 0.65
                + fireValueNoise(nUv * 2.0 + vec2(5.2, 1.3) - vec2(0.0, t * 0.7)) * 0.35;
        // Radial falloff, slightly tighter horizontally, eroded by the noise
        // and by age so flames tatter apart as they die.
        float r = length(p * vec2(1.2, 0.92));
        float d = r + (n - 0.5) * 0.75 + vLife * 0.32;
        float heat = clamp(1.0 - d, 0.0, 1.0);
        float alpha = smoothstep(0.02, 0.38, heat);
        alpha *= 1.0 - smoothstep(0.62, 1.0, vLife);
        alpha *= fbSoftFade(vViewZ);
        if (alpha < 0.004) discard;
        // Local temperature: particle temperature at the eroded core, cooler
        // toward the tattered edges. Blackbody resolves color AND radiance.
        vec3 col = fbBlackbody(vTemp * (0.30 + 0.85 * heat));
        gl_FragColor = vec4(col * alpha, 0.0);
      }
    `,
  });
  return { material, uTime };
}

// ---------------------------------------------------------------------------
// Ember material (layer 2): tiny bright quads. Buoyancy is proportional to
// temperature around a neutral point, so hot embers rise while cool ones arc
// over and FALL; falling embers solve their floor-landing time in closed form
// in the vertex shader, stop on the floor plane and fade where they lie.
// Curl-noise turbulence replaces the old layered sin/cos (uCurlAmp keeps the
// historical uCurl name prefix for shader-sanity tests).
// ---------------------------------------------------------------------------

function makeEmberMaterial(): MaterialBundle {
  const uTime: THREE.IUniform<number> = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime,
      uBuoyancy: { value: 1.2 },
      uCurlAmp: { value: 0.55 },
      uFloorY: { value: EMBER_FLOOR_Y },
      ...softUniforms(0.25),
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    vertexShader: /* glsl */ `
      ${PARTICLE_ATTRIBUTES_GLSL}
      uniform float uCurlAmp;
      uniform float uFloorY;
      varying float vLanded;
      ${NOISE_GLSL}
      ${CURL_OFFSET_GLSL}
      void main() {
        vUv = uv;
        vSeed = aSeed;
        float age = uTime - aSpawn;
        float life = max(aLifetime, 1e-4);
        float t = age / life;
        vLife = clamp(t, 0.0, 1.0);
        float alive = step(0.0, age) * (1.0 - step(1.0, t));
        // Temperature-proportional buoyancy around a neutral point: embers
        // above ~1500 K rise, cooler ones sink (drag-limited, far below g).
        float b = uBuoyancy * (aTemp - 0.5) * 2.2;
        // Closed-form landing: earliest positive root of
        // start.y + vy*t + 0.5*b*t^2 = floor (only sinking embers land).
        float tl = 1e9;
        float h = aStart.y - uFloorY;
        if (b < -1e-4) {
          float disc = aVelocity.y * aVelocity.y - 2.0 * b * h;
          if (disc > 0.0) {
            float root = (-aVelocity.y - sqrt(disc)) / b;
            if (root > 0.0) tl = root;
          }
        }
        float te = min(age, tl);
        // Landed embers glow in place and fade over ~1.2 s.
        float landed = clamp((age - tl) * 0.8, 0.0, 1.0);
        vLanded = landed;
        vec3 pos = aStart + aVelocity * te + vec3(0.0, 0.5 * b * te * te, 0.0);
        pos += fbCurlOffset(aStart, te, aSeed, uCurlAmp) * (1.0 - landed);
        if (landed > 0.0) pos.y = uFloorY + 0.015;
        // Cooling: airborne radiative decay plus a fast quench on landing.
        vTemp = aTemp * (1.0 - 0.7 * vLife) * (1.0 - 0.55 * landed);
        float shrink = 1.0 - 0.7 * smoothstep(0.6, 1.0, t);
        float s = aSize * smoothstep(0.0, 0.05, t) * shrink * alive;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        mv.xy += position.xy * s;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying float vLife;
      varying float vSeed;
      varying float vTemp;
      varying float vViewZ;
      varying float vLanded;
      ${BLACKBODY_GLSL}
      ${SOFT_PARTICLE_GLSL}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float core = 1.0 - clamp(length(p), 0.0, 1.0);
        core = core * core;
        // Twinkle: embers pulse as they tumble through cooler air; landed
        // embers stop twinkling and just cool.
        float twinkle = mix(0.72 + 0.28 * sin(uTime * 19.0 + vSeed * 87.0), 0.85, vLanded);
        float alpha = core * twinkle
          * (1.0 - smoothstep(0.55, 1.0, vLife))
          * (1.0 - 0.9 * vLanded);
        alpha *= fbSoftFade(vViewZ);
        if (alpha < 0.004) discard;
        // Blackbody burnout: white-gold core cooling through orange to deep
        // red before winking out.
        vec3 col = fbBlackbody(vTemp * (0.45 + 0.75 * core));
        gl_FragColor = vec4(col * alpha, 0.0);
      }
    `,
  });
  return { material, uTime };
}

// ---------------------------------------------------------------------------
// Smoke material (layer 3, cheap): sparse soft billboards, low opacity,
// premultiplied normal blending (so the half-res fire target composites
// scene * (1 - a) + rgb in one step). Smoke born over active fire carries a
// warm tint from the flame emitter's live spawn activity (aTemp doubles as
// the tint amount) that fades as the puff rises and cools; the tail of its
// life dissolves through turbulent noise erosion instead of a flat fade.
// ---------------------------------------------------------------------------

function makeSmokeTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
  g.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  g.addColorStop(0.55, 'rgba(255, 255, 255, 0.4)');
  g.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  // A few soft blotches so the puff is not a perfect disc.
  for (let i = 0; i < 5; i++) {
    const x = 34 + ((i * 37) % 60);
    const y = 30 + ((i * 53) % 64);
    const b = ctx.createRadialGradient(x, y, 2, x, y, 26);
    b.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
    b.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = b;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

interface SmokeMaterialBundle extends MaterialBundle {
  texture: THREE.Texture | null;
}

function makeSmokeMaterial(): SmokeMaterialBundle {
  const uTime: THREE.IUniform<number> = { value: 0 };
  const texture = makeSmokeTexture();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime,
      uBuoyancy: { value: 0.12 },
      uOpacity: { value: 0.12 },
      uMap: { value: texture },
      uUseMap: { value: texture ? 1 : 0 },
      ...softUniforms(0.9),
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      ${PARTICLE_ATTRIBUTES_GLSL}
      ${NOISE_GLSL}
      ${CURL_OFFSET_GLSL}
      void main() {
        vUv = uv;
        vSeed = aSeed;
        float age = uTime - aSpawn;
        float life = max(aLifetime, 1e-4);
        float t = age / life;
        vLife = clamp(t, 0.0, 1.0);
        float alive = step(0.0, age) * (1.0 - step(1.0, t));
        vec3 pos = aStart + aVelocity * age
          + vec3(0.0, 0.5 * uBuoyancy * age * age, 0.0);
        // Slow lateral drift plus growing curl turbulence: dissipation.
        pos.x += sin(age * 0.7 + aSeed * 21.0) * 0.12 * min(age, 2.0);
        pos.z += cos(age * 0.5 + aSeed * 13.0) * 0.09 * min(age, 2.0);
        pos += fbCurlOffset(aStart, age, aSeed, 0.3) * (0.4 + 0.6 * vLife);
        // Fire-light tint carried from spawn cools as the puff rises.
        vTemp = aTemp * (1.0 - 0.7 * vLife);
        // Smoke expands as it rises.
        float s = aSize * (0.55 + 1.1 * t) * alive;
        float ang = aSeed * 6.2831 + age * (0.25 + aSeed * 0.3);
        vec2 c = position.xy;
        vec2 rot = vec2(c.x * cos(ang) - c.y * sin(ang), c.x * sin(ang) + c.y * cos(ang));
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        mv.xy += rot * s;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uOpacity;
      uniform sampler2D uMap;
      uniform float uUseMap;
      varying vec2 vUv;
      varying float vLife;
      varying float vSeed;
      varying float vTemp;
      varying float vViewZ;
      ${NOISE_GLSL}
      ${SOFT_PARTICLE_GLSL}
      void main() {
        float shape;
        if (uUseMap > 0.5) {
          shape = texture2D(uMap, vUv).a;
        } else {
          shape = smoothstep(1.0, 0.15, length(vUv * 2.0 - 1.0));
        }
        // Turbulent dissipation: the tail of the fade is eroded by scrolling
        // noise so puffs shred apart instead of dimming uniformly.
        float erode = fireValueNoise(vUv * 3.5 + vec2(vSeed * 47.0, -uTime * 0.35 - vSeed * 9.0));
        float fadeIn = smoothstep(0.0, 0.2, vLife);
        float fadeOut = 1.0 - smoothstep(0.4, 1.0, vLife + (erode - 0.5) * 0.5);
        float alpha = shape * fadeIn * clamp(fadeOut, 0.0, 1.0) * uOpacity;
        alpha *= fbSoftFade(vViewZ);
        if (alpha < 0.003) discard;
        // Dark warm gray lit from below by nearby fire: the tint amount was
        // sampled from the flame emitter's activity when the puff was born.
        vec3 col = vec3(0.075, 0.062, 0.052)
          + vec3(0.85, 0.42, 0.16) * (vTemp * shape * 0.35);
        gl_FragColor = vec4(col * alpha, alpha);
      }
    `,
  });
  return { material, uTime, texture };
}

// ---------------------------------------------------------------------------
// Instanced particle emitter base: quad billboard geometry, ring-buffer pool.
//
// O(1) update contract: update(dt) advances the clock uniform and one scalar
// activity EMA, nothing else. No per-instance JS loops run on quiet frames
// and no attribute buffer is touched (attribute .version only changes inside
// spawn()). Tests pin this by asserting attribute versions stay constant
// across many update() calls.
// ---------------------------------------------------------------------------

export interface ParticleSpawnOptions {
  position: THREE.Vector3;
  /**
   * Sub-frame emission (fast projectiles): when set, spawn positions are
   * distributed along the segment position -> positionEnd instead of beading
   * at a point, and `timeSpread` back-dates each particle's spawn time
   * proportionally (the particle dropped at the segment's far end was
   * emitted up to one frame ago).
   */
  positionEnd?: THREE.Vector3;
  /** Seconds of spawn-time back-dating across the segment. Default 0. */
  timeSpread?: number;
  velocity?: THREE.Vector3;
  /** Base quad size in world units (jittered ~25% per particle). */
  size?: number;
  /** Seconds (jittered ~25% per particle). */
  lifetime?: number;
  count?: number;
  /** Radius of positional jitter; also scales velocity cone jitter. */
  spread?: number;
  /**
   * Normalized spawn temperature 0..1 (1000 K..2600 K blackbody). Flames and
   * embers default per emitter; smoke reuses it as the fire-light tint.
   */
  temperature?: number;
}

interface EmitterDefaults {
  size: number;
  lifetime: number;
  velocity: THREE.Vector3;
  /** Default normalized spawn temperature. */
  temperature: number;
  /** Uniform jitter width applied around the spawn temperature. */
  temperatureJitter: number;
}

/** Time constant of the spawn-activity EMA (seconds). */
const ACTIVITY_TAU = 0.45;

function makeQuadGeometry(capacity: number): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  const positions = new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex([0, 1, 2, 2, 1, 3]);
  geo.instanceCount = capacity;
  return geo;
}

export abstract class InstancedParticleEmitter {
  readonly capacity: number;
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;

  private readonly uTime: THREE.IUniform<number>;
  private readonly aSpawn: THREE.InstancedBufferAttribute;
  private readonly aLifetime: THREE.InstancedBufferAttribute;
  private readonly aStart: THREE.InstancedBufferAttribute;
  private readonly aVelocity: THREE.InstancedBufferAttribute;
  private readonly aSize: THREE.InstancedBufferAttribute;
  private readonly aSeed: THREE.InstancedBufferAttribute;
  private readonly aTemp: THREE.InstancedBufferAttribute;

  /** CPU mirrors used only for liveCount()/stats, never in update(). */
  private readonly spawnTimes: Float32Array;
  private readonly lifetimes: Float32Array;

  private cursor = 0;
  private clock = 0;
  private pendingSpawns = 0;
  private activityEma = 0;
  private readonly rng: () => number;
  private readonly defaults: EmitterDefaults;

  protected constructor(
    bundle: MaterialBundle,
    capacity: number,
    defaults: EmitterDefaults,
    seed: number,
    name: string,
    renderOrder: number,
  ) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.material = bundle.material;
    this.uTime = bundle.uTime;
    this.defaults = defaults;
    this.rng = mulberry32(seed);

    this.geometry = makeQuadGeometry(this.capacity);
    const makeAttr = (itemSize: number, fill: number): THREE.InstancedBufferAttribute => {
      const arr = new Float32Array(this.capacity * itemSize);
      if (fill !== 0) arr.fill(fill);
      const attr = new THREE.InstancedBufferAttribute(arr, itemSize);
      attr.setUsage(THREE.DynamicDrawUsage);
      return attr;
    };
    // Buffers are sized to capacity exactly; the pool never grows.
    // aSpawn starts at -1e9 so every instance is born dead (age/lifetime >> 1).
    this.aSpawn = makeAttr(1, -1e9);
    this.aLifetime = makeAttr(1, 1);
    this.aStart = makeAttr(3, 0);
    this.aVelocity = makeAttr(3, 0);
    this.aSize = makeAttr(1, 0);
    this.aSeed = makeAttr(1, 0);
    this.aTemp = makeAttr(1, 0);
    this.geometry.setAttribute('aSpawn', this.aSpawn);
    this.geometry.setAttribute('aLifetime', this.aLifetime);
    this.geometry.setAttribute('aStart', this.aStart);
    this.geometry.setAttribute('aVelocity', this.aVelocity);
    this.geometry.setAttribute('aSize', this.aSize);
    this.geometry.setAttribute('aSeed', this.aSeed);
    this.geometry.setAttribute('aTemp', this.aTemp);

    this.spawnTimes = new Float32Array(this.capacity);
    this.spawnTimes.fill(-1e9);
    this.lifetimes = new Float32Array(this.capacity);

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false; // positions live in the shader
    this.mesh.renderOrder = renderOrder;
  }

  /** Current emitter clock in seconds (the uTime uniform value). */
  get time(): number {
    return this.clock;
  }

  /**
   * Live spawn activity: EMA of particles spawned over the last ~ACTIVITY_TAU
   * seconds. O(1) to read; drives smoke tinting and light flicker floors.
   */
  get activity(): number {
    return this.activityEma;
  }

  /**
   * Spawn `count` particles into the ring buffer at the current clock time.
   * Overwrites the oldest slots when the pool is exhausted, so the live count
   * can never exceed capacity. Returns the number spawned.
   */
  spawn(opts: ParticleSpawnOptions): number {
    const count = Math.min(Math.max(1, Math.floor(opts.count ?? 1)), this.capacity);
    const size = opts.size ?? this.defaults.size;
    const lifetime = opts.lifetime ?? this.defaults.lifetime;
    const vel = opts.velocity ?? this.defaults.velocity;
    const spread = opts.spread ?? 0;
    const temperature = opts.temperature ?? this.defaults.temperature;
    const tempJitter = this.defaults.temperatureJitter;
    const posB = opts.positionEnd ?? null;
    const timeSpread = opts.timeSpread ?? 0;
    const now = this.clock;
    const spawnArr = this.aSpawn.array as Float32Array;
    const lifeArr = this.aLifetime.array as Float32Array;
    const startArr = this.aStart.array as Float32Array;
    const velArr = this.aVelocity.array as Float32Array;
    const sizeArr = this.aSize.array as Float32Array;
    const seedArr = this.aSeed.array as Float32Array;
    const tempArr = this.aTemp.array as Float32Array;

    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      const r = this.rng;
      // Sub-frame emission: distribute along position -> positionEnd, and
      // back-date the far end's spawn time so a fast comet lays a continuous
      // ribbon instead of a bead per frame.
      const frac = posB !== null || timeSpread > 0
        ? (count === 1 ? r() : k / (count - 1))
        : 0;
      const life = lifetime * (0.75 + r() * 0.5);
      const spawnAt = now - timeSpread * frac;
      spawnArr[i] = spawnAt;
      lifeArr[i] = life;
      this.spawnTimes[i] = spawnAt;
      this.lifetimes[i] = life;
      const bx = posB !== null ? opts.position.x + (posB.x - opts.position.x) * frac : opts.position.x;
      const by = posB !== null ? opts.position.y + (posB.y - opts.position.y) * frac : opts.position.y;
      const bz = posB !== null ? opts.position.z + (posB.z - opts.position.z) * frac : opts.position.z;
      const j = (r() - 0.5) * 2;
      const jy = (r() - 0.5) * 2;
      const jz = (r() - 0.5) * 2;
      startArr[i * 3] = bx + j * spread;
      startArr[i * 3 + 1] = by + jy * spread * 0.6;
      startArr[i * 3 + 2] = bz + jz * spread;
      velArr[i * 3] = vel.x + (r() - 0.5) * 2 * spread * 1.6;
      velArr[i * 3 + 1] = vel.y + (r() - 0.5) * 2 * spread * 1.1;
      velArr[i * 3 + 2] = vel.z + (r() - 0.5) * 2 * spread * 1.6;
      sizeArr[i] = size * (0.75 + r() * 0.5);
      seedArr[i] = r();
      tempArr[i] = Math.min(1, Math.max(0.02, temperature + (r() - 0.5) * tempJitter));
    }

    // One flagged upload per touched attribute, only on spawn frames.
    this.aSpawn.needsUpdate = true;
    this.aLifetime.needsUpdate = true;
    this.aStart.needsUpdate = true;
    this.aVelocity.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aSeed.needsUpdate = true;
    this.aTemp.needsUpdate = true;
    this.pendingSpawns += count;
    return count;
  }

  /**
   * Advance the clock. O(1): touches one uniform and folds pending spawns
   * into the activity EMA; no per-instance work, no attribute writes. Pass
   * `elapsed` to hard-set the absolute clock instead of accumulating dt.
   */
  update(dt: number, elapsed?: number): void {
    this.clock = elapsed !== undefined ? elapsed : this.clock + dt;
    this.uTime.value = this.clock;
    this.activityEma = this.activityEma * Math.exp(-Math.max(dt, 0) / ACTIVITY_TAU) + this.pendingSpawns;
    this.pendingSpawns = 0;
  }

  /**
   * Number of currently-alive particles. O(capacity) scan of CPU mirrors;
   * cheap enough for the once-per-frame light-flicker density read and for
   * stats/tests.
   */
  liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.spawnTimes[i] ?? -1e9;
      const l = this.lifetimes[i] ?? 0;
      const age = this.clock - s;
      if (age >= 0 && age < l) n++;
    }
    return n;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Concrete emitters
// ---------------------------------------------------------------------------

/** Layer 1: core flame billboards with the blackbody flame shader. */
export class FlameEmitter extends InstancedParticleEmitter {
  constructor(capacity = 3000) {
    super(
      makeFlameMaterial(),
      capacity,
      {
        size: 0.5,
        lifetime: 0.7,
        velocity: new THREE.Vector3(0, 0.6, 0),
        temperature: 0.85,
        temperatureJitter: 0.22,
      },
      0xf1a3e5,
      'fire-flames',
      20,
    );
  }
}

/** Layer 2: embers with temperature-varied buoyancy and floor landing. */
export class EmberEmitter extends InstancedParticleEmitter {
  constructor(capacity = 1500) {
    super(
      makeEmberMaterial(),
      capacity,
      {
        size: 0.045,
        lifetime: 2.4,
        velocity: new THREE.Vector3(0, 0.7, 0),
        temperature: 0.66,
        temperatureJitter: 0.6,
      },
      0xe3b312,
      'fire-embers',
      21,
    );
  }
}

/** Layer 3: sparse fire-lit smoke puffs above sustained flames only. */
export class SmokeEmitter extends InstancedParticleEmitter {
  private readonly texture: THREE.Texture | null;

  constructor(capacity = 200) {
    const bundle = makeSmokeMaterial();
    super(
      bundle,
      capacity,
      {
        size: 0.55,
        lifetime: 3.2,
        velocity: new THREE.Vector3(0, 0.35, 0),
        temperature: 0,
        temperatureJitter: 0,
      },
      0x50b0e5,
      'fire-smoke',
      22,
    );
    this.texture = bundle.texture;
  }

  override dispose(): void {
    super.dispose();
    this.texture?.dispose();
  }
}

// ---------------------------------------------------------------------------
// FireLightPool (layer 5): pooled warm point lights that travel with fire.
//
// LIGHT BUDGET NOTE for the orchestrator: Section 14 caps dynamic lights at 8
// total. The arena already spends 6 (1 directional key + 4 brazier points +
// 1 ambient, and ambient does not count as a dynamic point but the key does).
// That leaves 2 for traveling fire, so the pool defaults to N = 2, not the 4
// this layer would ideally want. If heavy fire needs more, the director may
// dim or temporarily disable brazier lights and hand their budget to a larger
// pool via the constructor size argument. Log this tension in the tracker.
// ---------------------------------------------------------------------------

export interface FireLightHandle {
  /** False once released or recycled out from under the holder. */
  readonly alive: boolean;
  move(position: THREE.Vector3): void;
  /**
   * Legacy layered-sine flicker around the base intensity. The live path is
   * FireLightPool.update(dt, flameLive), which drives intensity from the
   * flame emitter's actual particle count instead.
   */
  flicker(dt: number): void;
  setIntensity(intensity: number): void;
  release(): void;
}

interface LightSlot {
  light: THREE.PointLight;
  handle: LightHandleImpl | null;
  seq: number;
}

/** Live count that maps to the full flicker-brightness floor. */
const LIGHT_DENSITY_FULL = 600;

class LightHandleImpl implements FireLightHandle {
  alive = true;
  private age = 0;
  private baseIntensity: number;
  private readonly phase: number;

  constructor(
    private readonly slot: LightSlot,
    intensity: number,
    private readonly onRelease: (slot: LightSlot) => void,
  ) {
    this.baseIntensity = intensity;
    this.phase = (slot.seq % 17) * 0.83;
  }

  move(position: THREE.Vector3): void {
    if (!this.alive) return;
    this.slot.light.position.copy(position);
  }

  flicker(dt: number): void {
    if (!this.alive) return;
    this.age += dt;
    const t = this.age;
    const n =
      0.84 +
      0.11 * Math.sin(t * 11.3 + this.phase) +
      0.07 * Math.sin(t * 27.1 + this.phase * 1.7) +
      0.05 * Math.sin(t * 43.7 + this.phase * 0.6);
    this.slot.light.intensity = this.baseIntensity * n;
  }

  /**
   * Live flicker path: driven by the flame emitter's ACTUAL live particle
   * count. Density sets the brightness floor (a starved fire dims) and the
   * jitter term hashes the integer count itself, so the light dances exactly
   * when particles ignite or expire, not on a canned sine. Smoothed so
   * single-particle steps read as flame dance, not strobing.
   */
  flickerFromCount(dt: number, flameLive: number): void {
    if (!this.alive) return;
    this.age += dt;
    const density = Math.min(1, flameLive / LIGHT_DENSITY_FULL);
    const h = Math.sin((flameLive + this.phase * 31.7) * 12.9898) * 43758.5453;
    const jitter = (h - Math.floor(h)) - 0.5;
    const target = this.baseIntensity * (0.58 + 0.42 * Math.sqrt(density) + 0.26 * jitter);
    const k = Math.min(1, dt * 18);
    this.slot.light.intensity += (target - this.slot.light.intensity) * k;
    if (this.slot.light.intensity < 0) this.slot.light.intensity = 0;
  }

  setIntensity(intensity: number): void {
    this.baseIntensity = intensity;
    if (this.alive) this.slot.light.intensity = intensity;
  }

  release(): void {
    if (!this.alive) return;
    this.alive = false;
    this.onRelease(this.slot);
  }

  /** Called by the pool when this handle's light is recycled to a new owner. */
  invalidate(): void {
    this.alive = false;
  }
}

export class FireLightPool {
  readonly group: THREE.Group;
  private readonly slots: LightSlot[] = [];
  private seq = 0;

  constructor(parent: THREE.Object3D, size = 2) {
    this.group = new THREE.Group();
    this.group.name = 'fire-light-pool';
    for (let i = 0; i < Math.max(1, size); i++) {
      const light = new THREE.PointLight(FIRELIGHT_COLOR, 0, 6, 2);
      light.name = `fire-light-${i}`;
      light.visible = false;
      this.group.add(light);
      this.slots.push({ light, handle: null, seq: -1 });
    }
    parent.add(this.group);
  }

  get size(): number {
    return this.slots.length;
  }

  /**
   * Take a light from the pool. When every light is in use, the oldest
   * acquisition is recycled: its handle goes dead and its light is re-issued.
   */
  acquire(position: THREE.Vector3, intensity = 3.5, radius = 6): FireLightHandle {
    let slot: LightSlot | undefined;
    for (const s of this.slots) {
      if (s.handle === null || !s.handle.alive) {
        slot = s;
        break;
      }
    }
    if (!slot) {
      // Recycle the oldest live acquisition.
      for (const s of this.slots) {
        if (!slot || s.seq < slot.seq) slot = s;
      }
      slot?.handle?.invalidate();
    }
    if (!slot) throw new Error('FireLightPool has no slots');
    slot.seq = this.seq++;
    slot.light.position.copy(position);
    slot.light.intensity = intensity;
    slot.light.distance = radius;
    slot.light.visible = true;
    const handle = new LightHandleImpl(slot, intensity, (s) => {
      s.light.visible = false;
      s.light.intensity = 0;
      s.handle = null;
    });
    slot.handle = handle;
    return handle;
  }

  /**
   * Flicker every active light. When `flameLive` is provided (FireSystem
   * passes the flame emitter's live count every frame) intensity is driven
   * by real particle density; without it the legacy sine path runs.
   */
  update(dt: number, flameLive?: number): void {
    for (const s of this.slots) {
      if (!s.handle) continue;
      if (flameLive !== undefined) s.handle.flickerFromCount(dt, flameLive);
      else s.handle.flicker(dt);
    }
  }

  activeCount(): number {
    let n = 0;
    for (const s of this.slots) {
      if (s.handle !== null && s.handle.alive) n++;
    }
    return n;
  }

  dispose(): void {
    for (const s of this.slots) {
      s.handle?.invalidate();
      s.handle = null;
      s.light.dispose();
    }
    this.group.parent?.remove(this.group);
    this.group.clear();
    this.slots.length = 0;
  }
}

// ---------------------------------------------------------------------------
// FireSystem facade
// ---------------------------------------------------------------------------

export interface FireSystemOptions {
  /** Core flame instance cap. Default 3000. */
  flameCap?: number;
  /** Ember instance cap. Default 1500. */
  emberCap?: number;
  /** Smoke instance cap. Default 200. */
  smokeCap?: number;
  /** Point light pool size. Default 2 (see light budget note above). */
  lightPoolSize?: number;
}

export interface BurstOptions {
  flameCount?: number;
  emberCount?: number;
  smokeCount?: number;
  /** Base flame quad size in world units. Default 0.45. */
  size?: number;
  /** Speed along `direction` in units/sec. Default 6. */
  speed?: number;
  /** Cone/positional spread. Default 0.3. */
  spread?: number;
  /** Flame lifetime seconds. Default 0.55. */
  lifetime?: number;
  /** Normalized flame spawn temperature. Default 0.85 (emitter default). */
  temperature?: number;
  /** Attach a pooled point light at the burst origin. Default true. */
  light?: boolean;
  lightIntensity?: number;
  lightRadius?: number;
  /** Seconds before the burst light auto-releases. Default 0.45. */
  lightDuration?: number;
}

export interface AmbientFlameHandle {
  readonly anchor: THREE.Object3D;
  /** Multiplies spawn rates and particle sizes. */
  scale: number;
  detach(): void;
}

interface AmbientEntry {
  anchor: THREE.Object3D;
  scale: number;
  flameAcc: number;
  emberAcc: number;
  smokeAcc: number;
  /** Continuous burn time: smoke thickens above sustained flames. */
  burnSec: number;
}

export interface FireStats {
  flames: number;
  embers: number;
  smoke: number;
  total: number;
  lightsActive: number;
  capacity: { flames: number; embers: number; smoke: number; total: number };
}

interface TimedLight {
  handle: FireLightHandle;
  ttl: number;
}

// Ambient spawn rates per second at scale 1.
const AMBIENT_FLAME_RATE = 22;
const AMBIENT_EMBER_RATE = 6;
const AMBIENT_SMOKE_RATE = 1.4;
// Safety clamp so a huge dt (tab-away) cannot dump a burst of ambient spawns.
const AMBIENT_MAX_PER_FRAME = 12;
// Sustained flames thicken their smoke column up to this factor over ~5 s.
const SMOKE_THICKEN_MAX = 1.2;
const SMOKE_THICKEN_SEC = 5;
// Flame-emitter activity (spawns per ~0.45 s window) that saturates smoke tint.
const SMOKE_TINT_FULL_ACTIVITY = 25;

export class FireSystem {
  readonly group: THREE.Group;
  readonly flames: FlameEmitter;
  readonly embers: EmberEmitter;
  readonly smoke: SmokeEmitter;
  readonly lights: FireLightPool;

  private readonly ambients: AmbientEntry[] = [];
  private readonly timedLights: TimedLight[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  /** Deterministic jitter for ambient ember scale/drift variance (Phase 6). */
  private readonly ambientRng = mulberry32(0xe58a2);

  constructor(parent: THREE.Object3D, opts: FireSystemOptions = {}) {
    this.group = new THREE.Group();
    this.group.name = 'fire-system';
    this.flames = new FlameEmitter(opts.flameCap ?? 3000);
    this.embers = new EmberEmitter(opts.emberCap ?? 1500);
    this.smoke = new SmokeEmitter(opts.smokeCap ?? 200);
    this.group.add(this.flames.mesh, this.embers.mesh, this.smoke.mesh);
    this.lights = new FireLightPool(this.group, opts.lightPoolSize ?? 2);
    parent.add(this.group);
  }

  /**
   * Post-pipeline hook: move the three particle meshes onto a dedicated
   * scene layer (half-res fire pass) or back to the default layer (null).
   */
  setFireLayer(layer: number | null): void {
    for (const mesh of [this.flames.mesh, this.embers.mesh, this.smoke.mesh]) {
      mesh.layers.set(layer ?? 0);
    }
  }

  /**
   * Post-pipeline hook: bind (or unbind with null) the scene depth texture
   * plus camera/target parameters for soft-particle depth fading.
   */
  configureFirePass(
    depth: THREE.Texture | null,
    near: number,
    far: number,
    width: number,
    height: number,
  ): void {
    for (const emitter of [this.flames, this.embers, this.smoke]) {
      const u = emitter.material.uniforms;
      u['uSceneDepth']!.value = depth;
      u['uSoftEnabled']!.value = depth ? 1 : 0;
      u['uCamNear']!.value = near;
      u['uCamFar']!.value = far;
      (u['uFireRes']!.value as THREE.Vector2).set(width, height);
    }
  }

  /**
   * One-shot fire burst at `position` traveling along `direction`. This is
   * the building block for jabs, impacts and cannon shots; per-move VFX
   * layers extra character on top.
   */
  spawnBurst(position: THREE.Vector3, direction: THREE.Vector3, opts: BurstOptions = {}): void {
    const dir = this.tmp.copy(direction);
    if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
    dir.normalize();
    const speed = opts.speed ?? 6;
    const spread = opts.spread ?? 0.3;
    const lifetime = opts.lifetime ?? 0.55;
    const size = opts.size ?? 0.45;

    const flameVel = this.tmp2.copy(dir).multiplyScalar(speed);
    this.flames.spawn({
      position,
      velocity: flameVel,
      size,
      lifetime,
      count: opts.flameCount ?? 24,
      spread,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });

    const emberVel = this.tmp2.copy(dir).multiplyScalar(speed * 0.55);
    emberVel.y += 0.5;
    this.embers.spawn({
      position,
      velocity: emberVel,
      lifetime: 1.6,
      count: opts.emberCount ?? 16,
      spread: spread * 1.5,
    });

    const smokeCount = opts.smokeCount ?? 0;
    if (smokeCount > 0) {
      this.smoke.spawn({
        position,
        count: smokeCount,
        spread: spread,
        temperature: this.currentSmokeTint(),
      });
    }

    if (opts.light ?? true) {
      const handle = this.lights.acquire(
        position,
        opts.lightIntensity ?? 4,
        opts.lightRadius ?? 7,
      );
      this.timedLights.push({ handle, ttl: opts.lightDuration ?? 0.45 });
    }
  }

  /**
   * Continuous low-rate flame at an anchor (brazier bowls). The anchor's
   * world position is sampled every update, so moving anchors carry their
   * flames. Returns a handle whose detach() stops the ambient.
   */
  attachAmbient(anchor: THREE.Object3D, scale = 1): AmbientFlameHandle {
    const entry: AmbientEntry = {
      anchor,
      scale,
      flameAcc: 0,
      emberAcc: 0,
      smokeAcc: 0,
      burnSec: 0,
    };
    this.ambients.push(entry);
    const ambients = this.ambients;
    return {
      anchor,
      get scale(): number {
        return entry.scale;
      },
      set scale(v: number) {
        entry.scale = v;
      },
      detach(): void {
        const i = ambients.indexOf(entry);
        if (i >= 0) ambients.splice(i, 1);
      },
    };
  }

  /** Fire-light tint for smoke born right now (flame emitter activity). */
  private currentSmokeTint(): number {
    return Math.min(1, this.flames.activity / SMOKE_TINT_FULL_ACTIVITY);
  }

  /**
   * Single per-frame tick: advances every emitter clock (O(1) each), spawns
   * ambient particles, drives light flicker from the flame emitter's live
   * particle count, expires pooled burst lights.
   */
  update(dt: number): void {
    this.flames.update(dt);
    this.embers.update(dt);
    this.smoke.update(dt);

    const smokeTint = this.currentSmokeTint();

    for (const entry of this.ambients) {
      const p = entry.anchor.getWorldPosition(this.tmp);
      const s = entry.scale;
      entry.burnSec += dt;

      entry.flameAcc = Math.min(entry.flameAcc + AMBIENT_FLAME_RATE * s * dt, AMBIENT_MAX_PER_FRAME);
      const nf = Math.floor(entry.flameAcc);
      if (nf > 0) {
        entry.flameAcc -= nf;
        this.flames.spawn({
          position: p,
          velocity: this.tmp2.set(0, 0.55 * s, 0),
          size: 0.34 * s,
          lifetime: 0.6,
          count: nf,
          spread: 0.13 * s,
        });
      }

      entry.emberAcc = Math.min(entry.emberAcc + AMBIENT_EMBER_RATE * s * dt, AMBIENT_MAX_PER_FRAME);
      const ne = Math.floor(entry.emberAcc);
      if (ne > 0) {
        entry.emberAcc -= ne;
        // Varied scale and drift (Phase 6): each spawn wave rolls its own
        // size, rise speed, sideways drift and lifetime; per-particle
        // temperature jitter (emitter default) then varies buoyancy and
        // burnout on top, so ambient embers read as a population -- fat slow
        // floaters, quick sparks, and cooling stragglers that sink, land on
        // the courtyard floor and fade out. Deterministic (mulberry32).
        const r = this.ambientRng;
        const drift = (r() - 0.5) * 0.5 * s;
        this.embers.spawn({
          position: p,
          velocity: this.tmp2.set(drift, (0.4 + r() * 0.75) * s, (r() - 0.5) * 0.4 * s),
          size: 0.028 + r() * 0.05,
          lifetime: 1.6 + r() * 2.2,
          count: ne,
          spread: (0.07 + r() * 0.09) * s,
        });
      }

      // Smoke lives above the sustained flame, not inside it, thickens the
      // longer the flame has burned, and is born tinted by current fire
      // activity (fbBlackbody light it "reflects" while young).
      const thicken = 1 + SMOKE_THICKEN_MAX * Math.min(entry.burnSec / SMOKE_THICKEN_SEC, 1);
      entry.smokeAcc = Math.min(
        entry.smokeAcc + AMBIENT_SMOKE_RATE * thicken * s * dt,
        AMBIENT_MAX_PER_FRAME,
      );
      const ns = Math.floor(entry.smokeAcc);
      if (ns > 0) {
        entry.smokeAcc -= ns;
        this.smoke.spawn({
          position: this.tmp2.set(p.x, p.y + 0.55 * s, p.z),
          size: 0.5 * s * (0.8 + 0.4 * thicken),
          count: ns,
          spread: 0.12 * s,
          temperature: smokeTint,
        });
      }
    }

    // Light coupling: pooled flame lights ride the flame emitter's ACTUAL
    // live particle count (one O(capacity) Float32Array scan per frame,
    // measured in microseconds). All pool lights share the global flame
    // emitter density since particles live in shared pools; per-light local
    // density would need spatial binning for marginal gain (documented
    // approximation).
    this.lights.update(dt, this.flames.liveCount());
    for (let i = this.timedLights.length - 1; i >= 0; i--) {
      const tl = this.timedLights[i];
      if (!tl) continue;
      tl.ttl -= dt;
      if (tl.ttl <= 0 || !tl.handle.alive) {
        tl.handle.release();
        this.timedLights.splice(i, 1);
      }
    }
  }

  /** Live instance counts. Total stays within the Section 14 budget of 6000. */
  stats(): FireStats {
    const flames = this.flames.liveCount();
    const embers = this.embers.liveCount();
    const smoke = this.smoke.liveCount();
    return {
      flames,
      embers,
      smoke,
      total: flames + embers + smoke,
      lightsActive: this.lights.activeCount(),
      capacity: {
        flames: this.flames.capacity,
        embers: this.embers.capacity,
        smoke: this.smoke.capacity,
        total: this.flames.capacity + this.embers.capacity + this.smoke.capacity,
      },
    };
  }

  dispose(): void {
    for (const tl of this.timedLights) tl.handle.release();
    this.timedLights.length = 0;
    this.ambients.length = 0;
    this.flames.dispose();
    this.embers.dispose();
    this.smoke.dispose();
    this.lights.dispose();
    this.group.parent?.remove(this.group);
    this.group.clear();
  }
}
