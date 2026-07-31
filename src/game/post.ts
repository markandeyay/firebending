/**
 * Post-processing chain (Round 3 Phase 6, fire rebuild Final P2): the layers
 * that make the low-poly courtyard read photographic instead of flat-rendered.
 *
 *   FireScenePass (scene -> full-res HDR + depth, fire particles -> HALF-RES
 *   target, depth-aware upsample + heat-shimmer composite)
 *     -> UnrealBloomPass -> grade ShaderPass (edge chromatic aberration +
 *        tonemap + LUT-style tone curve + grain + vignette)
 *
 * - HALF-RES FIRE (perf mandate): additive fire is fill-rate bound on the
 *   Intel iGPU target; rendering the three particle meshes into a half-res
 *   HalfFloat target quarters that fill cost. The composite upsamples with a
 *   4-tap joint-bilateral filter (bilinear taps weighted by scene-depth
 *   similarity) so flame edges do not bleed across nearer silhouettes.
 *   When no FireSystem is passed the chain falls back to a plain RenderPass
 *   (debug harnesses keep working unchanged).
 * - SOFT PARTICLES: the scene pass renders into a target with a DepthTexture;
 *   FireScenePass binds it into the fire materials every frame
 *   (FireSystem.configureFirePass) so particles depth-fade against geometry.
 * - HEAT SHIMMER: the composite pass refracts the SCENE sample by animated
 *   value noise masked by the fire target's luminance sampled slightly below
 *   the pixel (heat column rises above flames). One extra texture sample per
 *   pixel plus two noise evaluations; measured within budget.
 *
 * - BLOOM with a HIGH threshold: the composer's render target is HalfFloat
 *   LINEAR HDR (tone mapping is deferred to the grade pass), so only
 *   genuinely hot pixels -- emissive coals, flame particles, lantern cores --
 *   exceed the 0.85 luminance threshold. Banners, gold trim and lit timber
 *   sit far below it and stay crisp (verified against the station shots).
 * - The grade pass applies the ACESFilmic tone map + sRGB conversion that
 *   configureRenderer authored (render-to-target skips both; a separate
 *   OutputPass cost a full extra HalfFloat blit -- ~0.7 ms on the Intel iGPU
 *   target -- so tone mapping, film grain (animated, luminance-centered,
 *   barely visible at 1080p) and a soft warm-black vignette share one pass).
 *
 * DEPTH OF FIELD: deliberately NOT shipped. BokehPass was measured in the
 * perf gate scene at 1280x720 on the real GPU (Intel iGPU, ANGLE/D3D11):
 * median frame 49.7 ms vs 16.8 ms without it -- the MeshDepthMaterial
 * prepass re-renders the entire scene and the bokeh shader samples a
 * full-res disc per pixel. Nowhere near recoverable by tuning. Section 2
 * rule 5 beats the wish list: the chain ships bloom + grain + vignette
 * only. POST_DOF stays false as the documented decision point.
 *
 * Every consumer that renders the arena (ArenaScreen, the perf gate) goes
 * through createPostPipeline so the perf gate measures the SAME pipeline the
 * player sees. Debug harnesses may keep rendering raw.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SAOPass } from 'three/addons/postprocessing/SAOPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { FIRE_PASS_LAYER, type FireSystem } from '../vfx/fire';

// --- Tunables (screenshot-tuned; see docs/screens/station-*.png) -----------

/**
 * Bloom luminance threshold in LINEAR pre-tonemap space. Lit parchment/gold
 * peaks around 0.4-0.6 linear; emissive coals and flame sprites run 1.5-3.
 * 0.85 keeps every non-fire surface out of the bloom buffer.
 */
export const POST_BLOOM_THRESHOLD = 0.85;
/** Bloom strength: firelight halo, not a glow filter. */
export const POST_BLOOM_STRENGTH = 0.32;
/** Bloom radius: tight; wide radii haze the whole frame. */
export const POST_BLOOM_RADIUS = 0.25;
/** Film grain amplitude in display space (+/- per channel). ~2.5/255. */
export const POST_GRAIN_AMOUNT = 0.028;
/** Vignette darkening at the far corners (0 = none, 1 = black corners). */
export const POST_VIGNETTE_STRENGTH = 0.32;
/** Vignette start radius in UV distance from center (soft ramp to corner). */
export const POST_VIGNETTE_START = 0.52;
/**
 * LUT-style tone curve in the grade pass (Final P3): slight warm lift-crush
 * in the shadows plus a highlight rolloff toward parchment. Display-space,
 * a handful of ALU ops, no LUT texture. Toggleable.
 */
export const POST_TONE_CURVE = true;
/** Tone curve strength (0..1 scales every term). */
export const POST_TONE_CURVE_AMOUNT = 1.0;
/**
 * Chromatic aberration at frame EDGES only (Final P3): radial R/B split,
 * quadratic falloff so the center stays untouched. Toggleable.
 */
export const POST_CHROMATIC_ABERRATION = true;
/** Max R/B split at the frame corners, in pixels. */
export const POST_CA_MAX_PX = 1.5;
/**
 * Depth of field: measured OVER budget on the target hardware (see module
 * header). Kept as a constant so the decision is explicit and revisitable.
 */
export const POST_DOF = false;
/**
 * Screen-space AO: deliberately OFF (Final P3 decision, measured on the
 * Intel iGPU target at 1280x720, both passes at HALF resolution):
 *   - SAOPass  (saoScale 6, kernel 24): median 16.6 ms / p95 17.9, but the
 *     depth-extent estimator saturated in the long-hall station-1 framing
 *     and rendered the entire frame black. Not tunable across all six
 *     station cameras; rejected on correctness.
 *   - SSAOPass (kernel 16, radius 0.5..1.1): median 16.7 ms / p95 18.0 and
 *     draw calls 152 -> 284 (the normal-override scene re-render), for an
 *     effect that is nearly invisible under this art direction (warm fog,
 *     deep authored shadows, flat-shaded low-poly). All headroom, no read.
 * Section 2 rule 5: cut. Grounding comes from baked-style contact
 * darkening instead (arena.ts: instanced blob AO discs under braziers /
 * columns / gate posts / bridge, wall-base + traffic darkening baked into
 * the floor overlays; enemies.ts: blob disc under each construct base).
 * The wiring below stays so the decision is one constant flip to revisit.
 */
export const POST_AO: 'sao' | 'ssao' | 'off' = 'off';
/**
 * Fire particle pass scale relative to the framebuffer (perf mandate:
 * half resolution, composited with a depth-aware upsample).
 */
export const FIRE_PASS_SCALE = 0.5;
/** Heat shimmer: max UV refraction amplitude at full fire mask. */
export const POST_SHIMMER_AMOUNT = 0.006;
/**
 * Bloom buffer scale relative to the framebuffer. Full-res bloom measured
 * 19.4 ms median on the Intel iGPU target (FAIL); bloom is a blur, so the
 * mip chain starts at quarter res and the result is visually identical for
 * fire-sized sources while fitting the budget.
 */
export const POST_BLOOM_SCALE = 0.25;

// --- Fire scene pass ---------------------------------------------------------
//
// Replaces the plain RenderPass when a FireSystem is provided:
//   1. scene WITHOUT fire particles -> full-res HalfFloat target + DepthTexture
//   2. fire particles only (FIRE_PASS_LAYER) -> HALF-RES HalfFloat target,
//      soft-fading against the scene depth (uniforms bound via
//      FireSystem.configureFirePass). Flames/embers accumulate additively
//      with zero alpha; smoke writes premultiplied alpha, so the target's
//      alpha channel is exactly the smoke occlusion term.
//   3. composite into the composer's readBuffer:
//        scene sampled through the heat-shimmer refraction, fire upsampled
//        with a 4-tap depth-similarity (joint bilateral) filter, combined as
//        scene * (1 - fire.a) + fire.rgb.

const FireCompositeShader = {
  name: 'FbFireCompositeShader',
  uniforms: {
    tScene: { value: null as THREE.Texture | null },
    tFire: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uFireTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
    uCamNear: { value: 0.1 },
    uCamFar: { value: 100 },
    uTime: { value: 0 },
    uShimmer: { value: POST_SHIMMER_AMOUNT },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tScene;
    uniform sampler2D tFire;
    uniform sampler2D tDepth;
    uniform vec2 uFireTexel;
    uniform float uCamNear;
    uniform float uCamFar;
    uniform float uTime;
    uniform float uShimmer;
    varying vec2 vUv;

    float fbLinearZ(float d) {
      float ndc = d * 2.0 - 1.0;
      return (2.0 * uCamNear * uCamFar) / (uCamFar + uCamNear - ndc * (uCamFar - uCamNear));
    }
    float fbHash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }
    float fbNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = fbHash(i);
      float b = fbHash(i + vec2(1.0, 0.0));
      float c = fbHash(i + vec2(0.0, 1.0));
      float d = fbHash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    void main() {
      // Heat shimmer: refract the SCENE only, masked by fire glow sampled a
      // touch below this pixel (hot air rises off the flame tops). The fire
      // sprites themselves stay steady; only what is seen through the heat
      // column wavers.
      float mask = dot(texture2D(tFire, vUv - vec2(0.0, 0.035)).rgb, vec3(0.30, 0.45, 0.25));
      mask = clamp(mask * 0.6, 0.0, 1.0);
      vec2 shim = vec2(
        fbNoise(vUv * vec2(90.0, 42.0) + vec2(0.0, -uTime * 2.4)),
        fbNoise(vUv * vec2(70.0, 36.0) + vec2(31.7, -uTime * 2.1))
      ) - 0.5;
      vec3 scene = texture2D(tScene, vUv + shim * (uShimmer * mask)).rgb;

      // Depth-aware upsample of the half-res fire target: 4 taps in a ring,
      // each weighted by scene-depth similarity to this pixel, so fire never
      // bleeds across the silhouette of nearer geometry (joint bilateral).
      float zRef = fbLinearZ(texture2D(tDepth, vUv).x);
      vec4 fire = vec4(0.0);
      float wSum = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = (i == 0) ? vec2(-0.5, -0.5)
               : (i == 1) ? vec2(0.5, -0.5)
               : (i == 2) ? vec2(-0.5, 0.5)
               : vec2(0.5, 0.5);
        vec2 uvT = vUv + o * uFireTexel;
        float z = fbLinearZ(texture2D(tDepth, uvT).x);
        float w = 1.0 / (0.02 + abs(z - zRef));
        fire += texture2D(tFire, uvT) * w;
        wSum += w;
      }
      fire /= max(wSum, 1e-5);

      gl_FragColor = vec4(scene * (1.0 - fire.a) + fire.rgb, 1.0);
    }
  `,
};

class FireScenePass extends Pass {
  private readonly rtScene: THREE.WebGLRenderTarget;
  private readonly rtFire: THREE.WebGLRenderTarget;
  private readonly quad: FullScreenQuad;
  private readonly compositeUniforms: typeof FireCompositeShader.uniforms;
  private readonly clearColor = new THREE.Color();
  time = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly fire: FireSystem,
    width: number,
    height: number,
  ) {
    super();
    this.needsSwap = false;
    const depthTexture = new THREE.DepthTexture(width, height);
    this.rtScene = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthTexture,
    });
    this.rtScene.texture.name = 'FireScenePass.scene';
    this.rtFire = new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(width * FIRE_PASS_SCALE)),
      Math.max(1, Math.round(height * FIRE_PASS_SCALE)),
      { type: THREE.HalfFloatType, depthBuffer: false },
    );
    this.rtFire.texture.name = 'FireScenePass.fire';
    const material = new THREE.ShaderMaterial({
      name: FireCompositeShader.name,
      uniforms: THREE.UniformsUtils.clone(FireCompositeShader.uniforms),
      vertexShader: FireCompositeShader.vertexShader,
      fragmentShader: FireCompositeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(material);
    this.compositeUniforms = material.uniforms as typeof FireCompositeShader.uniforms;
    // The particle meshes live on the fire layer while this pass owns them.
    fire.setFireLayer(FIRE_PASS_LAYER);
  }

  override setSize(width: number, height: number): void {
    this.rtScene.setSize(width, height);
    this.rtFire.setSize(
      Math.max(1, Math.round(width * FIRE_PASS_SCALE)),
      Math.max(1, Math.round(height * FIRE_PASS_SCALE)),
    );
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const camera = this.camera;
    const prevMask = camera.layers.mask;
    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(this.clearColor);
    const prevClearAlpha = renderer.getClearAlpha();

    // 1. Scene without fire particles, full res, with depth.
    camera.layers.disable(FIRE_PASS_LAYER);
    renderer.setRenderTarget(this.rtScene);
    renderer.clear();
    renderer.render(this.scene, camera);

    // 2. Fire particles only, half res, soft-fading against scene depth.
    this.fire.configureFirePass(
      this.rtScene.depthTexture,
      camera.near,
      camera.far,
      this.rtFire.width,
      this.rtFire.height,
    );
    camera.layers.mask = 1 << FIRE_PASS_LAYER;
    renderer.setRenderTarget(this.rtFire);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    // scene.background renders regardless of camera layers and would fill
    // the fire target with opaque backdrop (alpha 1 occludes the whole
    // composite); the fire-only pass must start from transparent black.
    const prevBackground = this.scene.background;
    this.scene.background = null;
    renderer.render(this.scene, camera);
    this.scene.background = prevBackground;
    renderer.setClearColor(this.clearColor, prevClearAlpha);
    camera.layers.mask = prevMask;

    // 3. Composite into the composer chain.
    const u = this.compositeUniforms;
    u.tScene.value = this.rtScene.texture;
    u.tFire.value = this.rtFire.texture;
    u.tDepth.value = this.rtScene.depthTexture;
    u.uFireTexel.value.set(1 / this.rtFire.width, 1 / this.rtFire.height);
    u.uCamNear.value = camera.near;
    u.uCamFar.value = camera.far;
    u.uTime.value = this.time;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.quad.render(renderer);
    renderer.setRenderTarget(prevTarget);
  }

  override dispose(): void {
    this.fire.setFireLayer(null);
    this.fire.configureFirePass(null, 0.1, 100, 1, 1);
    this.rtScene.depthTexture?.dispose();
    this.rtScene.dispose();
    this.rtFire.dispose();
    (this.quad.material as THREE.Material).dispose();
    this.quad.dispose();
  }
}

// --- Final grade pass: tone map + sRGB + film grain + vignette ---------------
//
// This pass terminates the linear-HDR chain: it performs the ACESFilmic tone
// mapping and linear->sRGB conversion that OutputPass would (matching
// configureRenderer's authored pipeline; the ACES fit and matrices are the
// same ones three's tonemapping chunk uses), then grades in display space.

const GradeShader = {
  name: 'FbGradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uExposure: { value: 1.0 },
    uGrain: { value: POST_GRAIN_AMOUNT },
    uVigStrength: { value: POST_VIGNETTE_STRENGTH },
    uVigStart: { value: POST_VIGNETTE_START },
    uToneCurve: { value: POST_TONE_CURVE ? POST_TONE_CURVE_AMOUNT : 0 },
    uCAPx: { value: POST_CHROMATIC_ABERRATION ? POST_CA_MAX_PX : 0 },
    uInvRes: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uExposure;
    uniform float uGrain;
    uniform float uVigStrength;
    uniform float uVigStart;
    uniform float uToneCurve;
    uniform float uCAPx;
    uniform vec2 uInvRes;
    varying vec2 vUv;

    // ACESFilmic fit (Stephen Hill), identical to three's tone mapping chunk.
    vec3 fbRRTOdtFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 acesFilmic(vec3 color) {
      const mat3 ACESInputMat = mat3(
        vec3(0.59719, 0.07600, 0.02840),
        vec3(0.35458, 0.90834, 0.13383),
        vec3(0.04823, 0.01566, 0.83777)
      );
      const mat3 ACESOutputMat = mat3(
        vec3(1.60475, -0.10208, -0.00327),
        vec3(-0.53108, 1.10813, -0.07276),
        vec3(-0.07367, -0.00605, 1.07602)
      );
      color *= uExposure / 0.6;
      color = ACESInputMat * color;
      color = fbRRTOdtFit(color);
      color = ACESOutputMat * color;
      return clamp(color, 0.0, 1.0);
    }
    vec3 linearToSrgb(vec3 c) {
      vec3 lo = c * 12.92;
      vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
      return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
    }

    // Cheap per-pixel hash; reseeded every frame by uTime so grain crawls.
    float grainHash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 443.8975);
      p3 += dot(p3, p3.yzx + 19.19);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);

      // Chromatic aberration (Final P3): radial R/B split, quadratic
      // falloff -- exactly zero at center, uCAPx pixels at the corners.
      // Sampled in linear HDR before the tone map so the fringes grade
      // with the frame instead of over it.
      vec2 rad = vUv - 0.5;
      float r2 = clamp(dot(rad, rad) * 2.0, 0.0, 1.0); // 1 at the corner
      if (uCAPx > 0.0 && r2 > 0.001) {
        vec2 caOff = rad * (uCAPx * r2 / max(length(rad), 1e-4)) * uInvRes;
        color.r = texture2D(tDiffuse, vUv + caOff).r;
        color.b = texture2D(tDiffuse, vUv - caOff).b;
      }

      color.rgb = linearToSrgb(acesFilmic(color.rgb));

      // LUT-style tone curve (Final P3), display space: gentle S contrast,
      // warm lift-crush in the shadows (deep tones drift ember-warm, never
      // gray), highlight rolloff toward parchment (#d8c8a8).
      if (uToneCurve > 0.0) {
        float tlum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        vec3 sc = color.rgb * color.rgb * (3.0 - 2.0 * color.rgb);
        color.rgb = mix(color.rgb, sc, 0.22 * uToneCurve);
        float shadow = 1.0 - smoothstep(0.0, 0.45, tlum);
        color.rgb += shadow * shadow * vec3(0.014, 0.006, -0.004) * uToneCurve;
        float hi = smoothstep(0.62, 1.0, tlum);
        vec3 parch = vec3(0.847, 0.784, 0.659);
        vec3 rolled = min(color.rgb, parch + (color.rgb - parch) * 0.6);
        color.rgb = mix(color.rgb, rolled, hi * 0.5 * uToneCurve);
        color.rgb = max(color.rgb, 0.0);
      }

      // Film grain: zero-mean, damped in deep shadow so charcoal stays calm.
      float g = grainHash(vUv * vec2(1613.0, 907.0) + fract(uTime) * 71.3) - 0.5;
      float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      color.rgb += g * uGrain * (0.35 + 0.65 * smoothstep(0.0, 0.35, lum));

      // Soft vignette: warm near-black, never pure black.
      float d = distance(vUv, vec2(0.5));
      float vig = smoothstep(uVigStart, 0.78, d);
      color.rgb *= 1.0 - uVigStrength * vig;

      gl_FragColor = color;
    }
  `,
};

// --- Pipeline ----------------------------------------------------------------

export interface PostPipeline {
  /** Render one frame through the chain. dt advances the grain clock. */
  render(dt: number): void;
  setSize(width: number, height: number): void;
  dispose(): void;
  /** Exposed for tuning/debug harnesses. */
  readonly bloom: UnrealBloomPass;
}

export interface PostPipelineOptions {
  /**
   * The scene's FireSystem. When provided, the chain renders fire particles
   * in a dedicated HALF-RES pass with soft-particle depth fade, depth-aware
   * upsampling and heat shimmer (FireScenePass). Without it the chain falls
   * back to a plain full-res RenderPass (debug harnesses).
   */
  fire?: FireSystem;
}

export function createPostPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: PostPipelineOptions = {},
): PostPipeline {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  const firePass =
    opts.fire && camera instanceof THREE.PerspectiveCamera
      ? new FireScenePass(scene, camera, opts.fire, size.x, size.y)
      : null;
  const renderPass = firePass ?? new RenderPass(scene, camera);

  // AO attempt (POST_AO): both passes re-render the scene at HALF res for
  // depth/normals, then blend the blurred AO term over the beauty buffer.
  let aoPass: SAOPass | SSAOPass | null = null;
  if (POST_AO !== 'off' && camera instanceof THREE.PerspectiveCamera) {
    if (POST_AO === 'sao') {
      const sao = new SAOPass(scene, camera, new THREE.Vector2(size.x * 0.5, size.y * 0.5));
      sao.params.saoIntensity = 0.012;
      sao.params.saoScale = 6;
      sao.params.saoKernelRadius = 24;
      sao.params.saoBlur = true;
      aoPass = sao;
    } else {
      const ssao = new SSAOPass(scene, camera, size.x * 0.5, size.y * 0.5, 16);
      ssao.kernelRadius = 1.1;
      ssao.minDistance = 0.0015;
      ssao.maxDistance = 0.35;
      aoPass = ssao;
    }
  }
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x * POST_BLOOM_SCALE, size.y * POST_BLOOM_SCALE),
    POST_BLOOM_STRENGTH,
    POST_BLOOM_RADIUS,
    POST_BLOOM_THRESHOLD,
  );
  const grade = new ShaderPass(GradeShader);
  grade.uniforms['uExposure']!.value = renderer.toneMappingExposure;

  composer.addPass(renderPass);
  if (aoPass) composer.addPass(aoPass);
  composer.addPass(bloom);
  composer.addPass(grade);

  // composer.addPass / composer.setSize push the FULL framebuffer size into
  // every pass; re-shrink the bloom mip chain afterwards (see POST_BLOOM_SCALE).
  const shrinkBloom = (w: number, h: number): void => {
    bloom.setSize(w * POST_BLOOM_SCALE, h * POST_BLOOM_SCALE);
    aoPass?.setSize(w * 0.5, h * 0.5);
    const pr = renderer.getPixelRatio();
    (grade.uniforms['uInvRes']!.value as THREE.Vector2).set(
      1 / Math.max(w * pr, 1),
      1 / Math.max(h * pr, 1),
    );
  };
  shrinkBloom(size.x, size.y);

  let time = 0;
  return {
    bloom,
    render(dt: number): void {
      time += Math.max(dt, 0);
      grade.uniforms['uTime']!.value = time;
      if (firePass) firePass.time = time;
      composer.render();
    },
    setSize(width: number, height: number): void {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(width, height);
      shrinkBloom(width, height);
    },
    dispose(): void {
      composer.dispose();
      bloom.dispose();
      grade.dispose();
      aoPass?.dispose();
      renderPass.dispose();
    },
  };
}
