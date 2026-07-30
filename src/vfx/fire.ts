// Core fire VFX system (Section 10, layers 1, 2, 5, plus cheap smoke layer 3).
// Everything is GPU-instanced: per-particle motion is computed entirely in the
// vertex shader from spawn-time attributes (position = start + velocity * age
// + 0.5 * buoyancy * age^2), so update() only advances a clock uniform. The
// CPU touches attribute buffers exclusively when new particles spawn.
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
// Palette (Section 9: warm only). Fire ramp black -> deep red -> orange ->
// yellow-white core.
// ---------------------------------------------------------------------------

export const FIRELIGHT_COLOR = 0xff8a3c;

// Ramp stops as normalized RGB, embedded in the flame fragment shader:
// #6b1f15 deep red, #e8551c orange, #ffd9a0 yellow-white.

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
  varying vec2 vUv;
  varying float vLife;
  varying float vSeed;
`;

// ---------------------------------------------------------------------------
// Flame material (layer 1): noise-distorted radial gradient, NOT a flat
// sprite. Two octaves of value noise scroll upward over the particle's life
// and erode the radial falloff; the color ramp runs black -> deep red ->
// orange -> yellow-white at the core. Additive, no depth writes, soft alpha.
// ---------------------------------------------------------------------------

interface MaterialBundle {
  material: THREE.ShaderMaterial;
  uTime: THREE.IUniform<number>;
}

function makeFlameMaterial(): MaterialBundle {
  const uTime: THREE.IUniform<number> = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime,
      uBuoyancy: { value: 2.2 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${PARTICLE_ATTRIBUTES_GLSL}
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
        vec3 pos = aStart + aVelocity * age
          + vec3(0.0, 0.5 * uBuoyancy * age * age, 0.0);
        float grow = smoothstep(0.0, 0.12, t);
        float shrink = 1.0 - 0.85 * smoothstep(0.55, 1.0, t);
        float s = aSize * grow * shrink * alive;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        // Billboard: offset the quad corner in view space, slightly taller
        // than wide so flames read as licks, not discs.
        mv.xy += position.xy * vec2(s * 0.9, s * 1.25);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying float vLife;
      varying float vSeed;
      ${NOISE_GLSL}
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
        if (alpha < 0.004) discard;
        // Ramp: black -> deep red #6b1f15 -> orange #e8551c -> core #ffd9a0.
        vec3 col = mix(vec3(0.0), vec3(0.420, 0.122, 0.082), smoothstep(0.0, 0.22, heat));
        col = mix(col, vec3(0.910, 0.333, 0.110), smoothstep(0.22, 0.58, heat));
        col = mix(col, vec3(1.0, 0.851, 0.627), smoothstep(0.58, 0.92, heat));
        gl_FragColor = vec4(col * alpha, alpha);
      }
    `,
  });
  return { material, uTime };
}

// ---------------------------------------------------------------------------
// Ember material (layer 2): tiny bright quads, upward buoyancy plus a
// turbulence curl approximated with layered sin/cos on age and seed. Warm
// orange-gold, additive, twinkling.
// ---------------------------------------------------------------------------

function makeEmberMaterial(): MaterialBundle {
  const uTime: THREE.IUniform<number> = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime,
      uBuoyancy: { value: 0.32 },
      uCurl: { value: 1.0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${PARTICLE_ATTRIBUTES_GLSL}
      uniform float uCurl;
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
        // Curl turbulence: layered sin/cos keyed on age and seed. Ramps in
        // over the first moments so embers leave their source cleanly.
        float s1 = aSeed * 43.7;
        float ramp = min(age, 1.4);
        pos.x += uCurl * ramp * (sin(age * 2.9 + s1) * 0.30 + sin(age * 6.1 + s1 * 1.7) * 0.11);
        pos.z += uCurl * ramp * (cos(age * 2.3 + s1 * 0.6) * 0.30 + cos(age * 5.3 + s1 * 2.1) * 0.11);
        float shrink = 1.0 - 0.7 * smoothstep(0.6, 1.0, t);
        float s = aSize * smoothstep(0.0, 0.05, t) * shrink * alive;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        mv.xy += position.xy * s;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying float vLife;
      varying float vSeed;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float core = 1.0 - clamp(length(p), 0.0, 1.0);
        core = core * core;
        // Twinkle: embers pulse as they tumble through cooler air.
        float twinkle = 0.72 + 0.28 * sin(uTime * 19.0 + vSeed * 87.0);
        float alpha = core * twinkle * (1.0 - smoothstep(0.55, 1.0, vLife));
        if (alpha < 0.004) discard;
        // Warm orange -> gold-white center. No neon, no blue.
        vec3 col = mix(vec3(0.95, 0.38, 0.10), vec3(1.0, 0.84, 0.48), core * core);
        gl_FragColor = vec4(col * alpha, alpha);
      }
    `,
  });
  return { material, uTime };
}

// ---------------------------------------------------------------------------
// Smoke material (layer 3, cheap): sparse soft dark billboards, low opacity,
// normal blending, slow rise with lateral drift. Uses a runtime canvas radial
// gradient texture when a DOM exists, otherwise a pure-shader falloff so the
// module still loads headless.
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
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    vertexShader: /* glsl */ `
      ${PARTICLE_ATTRIBUTES_GLSL}
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
        // Slow lateral drift, unique per puff.
        pos.x += sin(age * 0.7 + aSeed * 21.0) * 0.12 * min(age, 2.0);
        pos.z += cos(age * 0.5 + aSeed * 13.0) * 0.09 * min(age, 2.0);
        // Smoke expands as it rises.
        float s = aSize * (0.55 + 1.1 * t) * alive;
        float ang = aSeed * 6.2831 + age * (0.25 + aSeed * 0.3);
        vec2 c = position.xy;
        vec2 rot = vec2(c.x * cos(ang) - c.y * sin(ang), c.x * sin(ang) + c.y * cos(ang));
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        mv.xy += rot * s;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform sampler2D uMap;
      uniform float uUseMap;
      varying vec2 vUv;
      varying float vLife;
      varying float vSeed;
      void main() {
        float shape;
        if (uUseMap > 0.5) {
          shape = texture2D(uMap, vUv).a;
        } else {
          shape = smoothstep(1.0, 0.15, length(vUv * 2.0 - 1.0));
        }
        // Fade in, fade out.
        float fade = smoothstep(0.0, 0.2, vLife) * (1.0 - smoothstep(0.55, 1.0, vLife));
        float alpha = shape * fade * uOpacity;
        if (alpha < 0.003) discard;
        // Dark warm gray, near the charcoal of the hall.
        vec3 col = vec3(0.075, 0.062, 0.052);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  return { material, uTime, texture };
}

// ---------------------------------------------------------------------------
// Instanced particle emitter base: quad billboard geometry, ring-buffer pool.
//
// O(1) update contract: update(dt) advances the clock uniform and nothing
// else. No per-instance JS loops run on quiet frames and no attribute buffer
// is touched (attribute .version only changes inside spawn()). Tests pin this
// by asserting attribute versions stay constant across many update() calls.
// ---------------------------------------------------------------------------

export interface ParticleSpawnOptions {
  position: THREE.Vector3;
  velocity?: THREE.Vector3;
  /** Base quad size in world units (jittered ~25% per particle). */
  size?: number;
  /** Seconds (jittered ~25% per particle). */
  lifetime?: number;
  count?: number;
  /** Radius of positional jitter; also scales velocity cone jitter. */
  spread?: number;
}

interface EmitterDefaults {
  size: number;
  lifetime: number;
  velocity: THREE.Vector3;
}

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

  /** CPU mirrors used only for liveCount()/stats, never in update(). */
  private readonly spawnTimes: Float32Array;
  private readonly lifetimes: Float32Array;

  private cursor = 0;
  private clock = 0;
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
    this.geometry.setAttribute('aSpawn', this.aSpawn);
    this.geometry.setAttribute('aLifetime', this.aLifetime);
    this.geometry.setAttribute('aStart', this.aStart);
    this.geometry.setAttribute('aVelocity', this.aVelocity);
    this.geometry.setAttribute('aSize', this.aSize);
    this.geometry.setAttribute('aSeed', this.aSeed);

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
    const now = this.clock;
    const spawnArr = this.aSpawn.array as Float32Array;
    const lifeArr = this.aLifetime.array as Float32Array;
    const startArr = this.aStart.array as Float32Array;
    const velArr = this.aVelocity.array as Float32Array;
    const sizeArr = this.aSize.array as Float32Array;
    const seedArr = this.aSeed.array as Float32Array;

    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      const r = this.rng;
      const life = lifetime * (0.75 + r() * 0.5);
      spawnArr[i] = now;
      lifeArr[i] = life;
      this.spawnTimes[i] = now;
      this.lifetimes[i] = life;
      const j = (r() - 0.5) * 2;
      const jy = (r() - 0.5) * 2;
      const jz = (r() - 0.5) * 2;
      startArr[i * 3] = opts.position.x + j * spread;
      startArr[i * 3 + 1] = opts.position.y + jy * spread * 0.6;
      startArr[i * 3 + 2] = opts.position.z + jz * spread;
      velArr[i * 3] = vel.x + (r() - 0.5) * 2 * spread * 1.6;
      velArr[i * 3 + 1] = vel.y + (r() - 0.5) * 2 * spread * 1.1;
      velArr[i * 3 + 2] = vel.z + (r() - 0.5) * 2 * spread * 1.6;
      sizeArr[i] = size * (0.75 + r() * 0.5);
      seedArr[i] = r();
    }

    // One flagged upload per touched attribute, only on spawn frames.
    this.aSpawn.needsUpdate = true;
    this.aLifetime.needsUpdate = true;
    this.aStart.needsUpdate = true;
    this.aVelocity.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aSeed.needsUpdate = true;
    return count;
  }

  /**
   * Advance the clock. O(1): touches one uniform, no per-instance work, no
   * attribute writes. Pass `elapsed` to hard-set the absolute clock instead
   * of accumulating dt.
   */
  update(dt: number, elapsed?: number): void {
    this.clock = elapsed !== undefined ? elapsed : this.clock + dt;
    this.uTime.value = this.clock;
  }

  /**
   * Number of currently-alive particles. O(capacity) scan of CPU mirrors;
   * intended for stats/tests, not per-frame gameplay logic.
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

/** Layer 1: core flame billboards with the procedural flame shader. */
export class FlameEmitter extends InstancedParticleEmitter {
  constructor(capacity = 3000) {
    super(
      makeFlameMaterial(),
      capacity,
      { size: 0.5, lifetime: 0.7, velocity: new THREE.Vector3(0, 0.6, 0) },
      0xf1a3e5,
      'fire-flames',
      20,
    );
  }
}

/** Layer 2: tiny bright embers with buoyancy and sin/cos curl turbulence. */
export class EmberEmitter extends InstancedParticleEmitter {
  constructor(capacity = 1500) {
    super(
      makeEmberMaterial(),
      capacity,
      { size: 0.045, lifetime: 2.4, velocity: new THREE.Vector3(0, 0.7, 0) },
      0xe3b312,
      'fire-embers',
      21,
    );
  }
}

/** Layer 3: sparse dark smoke puffs above sustained flames only. */
export class SmokeEmitter extends InstancedParticleEmitter {
  private readonly texture: THREE.Texture | null;

  constructor(capacity = 200) {
    const bundle = makeSmokeMaterial();
    super(
      bundle,
      capacity,
      { size: 0.55, lifetime: 3.2, velocity: new THREE.Vector3(0, 0.35, 0) },
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
  /** Layered-sine flicker around the base intensity. Call once per frame. */
  flicker(dt: number): void;
  setIntensity(intensity: number): void;
  release(): void;
}

interface LightSlot {
  light: THREE.PointLight;
  handle: LightHandleImpl | null;
  seq: number;
}

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

  /** Flicker every active light. */
  update(dt: number): void {
    for (const s of this.slots) {
      s.handle?.flicker(dt);
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

  /**
   * Single per-frame tick: advances every emitter clock (O(1) each), spawns
   * ambient particles, flickers and expires pooled lights.
   */
  update(dt: number): void {
    this.flames.update(dt);
    this.embers.update(dt);
    this.smoke.update(dt);

    for (const entry of this.ambients) {
      const p = entry.anchor.getWorldPosition(this.tmp);
      const s = entry.scale;

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
        this.embers.spawn({
          position: p,
          velocity: this.tmp2.set(0, 0.7 * s, 0),
          lifetime: 2.4,
          count: ne,
          spread: 0.1 * s,
        });
      }

      // Smoke lives above the sustained flame, not inside it.
      entry.smokeAcc = Math.min(entry.smokeAcc + AMBIENT_SMOKE_RATE * s * dt, AMBIENT_MAX_PER_FRAME);
      const ns = Math.floor(entry.smokeAcc);
      if (ns > 0) {
        entry.smokeAcc -= ns;
        this.smoke.spawn({
          position: this.tmp2.set(p.x, p.y + 0.55 * s, p.z),
          size: 0.5 * s,
          count: ns,
          spread: 0.12 * s,
        });
      }
    }

    this.lights.update(dt);
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
