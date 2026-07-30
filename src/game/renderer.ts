/**
 * Single source of truth for renderer color management (Phase 3 audit).
 *
 * Findings that motivated this module: the arena debug harness set
 * ACESFilmic tonemapping but the REAL game renderer in ArenaScreen never
 * did, so live play rendered with NoToneMapping: additive fire clipped to
 * flat orange, highlights plateaued, and shadows sat gray instead of deep
 * charcoal. Every renderer now goes through configureRenderer so the game,
 * the debug harnesses and the perf gate share one pipeline.
 *
 * three r169 defaults ColorManagement.enabled = true and outputColorSpace
 * = SRGB; both are set explicitly anyway so a future three upgrade cannot
 * silently change the pipeline. Material hex colors are therefore authored
 * in sRGB (three converts to linear internally), and canvas textures must
 * carry texture.colorSpace = SRGBColorSpace (arena.ts already does).
 */

import * as THREE from 'three';

/**
 * Scene exposure under ACESFilmic. Tuned by screenshot comparison against
 * the Section 9 target (deep charcoal shadows, firelight pools that bloom
 * without clipping): 1.0 left the hall too dim after the ambient cut,
 * 1.35 grayed the shadow floor again. 1.2 holds both.
 */
export const TONE_EXPOSURE = 1.2;

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  THREE.ColorManagement.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_EXPOSURE;
}
