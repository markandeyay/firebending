// Training constructs and physics (T050 / final P4, Section 11): straw-bound
// sparring dummies lashed to a weathered timber post on a weighted stone base.
// Visible rope bindings (merged torus wraps), dark iron banding, and frayed
// straw silhouettes (alpha-tested fin planes) dress the physics capsule. They
// wobble on a Rapier joint when hit and stage damage readably: straw chars
// darker, burn patches erode away (dissolve shader with a glowing ember rim
// on the erode boundary), smoke rises from wounds above 50% (integration
// layer reads smokeIntensity/smokeSource), and death breaks the dummy into
// debris that settles under rapier. Tier 2 constructs lob arcing coal
// projectiles (kinematic parabola, no rapier body). Six deterministic visual
// variants (CONSTRUCT_VARIANTS, one per courtyard station) vary proportions,
// band count, straw tone and the tier 2 armor silhouette.
//
// All canvas textures are headless-guarded (shared module cache, null in
// node) and every construct falls back to flat colors, so the whole module
// stays testable without a DOM. Rapier is imported dynamically inside
// createPhysicsWorld() so this module stays cheap to load and tests control
// WASM init explicitly.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type * as RapierNS from '@dimforge/rapier3d-compat';

type RapierModule = typeof import('@dimforge/rapier3d-compat');

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

export const FIXED_TIMESTEP = 1 / 60;
const GRAVITY_Y = -9.81;
/** Largest frame delta the accumulator will absorb (avoids spiral of death). */
const MAX_FRAME_DT = 0.25;

/** Default hit points by tier. Director ramps beyond this later. */
export const DEFAULT_HP: Record<ConstructTier, number> = { 1: 100, 2: 160 };

// Torso body: one dynamic capsule pinned to the base by a spherical joint.
const TORSO_CENTER_Y = 1.25;
const PIVOT_Y = 0.32;
const TORSO_CAPSULE_HALF_HEIGHT = 0.55;
const TORSO_CAPSULE_RADIUS = 0.28;
const TORSO_DENSITY = 30; // mass ~10.9 for the capsule above
/** Spring-back torque toward upright, N*m per sin(tilt). */
const SPRING_K = 250;
/** Rapier angular damping on the torso (weighted-base wobble decay). */
const TORSO_ANGULAR_DAMPING = 3.5;
const TORSO_LINEAR_DAMPING = 1.0;

// Death and debris.
const DEBRIS_DENSITY = 2;
const DEBRIS_LINEAR_DAMPING = 2.0;
const DEBRIS_ANGULAR_DAMPING = 3.0;
const DEBRIS_POP_UP = 2.4; // m/s upward pop when the construct breaks
const DEBRIS_POP_OUT = 1.3; // m/s radial scatter
const DEBRIS_SETTLE_LINVEL2 = 0.01; // |v|^2 below this counts as settled
const DEBRIS_SETTLE_ANGVEL2 = 0.05;
const DEBRIS_MAX_SETTLE_SEC = 3.5; // force settle after this long
const FADE_SEC = 2.0;
/**
 * Battle scars (Phase 5): settled debris RESTS in place instead of fading,
 * so the courtyard accumulates the fight's history. The manager caps the
 * total debris bodies kept alive at this count and fades the OLDEST resting
 * construct out whenever the cap is exceeded (each tier 1 kill leaves 5
 * pieces, so roughly the last four kills stay visible).
 */
export const DEBRIS_KEEP_CAP = 24;

// Charring: straw and wood lerp toward charcoal with damage percent.
const CHAR_TARGET = new THREE.Color(0x171310);
const CHAR_MAX_MIX = 0.85; // never fully black, keeps silhouette readable
/** Peak burn-dissolve threshold: never erode more than ~60% of the straw
 *  while alive so the silhouette stays readable. */
const BURN_MAX = 0.6;
/** Damage percent above which wounds smoke (integration layer emits). */
export const SMOKE_THRESHOLD = 0.5;

// Palette (Section 9 adjacent: dummy materials, fire stays the only saturation)
const POST_WOOD = 0x6e4a28;
const DARK_IRON = 0x2c2a2b;
const BASE_STONE = 0x46392c;
const COAL_BODY = 0x1c0f08;
const COAL_EMBER = 0xe8551c;

// Coal projectiles.
const LOB_ORIGIN_HEIGHT = 1.75;
const LOB_SPEED_HORIZONTAL = 4.5; // m/s used to derive flight time
const LOB_MIN_FLIGHT = 0.9;
const LOB_MAX_FLIGHT = 1.8;
export const COAL_RADIUS = 0.09;

// ---------------------------------------------------------------------------
// Deterministic pseudo-random (debris scatter stays test-stable)
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
// Canvas textures (shared module cache; null in headless node so tests and
// the flat-color fallback path never touch a DOM)
// ---------------------------------------------------------------------------

function make2d(w: number, h = w): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext('2d');
}

function colorTex(ctx: CanvasRenderingContext2D, repeat?: [number, number]): THREE.Texture {
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (repeat) tex.repeat.set(repeat[0], repeat[1]);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Non-color data (the burn noise field): stays LINEAR. */
function dataTex(ctx: CanvasRenderingContext2D): THREE.Texture {
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Tightly packed straw: slanted strand streaks, near-white multiplier so the
 *  per-variant material color leads. */
function makeStrawTexture(seed: number): THREE.Texture | null {
  const ctx = make2d(128);
  if (!ctx) return null;
  const rng = mulberry32(seed);
  ctx.fillStyle = '#cdb787';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 110; i++) {
    const x0 = rng() * 128;
    const slant = (rng() - 0.5) * 22;
    const dark = rng() < 0.3;
    const a = 0.14 + rng() * 0.2;
    ctx.strokeStyle = dark ? `rgba(74, 54, 28, ${a})` : `rgba(226, 202, 148, ${a})`;
    ctx.lineWidth = dark ? 1 : 1 + rng();
    ctx.beginPath();
    ctx.moveTo(x0, -4);
    ctx.lineTo(x0 + slant, 132);
    ctx.stroke();
  }
  // A few crushed horizontal kinks where the bindings cinch the bale.
  for (let i = 0; i < 8; i++) {
    const y = rng() * 128;
    ctx.strokeStyle = 'rgba(96, 72, 40, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(128, y + (rng() - 0.5) * 8);
    ctx.stroke();
  }
  return colorTex(ctx, [3, 2]);
}

/** Frayed straw for the alpha-tested fin planes: strands hang from the top
 *  edge (v = 1) and taper into transparency, so plane tips read as loose
 *  straw instead of a hard quad edge. */
function makeFrayTexture(seed: number): THREE.Texture | null {
  const ctx = make2d(128);
  if (!ctx) return null;
  const rng = mulberry32(seed);
  ctx.clearRect(0, 0, 128, 128);
  for (let i = 0; i < 84; i++) {
    const x = rng() * 128;
    const len = 46 + rng() * 78;
    const slant = (rng() - 0.5) * 26;
    const tone = rng() < 0.3 ? '92, 68, 36' : '206, 180, 124';
    const grad = ctx.createLinearGradient(x, 0, x + slant, len);
    grad.addColorStop(0, `rgba(${tone}, 0.95)`);
    grad.addColorStop(0.75, `rgba(${tone}, 0.85)`);
    grad.addColorStop(1, `rgba(${tone}, 0)`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1 + rng() * 1.6;
    ctx.beginPath();
    ctx.moveTo(x, -2);
    ctx.quadraticCurveTo(x + slant * 0.4, len * 0.55, x + slant, len);
    ctx.stroke();
  }
  return colorTex(ctx);
}

/** Twisted rope: tight diagonal strand ridges over a hemp base. */
function makeRopeTexture(seed: number): THREE.Texture | null {
  const ctx = make2d(64);
  if (!ctx) return null;
  const rng = mulberry32(seed);
  ctx.fillStyle = '#a58a5e';
  ctx.fillRect(0, 0, 64, 64);
  for (let x = -64; x < 64; x += 7) {
    ctx.strokeStyle = 'rgba(52, 38, 20, 0.55)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 64, 64);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(232, 210, 160, 0.28)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + 3, 0);
    ctx.lineTo(x + 67, 64);
    ctx.stroke();
  }
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = 'rgba(60, 44, 24, 0.25)';
    ctx.fillRect(rng() * 64, rng() * 64, 1 + rng() * 2, 1);
  }
  return colorTex(ctx, [6, 1]);
}

/** Weathered timber: wavy grain, deep scores, a couple of knots (the arena
 *  kit's wood-grain recipe, grayed for sun-bleached training posts). */
function makeTimberTexture(seed: number): THREE.Texture | null {
  const ctx = make2d(128);
  if (!ctx) return null;
  const rng = mulberry32(seed);
  ctx.fillStyle = '#c9bcaa';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 48; i++) {
    const x0 = rng() * 128;
    const drift = (rng() - 0.5) * 12;
    const dark = rng() < 0.28;
    ctx.strokeStyle = dark ? 'rgba(48, 32, 20, 0.32)' : 'rgba(86, 62, 40, 0.16)';
    ctx.lineWidth = dark ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x0, -4);
    ctx.bezierCurveTo(x0 + drift, 44, x0 - drift, 88, x0 + drift * 0.6, 132);
    ctx.stroke();
  }
  for (let i = 0; i < 3; i++) {
    const kx = 16 + rng() * 96;
    const ky = 16 + rng() * 96;
    ctx.strokeStyle = 'rgba(44, 30, 18, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(kx, ky, 3 + rng() * 3, 5 + rng() * 4, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Gray weathering streaks.
  for (let i = 0; i < 10; i++) {
    const x = rng() * 128;
    ctx.fillStyle = 'rgba(150, 150, 145, 0.10)';
    ctx.fillRect(x, 0, 2 + rng() * 5, 128);
  }
  return colorTex(ctx, [1, 2]);
}

/** Coarse stone blotches + hairline cracks (arena stone recipe). */
function makeBaseStoneTexture(seed: number): THREE.Texture | null {
  const ctx = make2d(128);
  if (!ctx) return null;
  const rng = mulberry32(seed);
  ctx.fillStyle = '#cfc6b8';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 120; i++) {
    const light = rng() < 0.35;
    ctx.fillStyle = light ? 'rgba(235, 224, 200, 0.10)' : 'rgba(30, 22, 14, 0.13)';
    ctx.beginPath();
    ctx.ellipse(rng() * 128, rng() * 128, 2 + rng() * 7, 2 + rng() * 5, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 6; i++) {
    ctx.strokeStyle = 'rgba(30, 22, 14, 0.4)';
    ctx.lineWidth = 1;
    const x = rng() * 128;
    const y = rng() * 128;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * 40, y + (rng() - 0.5) * 40);
    ctx.stroke();
  }
  return colorTex(ctx, [2, 2]);
}

/** Hammered dark iron: horizontal tool streaks and pit specks. */
function makeIronTexture(seed: number): THREE.Texture | null {
  const ctx = make2d(64);
  if (!ctx) return null;
  const rng = mulberry32(seed);
  ctx.fillStyle = '#d6d6d6';
  ctx.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 22; i++) {
    const y = rng() * 64;
    ctx.fillStyle = `rgba(40, 40, 42, ${0.1 + rng() * 0.18})`;
    ctx.fillRect(0, y, 64, 1 + rng() * 2);
  }
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = 'rgba(20, 20, 22, 0.35)';
    ctx.fillRect(rng() * 64, rng() * 64, 1 + rng(), 1 + rng());
  }
  return colorTex(ctx, [3, 1]);
}

/**
 * Grayscale burn-noise field: three octaves of wrapped value noise with the
 * histogram stretched wide, so the dissolve threshold eats the straw in
 * coherent patches AND the eaten fraction tracks the threshold roughly
 * linearly (a mid-heavy histogram made 50% damage erode nothing and 90%
 * turn the whole bale into rim glow).
 */
function makeBurnNoiseTexture(seed: number): THREE.Texture | null {
  const ctx = make2d(128);
  if (!ctx) return null;
  const rng = mulberry32(seed);
  const size = 128;
  const octaves = [
    { cells: 6, amp: 0.55 },
    { cells: 12, amp: 0.3 },
    { cells: 24, amp: 0.15 },
  ].map(({ cells, amp }) => {
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = rng();
    return { cells, amp, g };
  });
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const { cells, amp, g } of octaves) {
        const fx = (x / size) * cells;
        const fy = (y / size) * cells;
        const x0 = Math.floor(fx) % cells;
        const y0 = Math.floor(fy) % cells;
        const x1 = (x0 + 1) % cells;
        const y1 = (y0 + 1) % cells;
        const tx = fx - Math.floor(fx);
        const ty = fy - Math.floor(fy);
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const a = g[y0 * cells + x0] ?? 0;
        const b = g[y0 * cells + x1] ?? 0;
        const c = g[y1 * cells + x0] ?? 0;
        const d = g[y1 * cells + x1] ?? 0;
        v += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
      // Stretch the mid-heavy octave sum toward a full 0..1 spread.
      const stretched = Math.min(Math.max(0.5 + (v - 0.5) * 2.1, 0), 1);
      const i = (y * size + x) * 4;
      const t = Math.round(stretched * 255);
      img.data[i] = t;
      img.data[i + 1] = t;
      img.data[i + 2] = t;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return dataTex(ctx);
}

interface ConstructTextures {
  straw: THREE.Texture;
  fray: THREE.Texture;
  rope: THREE.Texture;
  timber: THREE.Texture;
  stone: THREE.Texture;
  iron: THREE.Texture;
  burn: THREE.Texture;
}

// Shared for the module lifetime (constructs come and go constantly; the
// seven small canvases are cheaper kept than rebuilt). Never disposed.
let texturesBuilt = false;
let texturesCache: ConstructTextures | null = null;

// Contact-shadow blob under the stone base (Final P3): baked stand-in for
// the screen-space AO that was measured and cut (src/game/post.ts POST_AO).
// Shared module-lifetime texture, same policy as the cache above.
let blobBuilt = false;
let blobCache: THREE.Texture | null = null;

function contactBlobTexture(): THREE.Texture | null {
  if (blobBuilt) return blobCache;
  blobBuilt = true;
  const ctx = make2d(64);
  if (!ctx) return null;
  ctx.clearRect(0, 0, 64, 64);
  const g = ctx.createRadialGradient(32, 32, 3, 32, 32, 31);
  g.addColorStop(0, 'rgba(10, 6, 3, 0.5)');
  g.addColorStop(0.55, 'rgba(10, 6, 3, 0.3)');
  g.addColorStop(1, 'rgba(10, 6, 3, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  blobCache = tex;
  return blobCache;
}

function constructTextures(): ConstructTextures | null {
  if (texturesBuilt) return texturesCache;
  texturesBuilt = true;
  const straw = makeStrawTexture(0x57a1);
  const fray = makeFrayTexture(0xf4a1);
  const rope = makeRopeTexture(0x40be);
  const timber = makeTimberTexture(0x71b3);
  const stone = makeBaseStoneTexture(0x5709);
  const iron = makeIronTexture(0x1409);
  const burn = makeBurnNoiseTexture(0xb42);
  if (straw && fray && rope && timber && stone && iron && burn) {
    texturesCache = { straw, fray, rope, timber, stone, iron, burn };
  }
  return texturesCache;
}

// ---------------------------------------------------------------------------
// Burn-dissolve shader: patches erode where the shared noise field drops
// below uBurn; surviving texels within the rim width glow ember-orange, so
// every scorched patch has a bright burning edge. Injected into the standard
// material via onBeforeCompile (per-construct uniform, shared program).
// ---------------------------------------------------------------------------

function installBurnShader(
  mat: THREE.MeshStandardMaterial,
  uBurn: { value: number },
  burnMap: THREE.Texture,
  // vMapUv carries the color map's repeat transform; this rescales the burn
  // sample so patch size stays ~a third of the torso regardless of repeat.
  burnScale: [number, number],
): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uBurn'] = uBurn;
    shader.uniforms['uBurnMap'] = { value: burnMap };
    shader.uniforms['uBurnScale'] = { value: new THREE.Vector2(burnScale[0], burnScale[1]) };
    shader.fragmentShader =
      'uniform float uBurn;\nuniform sampler2D uBurnMap;\nuniform vec2 uBurnScale;\n' +
      shader.fragmentShader
        .replace(
          '#include <map_fragment>',
          [
            '#include <map_fragment>',
            'float burnN = texture2D( uBurnMap, vMapUv * uBurnScale ).r;',
            'if ( burnN < uBurn ) discard;',
          ].join('\n'),
        )
        .replace(
          '#include <emissivemap_fragment>',
          [
            '#include <emissivemap_fragment>',
            'if ( uBurn > 0.001 ) {',
            '\tfloat burnRim = 1.0 - smoothstep( uBurn, uBurn + 0.12, burnN );',
            '\ttotalEmissiveRadiance += vec3( 0.95, 0.30, 0.08 ) * burnRim * ( 1.3 + 0.8 * uBurn );',
            '}',
          ].join('\n'),
        );
  };
}

// ---------------------------------------------------------------------------
// Visual variants: one per courtyard station (killTravel.ts STATIONS order),
// selected deterministically by station index. Proportions, iron band count,
// straw tone (muted tans only, Section 9: fire stays the only saturation)
// and the tier 2 armor silhouette all vary; the physics capsule does not.
// ---------------------------------------------------------------------------

export interface ConstructVariantSpec {
  /** Straw bale height / radii (visual only; collider stays fixed). */
  torsoH: number;
  torsoTopR: number;
  torsoBotR: number;
  headR: number;
  armLen: number;
  /** Arm roll in radians (a slightly cocked crossbar reads hand-lashed). */
  armTilt: number;
  postH: number;
  /** Iron bands riding the torso IN ADDITION to the loose band-1 debris piece. */
  bands: number;
  /** Straw tone within the muted tan family. */
  straw: number;
  rope: number;
  /** Stone base silhouette: 0 dome, 1 stepped block, 2 faceted drum. */
  baseStyle: 0 | 1 | 2;
  /** Tier 2 armor silhouette: 0 chest plates, 1 collar, 2 pauldrons+spine. */
  armor: 0 | 1 | 2;
}

export const CONSTRUCT_VARIANTS: readonly ConstructVariantSpec[] = [
  // 0 entry-hall: the classic. Balanced bale, twin rope wraps, dome base.
  { torsoH: 0.8, torsoTopR: 0.26, torsoBotR: 0.24, headR: 0.18, armLen: 1.1, armTilt: 0, postH: 1.6, bands: 1, straw: 0xc2a468, rope: 0x8a6f4a, baseStyle: 0, armor: 0 },
  // 1 colonnade: tall and lean, pale sun-dried straw, stepped base.
  { torsoH: 0.92, torsoTopR: 0.23, torsoBotR: 0.22, headR: 0.16, armLen: 1.22, armTilt: 0.1, postH: 1.72, bands: 2, straw: 0xcfb37c, rope: 0x84683f, baseStyle: 1, armor: 1 },
  // 2 terrace-vantage: squat heavy bale, dark oiled straw, faceted drum.
  { torsoH: 0.7, torsoTopR: 0.3, torsoBotR: 0.28, headR: 0.2, armLen: 1.02, armTilt: -0.08, postH: 1.5, bands: 1, straw: 0xa98d55, rope: 0x7c6242, baseStyle: 2, armor: 2 },
  // 3 bridge-deck: barrel torso in three iron bands (re-hooped cask fiction).
  { torsoH: 0.84, torsoTopR: 0.27, torsoBotR: 0.26, headR: 0.17, armLen: 1.14, armTilt: 0.05, postH: 1.62, bands: 3, straw: 0xc9a05f, rope: 0x8a6f4a, baseStyle: 1, armor: 0 },
  // 4 great-gate: broad shoulders (long crossbar), ashy straw.
  { torsoH: 0.78, torsoTopR: 0.28, torsoBotR: 0.24, headR: 0.19, armLen: 1.3, armTilt: -0.12, postH: 1.58, bands: 2, straw: 0xb5a172, rope: 0x806747, baseStyle: 2, armor: 1 },
  // 5 channel-edge: lean russet bale, cocked arms, dome base.
  { torsoH: 0.86, torsoTopR: 0.24, torsoBotR: 0.25, headR: 0.17, armLen: 1.08, armTilt: 0.14, postH: 1.66, bands: 1, straw: 0xbb9457, rope: 0x8a6f4a, baseStyle: 0, armor: 2 },
];

// ---------------------------------------------------------------------------
// PhysicsWorld: rapier wrapper with a fixed-timestep accumulator
// ---------------------------------------------------------------------------

export interface PhysicsWorld {
  readonly rapier: RapierModule;
  readonly world: RapierNS.World;
  /**
   * Advance simulation by dt seconds using a fixed 60 Hz accumulator.
   * `beforeStep` runs before each fixed step (per-step forces live there).
   * Returns the number of fixed steps taken.
   */
  step(dt: number, beforeStep?: (stepDt: number) => void): number;
  dispose(): void;
}

export async function createPhysicsWorld(): Promise<PhysicsWorld> {
  const rapier: RapierModule = await import('@dimforge/rapier3d-compat');
  await rapier.init();

  const world = new rapier.World({ x: 0, y: GRAVITY_Y, z: 0 });
  world.timestep = FIXED_TIMESTEP;

  // Static ground plane at y = 0 so debris has something to settle on.
  world.createCollider(
    rapier.ColliderDesc.cuboid(60, 0.5, 60).setTranslation(0, -0.5, 0).setFriction(0.9),
  );

  let accumulator = 0;
  let disposed = false;

  return {
    rapier,
    world,
    step(dt: number, beforeStep?: (stepDt: number) => void): number {
      if (disposed) return 0;
      accumulator += Math.min(Math.max(dt, 0), MAX_FRAME_DT);
      let steps = 0;
      // Epsilon keeps 0.05s frames producing exactly 3 steps despite float drift.
      while (accumulator + 1e-9 >= FIXED_TIMESTEP) {
        if (beforeStep) beforeStep(FIXED_TIMESTEP);
        world.step();
        accumulator -= FIXED_TIMESTEP;
        steps++;
      }
      return steps;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      world.free();
    },
  };
}

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

export type ConstructTier = 1 | 2;

export interface ConstructOptions {
  tier?: ConstructTier;
  hp?: number;
  /** Fired exactly once, with the torso world position at the moment of death. */
  onDeath?: (position: THREE.Vector3) => void;
  /** Seed for debris scatter; defaults to a fixed value for determinism. */
  seed?: number;
  /**
   * Local ground height under the construct (Phase 5 stations: the bridge
   * deck sits at +0.5). The base, torso and debris all spawn relative to it.
   * The integration layer registers matching static colliders so debris can
   * rest on raised decks; without them it settles on the y = 0 ground.
   */
  floorY?: number;
  /**
   * Visual variant index into CONSTRUCT_VARIANTS (wrapped). The director
   * passes the station index so each courtyard station fields its own dummy
   * build; defaults to 0.
   */
  variant?: number;
}

export interface CoalProjectile {
  readonly mesh: THREE.Mesh;
  /** Live world-space position, updated every frame. */
  readonly position: THREE.Vector3;
  readonly start: THREE.Vector3;
  readonly target: THREE.Vector3;
  readonly radius: number;
  readonly flightTime: number;
  age: number;
}

interface DebrisPiece {
  mesh: THREE.Object3D;
  body: RapierNS.RigidBody;
}

type ConstructState = 'alive' | 'dying' | 'resting' | 'fading' | 'gone';

// Shared scratch objects (single threaded).
const _q = new THREE.Quaternion();
const _bodyUp = new THREE.Vector3();
const _torque = new THREE.Vector3();
const _v = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class Construct {
  readonly group: THREE.Group;
  readonly tier: ConstructTier;
  readonly maxHp: number;
  hp: number;
  /** Fired when a lobbed coal reaches its target. Combat wires block/duck here. */
  onProjectileArrive: ((landPos: THREE.Vector3) => void) | null = null;
  readonly projectiles: CoalProjectile[] = [];

  private readonly physics: PhysicsWorld;
  private readonly parent: THREE.Object3D;
  private state: ConstructState = 'alive';
  private deathPos: THREE.Vector3 | null = null;
  private readonly onDeathCb: ((position: THREE.Vector3) => void) | null;
  private readonly rng: () => number;

  // Physics
  private baseBody: RapierNS.RigidBody;
  private torsoBody: RapierNS.RigidBody | null;
  private joint: RapierNS.ImpulseJoint | null;
  private readonly debrisPieces: DebrisPiece[] = [];
  private deathAge = 0;
  private fadeAge = 0;
  private settled = false;

  // Visuals
  readonly variantIndex: number;
  private readonly torsoGroup: THREE.Group;
  private readonly strawMat: THREE.MeshStandardMaterial;
  private readonly frayMat: THREE.MeshStandardMaterial;
  private readonly woodMat: THREE.MeshStandardMaterial;
  private readonly ropeMat: THREE.MeshStandardMaterial;
  private readonly ironMat: THREE.MeshStandardMaterial;
  private readonly stoneMat: THREE.MeshStandardMaterial;
  private readonly coalMat: THREE.MeshStandardMaterial;
  /** Contact-shadow blob material; null when headless (no canvas). */
  private blobMat: THREE.MeshBasicMaterial | null = null;
  private readonly strawBase: THREE.Color;
  private readonly ropeBase: THREE.Color;
  private readonly woodBase = new THREE.Color(POST_WOOD);
  /** Shared by the straw + fray burn shaders; damagePercent drives it. */
  private readonly burnUniform = { value: 0 };
  /** Wound point offset from the torso center (smoke emission anchor). */
  private readonly woundOffset = new THREE.Vector3();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly headMesh: THREE.Mesh;
  private readonly debrisCandidates: THREE.Object3D[] = [];
  private readonly coalGeometry: THREE.BufferGeometry;

  // Lobbing
  private lobTarget: THREE.Vector3 | null = null;
  private lobInterval = 0;
  private lobTimer = 0;

  constructor(
    physics: PhysicsWorld,
    parent: THREE.Object3D,
    anchorPos: THREE.Vector3,
    options: ConstructOptions = {},
  ) {
    this.physics = physics;
    this.parent = parent;
    this.tier = options.tier ?? 1;
    this.maxHp = options.hp ?? DEFAULT_HP[this.tier];
    this.hp = this.maxHp;
    this.onDeathCb = options.onDeath ?? null;
    this.rng = mulberry32(options.seed ?? 0xd0117);
    const floorY = options.floorY ?? 0;

    const { rapier, world } = physics;

    this.group = new THREE.Group();
    this.group.name = 'construct';
    this.group.position.set(anchorPos.x, floorY, anchorPos.z);
    parent.add(this.group);

    // --- Variant -----------------------------------------------------------
    const variantCount = CONSTRUCT_VARIANTS.length;
    this.variantIndex =
      ((Math.floor(options.variant ?? 0) % variantCount) + variantCount) % variantCount;
    const v = CONSTRUCT_VARIANTS[this.variantIndex] ?? CONSTRUCT_VARIANTS[0];
    if (!v) throw new Error('CONSTRUCT_VARIANTS is empty');

    // --- Materials (cloned per construct so charring stays local; the
    // canvas textures are the shared module cache, null when headless) ------
    const tex = constructTextures();
    this.strawBase = new THREE.Color(v.straw);
    this.ropeBase = new THREE.Color(v.rope);
    this.strawMat = new THREE.MeshStandardMaterial({
      color: v.straw,
      map: tex?.straw ?? null,
      // Dry straw (PBR audit ~0.95): a whisper of sheen on the stalks.
      roughness: 0.95,
      metalness: 0.0,
      flatShading: true,
      side: THREE.DoubleSide, // burn holes reveal the bale interior
    });
    this.frayMat = new THREE.MeshStandardMaterial({
      color: v.straw,
      map: tex?.fray ?? null,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      roughness: 0.95,
      metalness: 0.0,
    });
    if (tex) {
      // Straw map repeats 3x2; divide the burn sample back to ~one noise
      // tile around the bale. Fray planes are 1x1 already.
      installBurnShader(this.strawMat, this.burnUniform, tex.burn, [1 / 3, 1 / 2]);
      installBurnShader(this.frayMat, this.burnUniform, tex.burn, [1, 1]);
    }
    this.woodMat = new THREE.MeshStandardMaterial({
      color: POST_WOOD,
      map: tex?.timber ?? null,
      roughness: 0.9,
      metalness: 0.0,
      flatShading: true,
    });
    this.ropeMat = new THREE.MeshStandardMaterial({
      color: v.rope,
      map: tex?.rope ?? null,
      roughness: 1.0,
      metalness: 0.0,
    });
    this.ironMat = new THREE.MeshStandardMaterial({
      color: DARK_IRON,
      map: tex?.iron ?? null,
      // Forged iron bands (PBR audit): true metal, hammered-matte spec.
      roughness: 0.42,
      metalness: 0.9,
      flatShading: true,
    });
    this.stoneMat = new THREE.MeshStandardMaterial({
      color: BASE_STONE,
      map: tex?.stone ?? null,
      // Dressed footing stone (PBR audit target ~0.85).
      roughness: 0.85,
      metalness: 0.0,
      flatShading: true,
    });
    this.coalMat = new THREE.MeshStandardMaterial({
      color: COAL_BODY,
      emissive: COAL_EMBER,
      emissiveIntensity: 1.2,
      roughness: 0.8,
      flatShading: true,
    });

    const geo = <T extends THREE.BufferGeometry>(g: T): T => {
      this.geometries.push(g);
      return g;
    };
    const merge = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
      const merged =
        mergeGeometries(parts, false) ?? parts[0] ?? new THREE.BoxGeometry(0.05, 0.05, 0.05);
      for (const p of parts) {
        if (p !== merged) p.dispose();
      }
      return geo(merged);
    };
    const r = this.rng;

    // Wound anchor: a fixed spot on the torso where smoke rises once damage
    // passes SMOKE_THRESHOLD (integration layer reads smokeSource()).
    this.woundOffset.set((r() - 0.5) * 0.3, 0.1 + r() * 0.25, (r() - 0.5) * 0.3);

    // --- Base: weighted stone footing (variant silhouette), merged mesh ----
    const baseParts: THREE.BufferGeometry[] = [];
    if (v.baseStyle === 0) {
      const slab = new THREE.BoxGeometry(0.98, 0.12, 0.98);
      slab.translate(0, 0.06, 0);
      const dome = new THREE.SphereGeometry(0.45, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      dome.scale(1, 0.8, 1);
      dome.translate(0, 0.12, 0);
      baseParts.push(slab, dome);
    } else if (v.baseStyle === 1) {
      const s1 = new THREE.BoxGeometry(1.0, 0.16, 1.0);
      s1.translate(0, 0.08, 0);
      const s2 = new THREE.BoxGeometry(0.76, 0.16, 0.76);
      s2.translate(0, 0.24, 0);
      const drum = new THREE.CylinderGeometry(0.3, 0.36, 0.2, 8);
      drum.translate(0, 0.42, 0);
      baseParts.push(s1, s2, drum);
    } else {
      const ring = new THREE.CylinderGeometry(0.56, 0.6, 0.1, 8);
      ring.translate(0, 0.05, 0);
      const drum = new THREE.CylinderGeometry(0.44, 0.52, 0.28, 8);
      drum.translate(0, 0.24, 0);
      const cap = new THREE.CylinderGeometry(0.3, 0.42, 0.14, 8);
      cap.translate(0, 0.45, 0);
      baseParts.push(ring, drum, cap);
    }
    const baseMesh = new THREE.Mesh(merge(baseParts), this.stoneMat);
    baseMesh.name = 'construct-base';
    baseMesh.castShadow = true;
    baseMesh.receiveShadow = true;
    this.group.add(baseMesh);

    // Contact-shadow blob grounding the base (see contactBlobTexture).
    const blobTex = contactBlobTexture();
    if (blobTex) {
      this.blobMat = new THREE.MeshBasicMaterial({
        map: blobTex,
        transparent: true,
        depthWrite: false,
      });
      const blob = new THREE.Mesh(geo(new THREE.PlaneGeometry(1.6, 1.6)), this.blobMat);
      blob.name = 'construct-contact-blob';
      blob.rotation.x = -Math.PI / 2;
      blob.position.y = 0.012;
      blob.renderOrder = 2;
      this.group.add(blob);
    }

    // --- Torso assembly: everything above the pivot syncs from one body ----
    // Children are positioned relative to the torso body center (world y 1.25).
    this.torsoGroup = new THREE.Group();
    this.torsoGroup.name = 'construct-torso';
    this.torsoGroup.position.set(0, TORSO_CENTER_Y, 0);
    this.group.add(this.torsoGroup);

    // Weathered timber post carrying the bale.
    const post = new THREE.Mesh(
      geo(new THREE.CylinderGeometry(0.055, 0.075, v.postH, 8)),
      this.woodMat,
    );
    post.name = 'construct-post';
    post.position.set(0, -0.15, 0);
    post.castShadow = true;

    // Straw bale torso (variant proportions; the physics capsule is fixed).
    const torsoMesh = new THREE.Mesh(
      geo(new THREE.CylinderGeometry(v.torsoTopR, v.torsoBotR, v.torsoH, 10)),
      this.strawMat,
    );
    torsoMesh.name = 'construct-straw-torso';
    torsoMesh.position.set(0, 0.05, 0);
    torsoMesh.castShadow = true;

    const headGeo = geo(new THREE.SphereGeometry(v.headR, 9, 7));
    headGeo.scale(1, 1.12, 1); // slightly oblong bound-straw head
    const head = new THREE.Mesh(headGeo, this.strawMat);
    head.name = 'construct-straw-head';
    head.position.set(0, 0.05 + v.torsoH / 2 + v.headR * 0.95, 0);
    head.castShadow = true;
    this.headMesh = head;

    const arms = new THREE.Mesh(geo(new THREE.BoxGeometry(v.armLen, 0.085, 0.085)), this.woodMat);
    arms.name = 'construct-arms';
    arms.position.set(0, 0.05 + v.torsoH * 0.3, 0);
    arms.rotation.z = v.armTilt;
    arms.castShadow = true;

    // Dark iron banding. Band 1 is the loose debris piece near the bale foot;
    // the variant's remaining bands merge into one mesh riding the torso.
    const band1 = new THREE.Mesh(
      geo(new THREE.CylinderGeometry(v.torsoBotR + 0.02, v.torsoBotR + 0.02, 0.06, 10)),
      this.ironMat,
    );
    band1.name = 'construct-band-1';
    band1.position.set(0, 0.05 - v.torsoH / 2 + 0.08, 0);

    const bandR = Math.max(v.torsoTopR, v.torsoBotR);
    const bandParts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < v.bands; i++) {
      const t = (i + 1) / (v.bands + 1);
      const b = new THREE.CylinderGeometry(bandR + 0.012, bandR + 0.012, 0.055, 10);
      b.translate(0, -v.torsoH * 0.5 + 0.16 + t * (v.torsoH - 0.3), 0);
      bandParts.push(b);
    }
    const bandsMesh = new THREE.Mesh(merge(bandParts), this.ironMat);
    bandsMesh.name = 'construct-bands';
    torsoMesh.add(bandsMesh);

    // Rope bindings: two horizontal cinch wraps, a crossed diagonal lashing
    // and a knot bump, merged into one mesh riding the torso.
    const wrapR = bandR + 0.015;
    const ropeParts: THREE.BufferGeometry[] = [];
    for (const t of [0.3, 0.72]) {
      const tor = new THREE.TorusGeometry(wrapR, 0.022, 5, 14);
      tor.rotateX(Math.PI / 2);
      tor.translate(0, -v.torsoH / 2 + t * v.torsoH, 0);
      ropeParts.push(tor);
    }
    for (const s of [-1, 1]) {
      const tor = new THREE.TorusGeometry(wrapR + 0.015, 0.02, 5, 14);
      tor.rotateX(Math.PI / 2);
      tor.rotateZ(s * 0.5);
      ropeParts.push(tor);
    }
    const knot = new THREE.SphereGeometry(0.045, 6, 5);
    knot.translate(wrapR + 0.02, 0.04, 0);
    ropeParts.push(knot);
    const ropeMesh = new THREE.Mesh(merge(ropeParts), this.ropeMat);
    ropeMesh.name = 'construct-rope';
    torsoMesh.add(ropeMesh);

    // Frayed straw silhouette: alpha-tested fin planes. A loose skirt around
    // the bale foot, tufts poking from the shoulders, and a head topknot.
    const frayParts: THREE.BufferGeometry[] = [];
    const skirtN = 5;
    for (let i = 0; i < skirtN; i++) {
      const a = (i / skirtN) * Math.PI * 2 + r() * 0.5;
      const w = 0.26 + r() * 0.1;
      const h = 0.28 + r() * 0.12;
      const p = new THREE.PlaneGeometry(w, h);
      p.translate(0, -h / 2, 0); // hang from the top edge
      p.rotateX(-0.35 - r() * 0.25); // flare the tips outward
      p.rotateY(a);
      p.translate(
        Math.sin(a) * (v.torsoBotR - 0.02),
        -v.torsoH / 2 + 0.05,
        Math.cos(a) * (v.torsoBotR - 0.02),
      );
      frayParts.push(p);
    }
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.7 + r() * 0.5;
      const w = 0.16 + r() * 0.06;
      const h = 0.2 + r() * 0.08;
      const p = new THREE.PlaneGeometry(w, h);
      p.translate(0, -h / 2, 0);
      p.rotateX(Math.PI - 0.7 - r() * 0.3); // flipped: strands point up and out
      p.rotateY(a);
      p.translate(
        Math.sin(a) * (v.torsoTopR - 0.04),
        v.torsoH / 2 - 0.02,
        Math.cos(a) * (v.torsoTopR - 0.04),
      );
      frayParts.push(p);
    }
    const frayTorso = new THREE.Mesh(merge(frayParts), this.frayMat);
    frayTorso.name = 'construct-fray-torso';
    torsoMesh.add(frayTorso);

    const tuftParts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 2; i++) {
      const p = new THREE.PlaneGeometry(0.16, 0.2);
      p.translate(0, -0.1, 0);
      p.rotateX(Math.PI + (r() - 0.5) * 0.5);
      p.rotateY((i * Math.PI) / 2 + r() * 0.4);
      p.translate(0, v.headR, 0);
      tuftParts.push(p);
    }
    const frayHead = new THREE.Mesh(merge(tuftParts), this.frayMat);
    frayHead.name = 'construct-fray-head';
    head.add(frayHead);

    this.torsoGroup.add(post, torsoMesh, head, arms, band1);
    this.debrisCandidates.push(torsoMesh, head, arms, post, band1);

    if (this.tier === 2) {
      // Armor silhouette (abstract, nothing figurative). The chest plate is
      // its own debris piece; the rest merges into one mesh riding the torso
      // so it flies with the bale on death.
      const frontZ = v.torsoTopR + 0.05;
      const plate1 = new THREE.Mesh(geo(new THREE.BoxGeometry(0.34, 0.28, 0.03)), this.ironMat);
      plate1.name = 'construct-plate-1';
      plate1.position.set(0, 0.05 + v.torsoH * 0.18, frontZ);
      this.torsoGroup.add(plate1);
      this.debrisCandidates.push(plate1);

      const armorParts: THREE.BufferGeometry[] = [];
      if (v.armor === 0) {
        // Chest plates: a second lower plate + shoulder caps.
        const p2 = new THREE.BoxGeometry(0.26, 0.2, 0.03);
        p2.translate(0, -v.torsoH * 0.14, frontZ);
        armorParts.push(p2);
        for (const s of [-1, 1]) {
          const cap = new THREE.BoxGeometry(0.14, 0.06, 0.14);
          cap.translate(s * (v.torsoTopR + 0.02), v.torsoH / 2 + 0.02, 0);
          armorParts.push(cap);
        }
      } else if (v.armor === 1) {
        // Iron collar around the neck + a back plate.
        const collar = new THREE.CylinderGeometry(v.headR + 0.07, v.headR + 0.11, 0.08, 9);
        collar.translate(0, v.torsoH / 2 + 0.04, 0);
        armorParts.push(collar);
        const back = new THREE.BoxGeometry(0.3, 0.24, 0.03);
        back.translate(0, v.torsoH * 0.16, -(v.torsoTopR + 0.04));
        armorParts.push(back);
      } else {
        // Pauldron slabs over the shoulders + a spine strip down the back.
        for (const s of [-1, 1]) {
          const pd = new THREE.BoxGeometry(0.2, 0.07, 0.24);
          pd.translate(s * (v.torsoTopR + 0.05), v.torsoH / 2 - 0.02, 0);
          armorParts.push(pd);
        }
        const spine = new THREE.BoxGeometry(0.07, v.torsoH * 0.75, 0.03);
        spine.translate(0, 0, -(v.torsoTopR + 0.03));
        armorParts.push(spine);
      }
      const armorMesh = new THREE.Mesh(merge(armorParts), this.ironMat);
      armorMesh.name = 'construct-armor';
      armorMesh.castShadow = true;
      torsoMesh.add(armorMesh);
    }

    this.coalGeometry = geo(new THREE.DodecahedronGeometry(COAL_RADIUS, 0));

    // --- Physics -----------------------------------------------------------
    // Base: fixed body, no collider needed (visual dome + joint anchor only).
    this.baseBody = world.createRigidBody(
      rapier.RigidBodyDesc.fixed().setTranslation(anchorPos.x, floorY, anchorPos.z),
    );

    // Torso: ONE dynamic body. Gravity is disabled on it: the weighted-base
    // fiction means the assembly is bottom-heavy and self-righting, so the
    // spring below is the only restoring force and upright is a stable
    // equilibrium (no inverted-pendulum fighting).
    const torsoBody = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(anchorPos.x, floorY + TORSO_CENTER_Y, anchorPos.z)
        .setLinearDamping(TORSO_LINEAR_DAMPING)
        .setAngularDamping(TORSO_ANGULAR_DAMPING)
        .setGravityScale(0),
    );
    world.createCollider(
      rapier.ColliderDesc.capsule(TORSO_CAPSULE_HALF_HEIGHT, TORSO_CAPSULE_RADIUS).setDensity(
        TORSO_DENSITY,
      ),
      torsoBody,
    );
    this.torsoBody = torsoBody;

    // Spherical joint at the base pivot: wobble in any direction, no sliding.
    this.joint = world.createImpulseJoint(
      rapier.JointData.spherical(
        { x: 0, y: PIVOT_Y, z: 0 },
        { x: 0, y: PIVOT_Y - TORSO_CENTER_Y, z: 0 },
      ),
      this.baseBody,
      torsoBody,
      true,
    );
  }

  // --- State getters -------------------------------------------------------

  get isAlive(): boolean {
    return this.state === 'alive';
  }

  get isGone(): boolean {
    return this.state === 'gone';
  }

  /** Debris has settled and rests in place as a battle scar (Phase 5). */
  get isResting(): boolean {
    return this.state === 'resting';
  }

  /** Fade-out in progress (already counted as leaving, not as kept debris). */
  get isFading(): boolean {
    return this.state === 'fading';
  }

  get damagePercent(): number {
    return THREE.MathUtils.clamp(1 - this.hp / this.maxHp, 0, 1);
  }

  /** Torso world position at the moment of death (ember burst spawn point). */
  get deathPosition(): THREE.Vector3 | null {
    return this.deathPos;
  }

  /** Angle in radians between the torso up axis and world up. 0 = upright. */
  get tiltAngle(): number {
    if (!this.torsoBody) return 0;
    const rot = this.torsoBody.rotation();
    _q.set(rot.x, rot.y, rot.z, rot.w);
    _bodyUp.set(0, 1, 0).applyQuaternion(_q);
    return _bodyUp.angleTo(WORLD_UP);
  }

  get debris(): readonly DebrisPiece[] {
    return this.debrisPieces;
  }

  // --- Damage --------------------------------------------------------------

  /**
   * Apply a hit: impulse (N*s, world space) at hitPoint (world space) wobbles
   * the torso; damage accumulates and chars the straw and wood.
   */
  takeHit(damage: number, impulse: THREE.Vector3, hitPoint: THREE.Vector3): void {
    if (this.state !== 'alive' || !this.torsoBody) return;
    this.torsoBody.applyImpulseAtPoint(
      { x: impulse.x, y: impulse.y, z: impulse.z },
      { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z },
      true,
    );
    this.hp = Math.max(0, this.hp - damage);
    this.applyCharring();
    if (this.hp <= 0) this.die();
  }

  private applyCharring(): void {
    const d = this.damagePercent;
    const mix = d * CHAR_MAX_MIX;
    this.strawMat.color.lerpColors(this.strawBase, CHAR_TARGET, mix);
    this.frayMat.color.lerpColors(this.strawBase, CHAR_TARGET, mix);
    this.woodMat.color.lerpColors(this.woodBase, CHAR_TARGET, mix);
    this.ropeMat.color.lerpColors(this.ropeBase, CHAR_TARGET, mix * 0.9);
    // Burn-away: patches of straw erode as damage climbs (eased so early
    // jabs char before they carve holes), ember rim handled in-shader.
    this.burnUniform.value = Math.pow(d, 1.25) * BURN_MAX;
  }

  /** Current burn-dissolve threshold, 0..BURN_MAX. Rises with damage. */
  get burnLevel(): number {
    return this.burnUniform.value;
  }

  /**
   * 0 below SMOKE_THRESHOLD damage (or when not alive), then ramps 0..1 as
   * damage approaches 100%. The integration layer scales wound smoke by it.
   */
  get smokeIntensity(): number {
    if (this.state !== 'alive') return 0;
    return THREE.MathUtils.clamp(
      (this.damagePercent - SMOKE_THRESHOLD) / (1 - SMOKE_THRESHOLD),
      0,
      1,
    );
  }

  /**
   * World-space wound point smoke should rise from, written into `out`.
   * Null while smokeIntensity is 0 (below 50% damage, or dead).
   */
  smokeSource(out: THREE.Vector3): THREE.Vector3 | null {
    if (this.smokeIntensity <= 0) return null;
    this.torsoGroup.getWorldPosition(out);
    out.add(this.woundOffset);
    return out;
  }

  /**
   * Break the construct: release the joint, detach 4 to 6 debris pieces onto
   * individual small dynamic bodies with an upward pop, fire onDeath once.
   */
  die(): void {
    if (this.state !== 'alive' || !this.torsoBody) return;
    const { rapier, world } = this.physics;

    const t = this.torsoBody.translation();
    this.deathPos = new THREE.Vector3(t.x, t.y, t.z);

    this.stopLobbing();
    this.clearProjectiles();

    if (this.joint) {
      world.removeImpulseJoint(this.joint, true);
      this.joint = null;
    }
    world.removeRigidBody(this.torsoBody);
    this.torsoBody = null;

    // Detach debris meshes, preserving world transforms, and give each a body.
    const radii: Record<string, number> = {
      'construct-straw-torso': 0.28,
      'construct-straw-head': 0.18,
      'construct-arms': 0.12,
      'construct-post': 0.1,
      'construct-band-1': 0.14,
      'construct-plate-1': 0.12,
    };
    for (const mesh of this.debrisCandidates) {
      this.group.attach(mesh);
      mesh.getWorldPosition(_v);
      mesh.getWorldQuaternion(_q);
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(_v.x, _v.y, _v.z)
          .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
          .setLinearDamping(DEBRIS_LINEAR_DAMPING)
          .setAngularDamping(DEBRIS_ANGULAR_DAMPING),
      );
      world.createCollider(
        rapier.ColliderDesc.ball(radii[mesh.name] ?? 0.12)
          .setDensity(DEBRIS_DENSITY)
          .setFriction(0.9)
          .setRestitution(0.15),
        body,
      );
      const angle = this.rng() * Math.PI * 2;
      const out = DEBRIS_POP_OUT * (0.5 + this.rng());
      body.setLinvel(
        {
          x: Math.cos(angle) * out,
          y: DEBRIS_POP_UP * (0.7 + this.rng() * 0.6),
          z: Math.sin(angle) * out,
        },
        true,
      );
      body.setAngvel(
        { x: (this.rng() - 0.5) * 6, y: (this.rng() - 0.5) * 6, z: (this.rng() - 0.5) * 6 },
        true,
      );
      this.debrisPieces.push({ mesh, body });
    }

    // Prepare the whole construct for the post-settle fade.
    for (const mat of this.materials()) {
      mat.transparent = true;
    }

    this.state = 'dying';
    this.deathAge = 0;
    this.onDeathCb?.(this.deathPos.clone());
  }

  // --- Tier 2 lobbing ------------------------------------------------------

  /** Begin lobbing coal projectiles at targetPos every intervalSec seconds. */
  startLobbing(targetPos: THREE.Vector3, intervalSec: number): void {
    if (this.state !== 'alive') return;
    this.lobTarget = targetPos.clone();
    this.lobInterval = Math.max(0.1, intervalSec);
    this.lobTimer = 0;
  }

  stopLobbing(): void {
    this.lobTarget = null;
  }

  private lob(target: THREE.Vector3): void {
    this.headMesh.getWorldPosition(_v);
    const start = new THREE.Vector3(_v.x, this.group.position.y + LOB_ORIGIN_HEIGHT, _v.z);
    const dx = target.x - start.x;
    const dz = target.z - start.z;
    const horizontal = Math.hypot(dx, dz);
    const flightTime = THREE.MathUtils.clamp(
      horizontal / LOB_SPEED_HORIZONTAL,
      LOB_MIN_FLIGHT,
      LOB_MAX_FLIGHT,
    );
    const mesh = new THREE.Mesh(this.coalGeometry, this.coalMat);
    mesh.name = 'coal-projectile';
    this.group.add(mesh);
    const projectile: CoalProjectile = {
      mesh,
      position: start.clone(),
      start: start.clone(),
      target: target.clone(),
      radius: COAL_RADIUS,
      flightTime,
      age: 0,
    };
    this.placeProjectile(projectile);
    this.projectiles.push(projectile);
  }

  /** Ballistic arc: p(t) = start + v0 t + 0.5 g t^2, v0 solved to land on target. */
  private placeProjectile(p: CoalProjectile): void {
    const t = p.age;
    const T = p.flightTime;
    const v0x = (p.target.x - p.start.x) / T;
    const v0z = (p.target.z - p.start.z) / T;
    const v0y = (p.target.y - p.start.y) / T - 0.5 * GRAVITY_Y * T;
    p.position.set(
      p.start.x + v0x * t,
      p.start.y + v0y * t + 0.5 * GRAVITY_Y * t * t,
      p.start.z + v0z * t,
    );
    // Group carries only a translation, so local = world - group position.
    p.mesh.position.copy(p.position).sub(this.group.position);
  }

  private clearProjectiles(): void {
    for (const p of this.projectiles) {
      this.group.remove(p.mesh);
    }
    this.projectiles.length = 0;
  }

  // --- Per-frame hooks (driven by ConstructManager) ------------------------

  /** Runs before every fixed physics step: spring-back torque toward upright. */
  beforePhysicsStep(stepDt: number): void {
    if (this.state !== 'alive' || !this.torsoBody) return;
    const rot = this.torsoBody.rotation();
    _q.set(rot.x, rot.y, rot.z, rot.w);
    _bodyUp.set(0, 1, 0).applyQuaternion(_q);
    // torque axis = bodyUp x worldUp rotates the torso back to upright;
    // magnitude ~ SPRING_K * sin(tilt).
    _torque.crossVectors(_bodyUp, WORLD_UP).multiplyScalar(SPRING_K * stepDt);
    this.torsoBody.applyTorqueImpulse({ x: _torque.x, y: _torque.y, z: _torque.z }, true);
  }

  /** Copies rapier transforms onto the three meshes. Call after physics steps. */
  syncFromPhysics(): void {
    if (this.torsoBody) {
      const t = this.torsoBody.translation();
      const r = this.torsoBody.rotation();
      this.torsoGroup.position.set(
        t.x - this.group.position.x,
        t.y - this.group.position.y,
        t.z - this.group.position.z,
      );
      this.torsoGroup.quaternion.set(r.x, r.y, r.z, r.w);
    }
    for (const piece of this.debrisPieces) {
      const t = piece.body.translation();
      const r = piece.body.rotation();
      piece.mesh.position.set(
        t.x - this.group.position.x,
        t.y - this.group.position.y,
        t.z - this.group.position.z,
      );
      piece.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Advances lobbing, projectiles, debris settle detection and the fade. */
  update(dt: number): void {
    // Lobbing.
    if (this.state === 'alive' && this.lobTarget) {
      this.lobTimer += dt;
      while (this.lobTimer >= this.lobInterval) {
        this.lobTimer -= this.lobInterval;
        this.lob(this.lobTarget);
      }
    }

    // Projectiles (kinematic, integrated here, no rapier bodies).
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (!p) continue;
      p.age += dt;
      if (p.age >= p.flightTime) {
        p.age = p.flightTime;
        this.placeProjectile(p);
        const landPos = p.position.clone();
        this.group.remove(p.mesh);
        this.projectiles.splice(i, 1);
        this.onProjectileArrive?.(landPos);
      } else {
        this.placeProjectile(p);
      }
    }

    // Death sequence: wait for debris to settle, then REST in place as a
    // battle scar. The manager's DEBRIS_KEEP_CAP decides when a resting
    // construct finally fades (beginFade), oldest first.
    if (this.state === 'dying') {
      this.deathAge += dt;
      if (!this.settled) {
        let allSlow = true;
        for (const piece of this.debrisPieces) {
          const lv = piece.body.linvel();
          const av = piece.body.angvel();
          if (
            lv.x * lv.x + lv.y * lv.y + lv.z * lv.z > DEBRIS_SETTLE_LINVEL2 ||
            av.x * av.x + av.y * av.y + av.z * av.z > DEBRIS_SETTLE_ANGVEL2
          ) {
            allSlow = false;
            break;
          }
        }
        if (allSlow || this.deathAge >= DEBRIS_MAX_SETTLE_SEC) {
          this.settled = true;
          this.state = 'resting';
        }
      }
    } else if (this.state === 'fading') {
      this.fadeAge += dt;
      const opacity = Math.max(0, 1 - this.fadeAge / FADE_SEC);
      for (const mat of this.materials()) mat.opacity = opacity;
      if (this.blobMat) this.blobMat.opacity = opacity;
      if (this.fadeAge >= FADE_SEC) {
        this.dispose();
      }
    }
  }

  /** Every per-construct material (fade + dispose walk this list). */
  private materials(): THREE.MeshStandardMaterial[] {
    return [
      this.strawMat,
      this.frayMat,
      this.woodMat,
      this.ropeMat,
      this.ironMat,
      this.stoneMat,
      this.coalMat,
    ];
  }

  /**
   * Start the fade-out of a dead construct's remains (the manager calls this
   * when the debris cap is exceeded, oldest first). Safe to call on a
   * still-dying construct: it fades from wherever the debris is.
   */
  beginFade(): void {
    if (this.state !== 'resting' && this.state !== 'dying') return;
    this.settled = true;
    this.state = 'fading';
    this.fadeAge = 0;
  }

  /** Full cleanup: physics bodies, meshes, geometries, materials. Idempotent. */
  dispose(): void {
    if (this.state === 'gone') return;
    const { world } = this.physics;
    if (this.joint) {
      world.removeImpulseJoint(this.joint, true);
      this.joint = null;
    }
    if (this.torsoBody) {
      world.removeRigidBody(this.torsoBody);
      this.torsoBody = null;
    }
    for (const piece of this.debrisPieces) {
      world.removeRigidBody(piece.body);
    }
    this.debrisPieces.length = 0;
    world.removeRigidBody(this.baseBody);
    this.clearProjectiles();
    this.parent.remove(this.group);
    this.group.clear();
    for (const g of this.geometries) g.dispose();
    // Materials are per construct; the canvas textures they reference are
    // the shared module cache and are intentionally NOT disposed.
    for (const mat of this.materials()) mat.dispose();
    this.blobMat?.dispose();
    this.state = 'gone';
  }
}

// ---------------------------------------------------------------------------
// ConstructManager
// ---------------------------------------------------------------------------

export class ConstructManager {
  /** Director hook: fired for every construct death with its world position. */
  onDeath: ((construct: Construct, position: THREE.Vector3) => void) | null = null;

  private readonly physics: PhysicsWorld;
  private readonly parent: THREE.Object3D;
  private list: Construct[] = [];
  private spawnCount = 0;

  constructor(physics: PhysicsWorld, parent: THREE.Object3D) {
    this.physics = physics;
    this.parent = parent;
  }

  spawn(
    anchorPos: THREE.Vector3,
    tier: ConstructTier = 1,
    hp?: number,
    floorY?: number,
    variant?: number,
  ): Construct {
    const construct: Construct = new Construct(this.physics, this.parent, anchorPos, {
      tier,
      ...(hp !== undefined ? { hp } : {}),
      ...(floorY !== undefined ? { floorY } : {}),
      // Deterministic variant: the director passes the station index; bare
      // spawns cycle the table so successive dummies still differ.
      variant: variant ?? this.spawnCount % CONSTRUCT_VARIANTS.length,
      seed: 0xd0117 + this.spawnCount * 7919,
      onDeath: (position) => {
        this.onDeath?.(construct, position);
      },
    });
    this.spawnCount++;
    this.list.push(construct);
    return construct;
  }

  /** All tracked constructs, including ones mid-death. */
  get constructs(): readonly Construct[] {
    return this.list;
  }

  /** The construct the player is currently fighting (first live one). */
  get activeConstruct(): Construct | null {
    for (const c of this.list) {
      if (c.isAlive) return c;
    }
    return null;
  }

  /**
   * Steps the physics world (fixed 60 Hz accumulator), applies per-step spring
   * torques, syncs three transforms from rapier, advances charring, debris and
   * projectiles, and drops constructs whose debris has faded out.
   */
  update(dt: number): void {
    this.physics.step(dt, (stepDt) => {
      for (const c of this.list) c.beforePhysicsStep(stepDt);
    });
    for (const c of this.list) {
      c.syncFromPhysics();
      c.update(dt);
    }
    this.enforceDebrisCap();
    if (this.list.some((c) => c.isGone)) {
      this.list = this.list.filter((c) => !c.isGone);
    }
  }

  /**
   * Battle-scar budget (Phase 5): dead constructs rest where they fell, but
   * the total debris bodies kept alive stay near DEBRIS_KEEP_CAP. When the
   * cap is exceeded, the OLDEST resting construct begins its fade (bodies
   * are freed when the fade completes, so the overshoot lasts ~2 s at most).
   */
  private enforceDebrisCap(): void {
    // Fading constructs are already on their way out and do not count
    // toward the kept total (otherwise the cap would cascade every frame
    // until nothing remained).
    let pieces = 0;
    for (const c of this.list) {
      if (!c.isAlive && !c.isGone && !c.isFading) pieces += c.debris.length;
    }
    if (pieces <= DEBRIS_KEEP_CAP) return;
    // Fade the OLDEST kills first (list order is spawn order); a construct
    // still settling fades from wherever its debris is.
    for (const c of this.list) {
      if (pieces <= DEBRIS_KEEP_CAP) break;
      if (!c.isAlive && !c.isGone && !c.isFading) {
        pieces -= c.debris.length;
        c.beginFade();
      }
    }
  }

  /** Disposes every construct. Does not dispose the shared physics world. */
  dispose(): void {
    for (const c of this.list) c.dispose();
    this.list = [];
  }
}
