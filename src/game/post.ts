/**
 * Post-processing chain (Round 3 Phase 6): the layers that make the low-poly
 * courtyard read photographic instead of flat-rendered.
 *
 *   RenderPass -> UnrealBloomPass -> grade ShaderPass (tonemap+grain+vignette)
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
 * Depth of field: measured OVER budget on the target hardware (see module
 * header). Kept as a constant so the decision is explicit and revisitable.
 */
export const POST_DOF = false;
/**
 * Bloom buffer scale relative to the framebuffer. Full-res bloom measured
 * 19.4 ms median on the Intel iGPU target (FAIL); bloom is a blur, so the
 * mip chain starts at quarter res and the result is visually identical for
 * fire-sized sources while fitting the budget.
 */
export const POST_BLOOM_SCALE = 0.25;

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
      color.rgb = linearToSrgb(acesFilmic(color.rgb));

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

export function createPostPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostPipeline {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x * POST_BLOOM_SCALE, size.y * POST_BLOOM_SCALE),
    POST_BLOOM_STRENGTH,
    POST_BLOOM_RADIUS,
    POST_BLOOM_THRESHOLD,
  );
  const grade = new ShaderPass(GradeShader);
  grade.uniforms['uExposure']!.value = renderer.toneMappingExposure;

  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(grade);

  // composer.addPass / composer.setSize push the FULL framebuffer size into
  // every pass; re-shrink the bloom mip chain afterwards (see POST_BLOOM_SCALE).
  const shrinkBloom = (w: number, h: number): void => {
    bloom.setSize(w * POST_BLOOM_SCALE, h * POST_BLOOM_SCALE);
  };
  shrinkBloom(size.x, size.y);

  let time = 0;
  return {
    bloom,
    render(dt: number): void {
      time += Math.max(dt, 0);
      grade.uniforms['uTime']!.value = time;
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
      renderPass.dispose();
    },
  };
}
