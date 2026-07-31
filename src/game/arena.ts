// Arena environment (Phase 5): the ember courtyard. An Edo-period timber
// training compound around an open courtyard: a south entry porch with heavy
// oxblood columns, a colonnade run along the west side, a spirit gate (two
// heavy posts under a double lintel with a subtle top curve) on the east, a
// raised stone terrace reached past broad steps in the northeast, a dry coal
// channel crossing the north half with a short railed timber bridge over it,
// and a lantern canopy strung over the center. The mounded coal bed on the
// far north side is still the room's key light, and behind the mid-field
// plaster walls the far rooflines silhouette into warm fog.
// All geometry is procedural and deterministic (mulberry32 only).
//
// Palette (Section 9): charcoal #1a1512, oxblood #6b1f15, vermilion #8a2f1d,
// muted antique gold #8a6a2f, parchment #d8c8a8, tatami #b09a6a. Fire is the
// only saturation. No blue anywhere.
//
// LIGHT POLICY (Phase 5, dynamic budget <= 8 total): one directional key
// (coal wall), the hemisphere whisper, and FOUR relocatable point lights
// (arena.lights.braziers) that always sit at the ACTIVE combat station
// (Arena.setActiveStation, called by the screen on travel arrival). Every
// stone brazier burns emissive-only (glowing ember fill + its flame VFX
// anchor); none carries its own light. The remaining budget (glove fill +
// two pooled fire lights) belongs to the VFX layers.
//
// Structure: buildArena composes exported deterministic builders (buildFloor,
// buildColumn / buildColumnRow, buildTimberFrame, buildColonnade,
// buildGreatGate, buildSteps, buildBridge, buildCoalChannel, buildLantern,
// buildBrazier, buildBannerRun, buildCoalWall, buildBackdrop,
// buildDustMotes). None of them touch module-level mutable state.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface ArenaLights {
  /** Warm key light shining from the coal wall toward the player. */
  key: THREE.DirectionalLight;
  /** Warm hemisphere whisper (ember bounce from below, near-black above). */
  ambient: THREE.HemisphereLight;
  /**
   * The four RELOCATABLE flickering point lights. They always pool warm
   * light around the ACTIVE station (setActiveStation); braziers themselves
   * are emissive-only. See the module header light policy.
   */
  braziers: THREE.PointLight[];
}

export interface Arena {
  group: THREE.Group;
  /** Where the player stands (the south porch). */
  playerPosition: THREE.Vector3;
  /** Where the first construct waits, ~6m into the courtyard. */
  enemyAnchor: THREE.Vector3;
  /** Reserved for the camera rig agent; not populated here. */
  travelSpline?: THREE.CatmullRomCurve3;
  lights: ArenaLights;
  /** Empty groups named "brazier-anchor-N", one per brazier bowl, for flame VFX. */
  brazierAnchors: THREE.Group[];
  /**
   * Relocate the four station point lights to combat station `index`
   * (killTravel.ts station order). Call on travel arrival.
   */
  setActiveStation(index: number): void;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

/**
 * Static physics colliders matching the raised courtyard structures, so
 * debris can rest on them (the integration layer registers these with the
 * rapier world; headless tests may skip them). [center], [halfExtents].
 */
export const COURTYARD_COLLIDERS: ReadonlyArray<{
  center: [number, number, number];
  halfExtents: [number, number, number];
}> = [
  // Terrace platform (northeast).
  { center: [6.4, 0.45, -17.0], halfExtents: [3.0, 0.45, 2.4] },
  // Broad steps down the terrace's south edge.
  { center: [6.4, 0.3375, -14.35], halfExtents: [2.25, 0.3375, 0.25] },
  { center: [6.4, 0.225, -13.85], halfExtents: [2.25, 0.225, 0.25] },
  { center: [6.4, 0.1125, -13.35], halfExtents: [2.25, 0.1125, 0.25] },
  // Bridge deck over the coal channel.
  { center: [-3.5, 0.25, -15.0], halfExtents: [0.85, 0.25, 2.1] },
];

/**
 * Where the four relocatable point lights sit for each station (index
 * matches killTravel.ts STATIONS). Authored around each station's framing
 * braziers and lanterns.
 */
export const STATION_LIGHT_SLOTS: ReadonlyArray<
  ReadonlyArray<[number, number, number]>
> = [
  // 0 entry-hall
  [
    [-2.6, 1.75, -2.8],
    [2.6, 1.75, -2.8],
    [-2.2, 2.6, -5.4],
    [2.2, 2.6, -5.4],
  ],
  // 1 colonnade
  [
    [-6.2, 1.75, -9.0],
    [-6.2, 1.75, -12.0],
    [-3.6, 2.4, -10.2],
    [-4.9, 3.2, -8.0],
  ],
  // 2 terrace-vantage
  [
    [-0.2, 1.9, -11.4],
    [3.4, 1.8, -13.4],
    [4.9, 2.7, -16.6],
    [1.0, 2.6, -13.8],
  ],
  // 3 bridge-deck
  [
    [-1.6, 1.75, -12.3],
    [-3.5, 2.0, -14.2],
    [-3.5, 2.0, -16.2],
    [-5.6, 1.7, -13.2],
  ],
  // 4 great-gate
  [
    [6.8, 1.75, -2.6],
    [6.8, 1.75, -9.4],
    [4.4, 2.2, -6.0],
    [7.2, 3.9, -6.0],
  ],
  // 5 channel-edge
  [
    [-6.6, 1.6, -15.4],
    [-8.2, 1.8, -18.6],
    [-4.6, 1.5, -17.0],
    [-5.8, 2.4, -19.6],
  ],
];

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const OXBLOOD = 0x6b1f15;
/** Darkened vermilion for structural timber (fire is the only saturation). */
const VERMILION_TIMBER = 0x6e2318;
/** Muted antique gold (Section 9): trim accents and the banner band. */
const GOLD = 0x8a6a2f;
const PARCHMENT = 0xd8c8a8;
const TATAMI = 0xb09a6a;
const STONE = 0x46392c;
const DARK_WOOD = 0x211712;
const PLASTER = 0x352718;
const FOG_TONE = 0x241610;
/** Sky/void: darker than the fog asymptote so fogged shapes read against it. */
const BACKDROP_TONE = 0x140c07;
const EMBER_ORANGE = 0xe8551c;
const FIRELIGHT = 0xff8a3c;

// Base geometry. Player stands near z = 0; the courtyard opens toward -z.
// LANE_LENGTH survives only as the default depth for standalone builders.
const LANE_LENGTH = 20;
const COLUMN_X = 3.6;
const SHAFT_HEIGHT = 4.1;
/** Top of the bracket capital above the floor (plinth + shaft + bracket). */
const COLUMN_TOP = 0.44 + SHAFT_HEIGHT + 0.62;

// ---------------------------------------------------------------------------
// Deterministic pseudo-random (keeps tests and layout stable)
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
// Canvas texture helpers (return null in headless node, callers fall back to
// flat colors so the module stays testable without a DOM)
// ---------------------------------------------------------------------------

function make2d(w: number, h = w): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext('2d');
}

function canvasTexture(ctx: CanvasRenderingContext2D, repeat?: [number, number]): THREE.Texture {
  const tex = new THREE.CanvasTexture(ctx.canvas);
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Vertical wavy wood grain, near-white multiplier so material color leads. */
function makeWoodGrainTexture(seed: number): THREE.Texture | null {
  const ctx = make2d(128);
  if (!ctx) return null;
  const rng = mulberry32(seed);
  ctx.fillStyle = '#d4cabc';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 46; i++) {
    const x0 = rng() * 128;
    const drift = (rng() - 0.5) * 10;
    const dark = rng() < 0.22;
    ctx.strokeStyle = dark ? 'rgba(52, 34, 22, 0.28)' : 'rgba(84, 60, 38, 0.14)';
    ctx.lineWidth = dark ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.bezierCurveTo(x0 + drift, 42, x0 - drift, 86, x0 + drift * 0.6, 128);
    ctx.stroke();
  }
  return canvasTexture(ctx, [1, 2]);
}

/** Subtle plaster tooth: warm speckle noise, near-white multiplier. */
function makePlasterTexture(seed: number): THREE.Texture | null {
  const ctx = make2d(128);
  if (!ctx) return null;
  const rng = mulberry32(seed);
  ctx.fillStyle = '#d0c6b8';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 520; i++) {
    const light = rng() < 0.4;
    ctx.fillStyle = light ? 'rgba(240, 228, 208, 0.07)' : 'rgba(40, 28, 18, 0.07)';
    const s = 1 + rng() * 4;
    ctx.fillRect(rng() * 128, rng() * 128, s, s);
  }
  return canvasTexture(ctx, [6, 2]);
}

/** Coarse stone blotches for plinths and braziers. */
function makeStoneTexture(seed: number): THREE.Texture | null {
  const ctx = make2d(128);
  if (!ctx) return null;
  const rng = mulberry32(seed);
  ctx.fillStyle = '#cfc6b8';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 130; i++) {
    const light = rng() < 0.35;
    ctx.fillStyle = light ? 'rgba(235, 224, 200, 0.10)' : 'rgba(30, 22, 14, 0.12)';
    ctx.beginPath();
    ctx.ellipse(rng() * 128, rng() * 128, 2 + rng() * 7, 2 + rng() * 5, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvasTexture(ctx, [2, 2]);
}

/**
 * Paper lantern skin: warm internal glow that falls off toward the dark top
 * and bottom, horizontal rib bands, dark cap/base zones baked into the ends.
 */
function makeLanternTexture(): THREE.Texture | null {
  const ctx = make2d(64, 128);
  if (!ctx) return null;
  // canvas y=0 is texture v=1 (top of the lantern).
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0.0, '#1c130d'); // cap
  g.addColorStop(0.14, '#38200f');
  g.addColorStop(0.34, '#d09250');
  g.addColorStop(0.52, '#ffe0ac'); // brightest just below the middle
  g.addColorStop(0.68, '#dfa055');
  g.addColorStop(0.88, '#3c2210');
  g.addColorStop(1.0, '#1c130d'); // base ring
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 128);
  // Rib bands: darker horizontal seams where the bamboo hoops shade the paper.
  ctx.strokeStyle = 'rgba(80, 40, 16, 0.55)';
  ctx.lineWidth = 2;
  for (let y = 18; y < 112; y += 11) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(64, y);
    ctx.stroke();
  }
  // Two faint vertical paper seams.
  ctx.strokeStyle = 'rgba(120, 70, 30, 0.18)';
  ctx.lineWidth = 1;
  for (const x of [21, 43]) {
    ctx.beginPath();
    ctx.moveTo(x, 14);
    ctx.lineTo(x, 114);
    ctx.stroke();
  }
  return canvasTexture(ctx);
}

/** Soft warm radial gradient: haze planes, coal glow, dust motes. */
function makeGlowTexture(): THREE.Texture | null {
  const ctx = make2d(128);
  if (!ctx) return null;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(255, 150, 70, 0.55)');
  g.addColorStop(0.5, 'rgba(200, 100, 40, 0.22)');
  g.addColorStop(1, 'rgba(120, 60, 20, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return canvasTexture(ctx);
}

/** Vertical streaks fading upward: cheap heat shimmer above the coal bed. */
function makeShimmerTexture(seed: number): THREE.Texture | null {
  const ctx = make2d(64, 128);
  if (!ctx) return null;
  const rng = mulberry32(seed);
  ctx.clearRect(0, 0, 64, 128);
  for (let i = 0; i < 9; i++) {
    const x = 4 + rng() * 56;
    const w = 2 + rng() * 5;
    const g = ctx.createLinearGradient(0, 128, 0, 8);
    g.addColorStop(0, `rgba(255, 150, 60, ${0.16 + rng() * 0.12})`);
    g.addColorStop(1, 'rgba(255, 150, 60, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - w / 2, 0, w, 128);
  }
  return canvasTexture(ctx);
}

// ---------------------------------------------------------------------------
// Shared material kit
// ---------------------------------------------------------------------------

export interface MaterialKit {
  /** Oxblood lacquer with broad soft sheen and wood grain: columns. */
  lacquer: THREE.MeshStandardMaterial;
  /** Deep vermilion structural timber: beams, brackets. */
  beam: THREE.MeshStandardMaterial;
  /** Muted antique gold trim accents. */
  trim: THREE.MeshStandardMaterial;
  /** Warm stone: plinths, braziers. */
  stone: THREE.MeshStandardMaterial;
  /** Warm charcoal plaster: mid-field walls. */
  plaster: THREE.MeshStandardMaterial;
  /** Near-black charcoal wood: lantern caps, cords. */
  darkWood: THREE.MeshStandardMaterial;
  /** Glowing lantern paper (emissive gradient falls off toward the ends). */
  paper: THREE.MeshStandardMaterial;
  /** Shared soft radial glow sprite texture (may be null when headless). */
  glow: THREE.Texture | null;
  dispose(): void;
}

export function makeMaterialKit(seed = 0x7a11): MaterialKit {
  const rng = mulberry32(seed);
  const texSeed = (): number => Math.floor(rng() * 0xffffffff);
  const wood = makeWoodGrainTexture(texSeed());
  const plasterTex = makePlasterTexture(texSeed());
  const stoneTex = makeStoneTexture(texSeed());
  const lanternTex = makeLanternTexture();
  const glow = makeGlowTexture();

  const lacquer = new THREE.MeshStandardMaterial({
    color: OXBLOOD,
    map: wood ?? null,
    roughness: 0.34,
    metalness: 0.06,
    flatShading: true,
  });
  const beam = new THREE.MeshStandardMaterial({
    // Darkened vermilion: lit beam faces must stay lacquered timber, never
    // saturated red slabs (fire is the only saturation).
    color: VERMILION_TIMBER,
    map: wood ?? null,
    roughness: 0.82,
    metalness: 0.04,
    flatShading: true,
  });
  const trim = new THREE.MeshStandardMaterial({
    color: GOLD,
    roughness: 0.42,
    metalness: 0.65,
    flatShading: true,
  });
  const stone = new THREE.MeshStandardMaterial({
    color: STONE,
    map: stoneTex ?? null,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
  });
  const plaster = new THREE.MeshStandardMaterial({
    color: PLASTER,
    map: plasterTex ?? null,
    roughness: 1.0,
    metalness: 0.0,
  });
  const darkWood = new THREE.MeshStandardMaterial({
    color: DARK_WOOD,
    roughness: 0.9,
    metalness: 0.0,
    flatShading: true,
  });
  const paper = lanternTex
    ? new THREE.MeshStandardMaterial({
        color: 0xf0e2c4,
        map: lanternTex,
        emissive: 0xffa860,
        emissiveMap: lanternTex,
        emissiveIntensity: 1.35,
        roughness: 0.9,
        metalness: 0.0,
      })
    : new THREE.MeshStandardMaterial({
        color: PARCHMENT,
        emissive: 0xd8863a,
        emissiveIntensity: 0.8,
        roughness: 0.9,
      });

  const textures = [wood, plasterTex, stoneTex, lanternTex, glow];
  const materials = [lacquer, beam, trim, stone, plaster, darkWood, paper];
  return {
    lacquer,
    beam,
    trim,
    stone,
    plaster,
    darkWood,
    paper,
    glow,
    dispose(): void {
      for (const m of materials) m.dispose();
      for (const t of textures) t?.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function mergedBoxes(
  boxes: Array<{ w: number; h: number; d: number; x: number; y: number; z: number }>,
): THREE.BufferGeometry {
  const parts = boxes.map(({ w, h, d, x, y, z }) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g;
  });
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged ?? new THREE.BoxGeometry(0.1, 0.1, 0.1);
}

interface ColumnGeometries {
  plinth: THREE.BufferGeometry;
  shaft: THREE.BufferGeometry;
  bands: THREE.BufferGeometry;
  bracket: THREE.BufferGeometry;
}

/**
 * Part geometries for one Edo timber column, in column-local space with the
 * origin at floor level: stepped stone plinth, tapered shaft (subtle entasis),
 * two thin gold bands, and an interlocking bracket capital.
 */
function makeColumnGeometries(shaftHeight = SHAFT_HEIGHT, baseRadius = 0.34): ColumnGeometries {
  // Stepped plinth: two square steps and an octagonal drum, sitting ON the floor.
  const drum = new THREE.CylinderGeometry(baseRadius * 1.35, baseRadius * 1.5, 0.16, 8);
  drum.translate(0, 0.36, 0);
  const steps = mergedBoxes([
    { w: 1.24, h: 0.14, d: 1.24, x: 0, y: 0.07, z: 0 },
    { w: 1.0, h: 0.14, d: 1.0, x: 0, y: 0.21, z: 0 },
  ]);
  const plinth = mergeGeometries([steps, drum], false) ?? steps;
  if (plinth !== steps) {
    steps.dispose();
  }
  drum.dispose();

  // Tapered shaft with slight entasis, faceted (low-poly lathe).
  const h = shaftHeight;
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(baseRadius, 0),
    new THREE.Vector2(baseRadius * 0.995, h * 0.22),
    new THREE.Vector2(baseRadius * 0.96, h * 0.5),
    new THREE.Vector2(baseRadius * 0.9, h * 0.78),
    new THREE.Vector2(baseRadius * 0.84, h),
  ];
  const shaft = new THREE.LatheGeometry(pts, 12);
  shaft.translate(0, 0.44, 0);

  // Thin gold accent bands: one above the plinth, one below the capital.
  const lower = new THREE.CylinderGeometry(baseRadius * 1.04, baseRadius * 1.06, 0.07, 12);
  lower.translate(0, 0.62, 0);
  const upper = new THREE.CylinderGeometry(baseRadius * 0.88, baseRadius * 0.9, 0.06, 12);
  upper.translate(0, 0.44 + h - 0.16, 0);
  const bands = mergeGeometries([lower, upper], false) ?? lower;
  if (bands !== lower) lower.dispose();
  upper.dispose();

  // Bracket capital: bearing block, two crossing arms, two cap plates.
  const top = 0.44 + h;
  const bracket = mergedBoxes([
    { w: 0.5, h: 0.2, d: 0.5, x: 0, y: top + 0.1, z: 0 },
    { w: 1.06, h: 0.16, d: 0.3, x: 0, y: top + 0.28, z: 0 },
    { w: 0.3, h: 0.16, d: 1.06, x: 0, y: top + 0.28, z: 0 },
    { w: 1.42, h: 0.13, d: 0.34, x: 0, y: top + 0.45, z: 0 },
    { w: 0.34, h: 0.13, d: 1.42, x: 0, y: top + 0.45, z: 0 },
  ]);
  return { plinth, shaft, bands, bracket };
}

// ---------------------------------------------------------------------------
// Builders (each pure: opts in, Group + handles out; no shared mutable state)
// ---------------------------------------------------------------------------

export interface ColumnOptions {
  kit?: MaterialKit;
  shaftHeight?: number;
  baseRadius?: number;
}

/**
 * One free-standing column (plinth + shaft + bands + bracket) for composers
 * that place columns individually. buildArena itself uses buildColumnRow so
 * all columns in the hall share four instanced draw calls.
 */
export function buildColumn(opts: ColumnOptions = {}): THREE.Group {
  const kit = opts.kit ?? makeMaterialKit();
  const geo = makeColumnGeometries(opts.shaftHeight, opts.baseRadius);
  const group = new THREE.Group();
  group.name = 'column';
  const plinth = new THREE.Mesh(geo.plinth, kit.stone);
  const shaft = new THREE.Mesh(geo.shaft, kit.lacquer);
  const bands = new THREE.Mesh(geo.bands, kit.trim);
  const bracket = new THREE.Mesh(geo.bracket, kit.beam);
  shaft.castShadow = true;
  shaft.receiveShadow = true;
  bracket.castShadow = true;
  group.add(plinth, shaft, bands, bracket);
  return group;
}

export interface ColumnRowOptions {
  kit: MaterialKit;
  /** World-space [x, z] for each column footprint. */
  positions: Array<[number, number]>;
  shaftHeight?: number;
  baseRadius?: number;
}

/** All hall columns as four InstancedMeshes (shafts named "columns"). */
export function buildColumnRow(opts: ColumnRowOptions): THREE.Group {
  const geo = makeColumnGeometries(opts.shaftHeight, opts.baseRadius);
  const n = opts.positions.length;
  const group = new THREE.Group();
  group.name = 'column-row';
  const shafts = new THREE.InstancedMesh(geo.shaft, opts.kit.lacquer, n);
  shafts.name = 'columns';
  const plinths = new THREE.InstancedMesh(geo.plinth, opts.kit.stone, n);
  plinths.name = 'column-plinths';
  const bands = new THREE.InstancedMesh(geo.bands, opts.kit.trim, n);
  bands.name = 'column-bands';
  const brackets = new THREE.InstancedMesh(geo.bracket, opts.kit.beam, n);
  brackets.name = 'column-brackets';
  shafts.castShadow = true;
  shafts.receiveShadow = true;
  brackets.castShadow = true;

  const dummy = new THREE.Object3D();
  opts.positions.forEach(([x, z], i) => {
    dummy.position.set(x, 0, z);
    dummy.updateMatrix();
    shafts.setMatrixAt(i, dummy.matrix);
    plinths.setMatrixAt(i, dummy.matrix);
    bands.setMatrixAt(i, dummy.matrix);
    brackets.setMatrixAt(i, dummy.matrix);
  });
  group.add(shafts, plinths, bands, brackets);
  return group;
}

export interface TimberFrameOptions {
  kit: MaterialKit;
  /** Column z stations (cross beams span the lane at each). */
  columnZs: number[];
  columnX?: number;
  /** Height of the column bracket tops the lintels rest on. */
  topY?: number;
  /** Include the low entry header beam near z ~ 0 (POV framing element). */
  entryHeader?: boolean;
}

/**
 * The hall's timber skeleton as two merged meshes: vermilion structure
 * (lintels along each column line, mid-height nuki tie beams, cross tie
 * beams at every column station, optional entry header) plus gold end-cap
 * trim accents.
 */
export function buildTimberFrame(opts: TimberFrameOptions): THREE.Group {
  const kit = opts.kit;
  const colX = opts.columnX ?? COLUMN_X;
  const topY = opts.topY ?? COLUMN_TOP;
  const zs = opts.columnZs;
  const first = zs[0] ?? 0;
  const last = zs[zs.length - 1] ?? -LANE_LENGTH;
  const span = Math.abs(last - first) + 1.4;
  const zMid = (first + last) / 2;

  const beams: Array<{ w: number; h: number; d: number; x: number; y: number; z: number }> = [];
  const trims: Array<{ w: number; h: number; d: number; x: number; y: number; z: number }> = [];

  for (const side of [-1, 1]) {
    // Lintel resting on the bracket capitals.
    beams.push({ w: 0.34, h: 0.38, d: span, x: side * colX, y: topY + 0.19, z: zMid });
    // Nuki tie beam threaded through the shafts. Slim and above head height:
    // the shot-2 camera sits at y 2.2 right beside the column line, and a fat
    // beam there filled a fifth of the frame with a flat red slab.
    beams.push({ w: 0.1, h: 0.26, d: span, x: side * colX, y: 3.0, z: zMid });
  }
  // Cross tie beams spanning the lane at each column station.
  for (const z of zs) {
    beams.push({ w: colX * 2 + 1.1, h: 0.3, d: 0.26, x: 0, y: topY + 0.53, z });
    trims.push({ w: 0.12, h: 0.34, d: 0.3, x: -colX - 0.42, y: topY + 0.53, z });
    trims.push({ w: 0.12, h: 0.34, d: 0.3, x: colX + 0.42, y: topY + 0.53, z });
  }
  if (opts.entryHeader !== false) {
    // Low entry header just ahead of the player: crosses the top of the POV
    // frame so head parallax shears something close against the mid-field.
    beams.push({ w: colX * 2 + 0.6, h: 0.3, d: 0.26, x: 0, y: 2.0, z: -0.35 });
    trims.push({ w: colX * 2 + 0.62, h: 0.05, d: 0.27, x: 0, y: 1.87, z: -0.35 });
  }

  const group = new THREE.Group();
  group.name = 'timber-frame';
  const beamMesh = new THREE.Mesh(mergedBoxes(beams), kit.beam);
  beamMesh.name = 'frame-beams';
  beamMesh.castShadow = true;
  const trimMesh = new THREE.Mesh(mergedBoxes(trims), kit.trim);
  trimMesh.name = 'frame-trim';
  group.add(beamMesh, trimMesh);
  return group;
}

export interface ColonnadeOptions {
  kit: MaterialKit;
  /** World x of the column line. */
  x: number;
  /** Column z stations along the run. */
  columnZs: number[];
  shaftHeight?: number;
  baseRadius?: number;
}

/**
 * A single-sided colonnade run: instanced columns along one line under a
 * merged lintel + slim nuki tie beam, with gold end-cap trim. The west edge
 * of the courtyard.
 */
export function buildColonnade(opts: ColonnadeOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = 'colonnade';
  const zs = opts.columnZs;
  const first = zs[0] ?? 0;
  const last = zs[zs.length - 1] ?? -10;
  const span = Math.abs(last - first) + 1.4;
  const zMid = (first + last) / 2;
  const topY = 0.44 + (opts.shaftHeight ?? SHAFT_HEIGHT) + 0.62;

  const positions: Array<[number, number]> = zs.map((z) => [opts.x, z]);
  group.add(
    buildColumnRow({
      kit: opts.kit,
      positions,
      ...(opts.shaftHeight !== undefined ? { shaftHeight: opts.shaftHeight } : {}),
      ...(opts.baseRadius !== undefined ? { baseRadius: opts.baseRadius } : {}),
    }),
  );

  const beams = mergedBoxes([
    // Lintel resting on the bracket capitals.
    { w: 0.34, h: 0.38, d: span, x: opts.x, y: topY + 0.19, z: zMid },
    // Slim nuki tie threaded through the shafts above head height.
    { w: 0.1, h: 0.26, d: span, x: opts.x, y: 3.0, z: zMid },
  ]);
  const beamMesh = new THREE.Mesh(beams, opts.kit.beam);
  beamMesh.name = 'colonnade-beams';
  beamMesh.castShadow = true;
  group.add(beamMesh);

  const trims = mergedBoxes([
    { w: 0.4, h: 0.44, d: 0.12, x: opts.x, y: topY + 0.19, z: zMid + span / 2 },
    { w: 0.4, h: 0.44, d: 0.12, x: opts.x, y: topY + 0.19, z: zMid - span / 2 },
  ]);
  const trimMesh = new THREE.Mesh(trims, opts.kit.trim);
  trimMesh.name = 'colonnade-trim';
  group.add(trimMesh);
  return group;
}

export interface GreatGateOptions {
  kit: MaterialKit;
  /** World x of the gate line (posts share it). */
  x?: number;
  /** Center z of the opening. */
  zCenter?: number;
  /** Distance between the two post centers along z. */
  span?: number;
}

/**
 * The spirit gate: two heavy lacquered posts on stone plinths carrying a
 * double lintel; the upper lintel is thicker and rises in a subtle curve
 * toward its gold-capped ends, with a short center strut between the two.
 * Torii-inspired massing, original proportions and detailing.
 */
export function buildGreatGate(opts: GreatGateOptions): THREE.Group {
  const kit = opts.kit;
  const x = opts.x ?? 7.4;
  const zc = opts.zCenter ?? -6;
  const span = opts.span ?? 4.8;
  const group = new THREE.Group();
  group.name = 'great-gate';

  const postH = 3.9;
  const postBaseY = 0.34;

  // Posts: heavy tapered lathes, merged into one geometry.
  const postProfile: THREE.Vector2[] = [
    new THREE.Vector2(0.42, 0),
    new THREE.Vector2(0.41, postH * 0.3),
    new THREE.Vector2(0.38, postH * 0.65),
    new THREE.Vector2(0.34, postH),
  ];
  const postParts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const p = new THREE.LatheGeometry(postProfile, 12);
    p.translate(x, postBaseY, zc + (side * span) / 2);
    postParts.push(p);
  }
  const postGeo = mergeGeometries(postParts, false) ?? postParts[0] ?? new THREE.BufferGeometry();
  for (const p of postParts) {
    if (p !== postGeo) p.dispose();
  }
  const posts = new THREE.Mesh(postGeo, kit.lacquer);
  posts.name = 'gate-posts';
  posts.castShadow = true;
  posts.receiveShadow = true;
  group.add(posts);

  // Stone plinths under the posts.
  const plinths = mergedBoxes([
    { w: 1.3, h: 0.34, d: 1.3, x, y: 0.17, z: zc - span / 2 },
    { w: 1.3, h: 0.34, d: 1.3, x, y: 0.17, z: zc + span / 2 },
  ]);
  const plinthMesh = new THREE.Mesh(plinths, kit.stone);
  plinthMesh.name = 'gate-plinths';
  group.add(plinthMesh);

  // Lintels: lower straight tie + upper curved beam + center strut.
  const lowY = postBaseY + postH - 0.72; // ~3.5
  const upY = postBaseY + postH + 0.14; // ~4.38 at center
  const upLen = span + 1.8;
  const segments = 9;
  const beamBoxes: Array<{ w: number; h: number; d: number; x: number; y: number; z: number }> = [
    { w: 0.3, h: 0.34, d: span + 0.7, x, y: lowY, z: zc },
    { w: 0.24, h: upY - lowY - 0.38, d: 0.3, x, y: (upY + lowY) / 2 - 0.02, z: zc },
  ];
  for (let i = 0; i < segments; i++) {
    const t = (i + 0.5) / segments; // 0..1 along the upper lintel
    const zSeg = zc - upLen / 2 + t * upLen;
    const lift = 0.34 * Math.pow(2 * t - 1, 2); // subtle rise toward the ends
    beamBoxes.push({ w: 0.5, h: 0.42, d: upLen / segments + 0.02, x, y: upY + lift, z: zSeg });
  }
  const lintels = new THREE.Mesh(mergedBoxes(beamBoxes), kit.beam);
  lintels.name = 'gate-lintels';
  lintels.castShadow = true;
  group.add(lintels);

  // Gold caps on the upper lintel ends.
  const endLift = 0.34 * Math.pow(2 * (0.5 / segments) - 1, 2);
  const caps = mergedBoxes([
    { w: 0.56, h: 0.5, d: 0.2, x, y: upY + endLift, z: zc - upLen / 2 - 0.06 },
    { w: 0.56, h: 0.5, d: 0.2, x, y: upY + endLift, z: zc + upLen / 2 + 0.06 },
  ]);
  const capMesh = new THREE.Mesh(caps, kit.trim);
  capMesh.name = 'gate-caps';
  group.add(capMesh);
  return group;
}

export interface StepsOptions {
  kit: MaterialKit;
  /** Center x of the flight. */
  x: number;
  /** z of the TOP edge (the platform lip); steps descend toward +z. */
  topZ: number;
  /** Platform height the flight descends from. */
  topY: number;
  width?: number;
  stepCount?: number;
  rise?: number;
  run?: number;
}

/** Broad stone steps descending from a raised platform edge toward +z. */
export function buildSteps(opts: StepsOptions): THREE.Group {
  const width = opts.width ?? 4.5;
  const count = opts.stepCount ?? 3;
  const rise = opts.rise ?? opts.topY / (count + 1);
  const run = opts.run ?? 0.5;
  const boxes: Array<{ w: number; h: number; d: number; x: number; y: number; z: number }> = [];
  for (let i = 1; i <= count; i++) {
    const h = Math.max(opts.topY - i * rise, 0.02);
    boxes.push({
      w: width,
      h,
      d: run,
      x: opts.x,
      y: h / 2,
      z: opts.topZ + (i - 0.5) * run,
    });
  }
  const group = new THREE.Group();
  group.name = 'steps';
  const mesh = new THREE.Mesh(mergedBoxes(boxes), opts.kit.stone);
  mesh.name = 'steps-stone';
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

export interface BridgeOptions {
  kit: MaterialKit;
  /** Center x of the deck. */
  x: number;
  zStart: number;
  zEnd: number;
  width?: number;
  deckY?: number;
}

/**
 * A short railed timber bridge: raised plank deck on two skirt supports
 * with end blocks, and lacquered rails (posts, top rail, mid rail) on both
 * sides. Crosses the dry coal channel.
 */
export function buildBridge(opts: BridgeOptions): THREE.Group {
  const kit = opts.kit;
  const width = opts.width ?? 1.7;
  const deckY = opts.deckY ?? 0.5;
  const zMid = (opts.zStart + opts.zEnd) / 2;
  const len = Math.abs(opts.zEnd - opts.zStart);
  const group = new THREE.Group();
  group.name = 'bridge';

  // Deck + supports + end blocks (dark structural timber).
  const deck = new THREE.Mesh(
    mergedBoxes([
      { w: width, h: 0.12, d: len, x: opts.x, y: deckY - 0.06, z: zMid },
      { w: width * 0.82, h: deckY - 0.12, d: 0.32, x: opts.x, y: (deckY - 0.12) / 2, z: zMid - len * 0.25 },
      { w: width * 0.82, h: deckY - 0.12, d: 0.32, x: opts.x, y: (deckY - 0.12) / 2, z: zMid + len * 0.25 },
      { w: width, h: 0.22, d: 0.5, x: opts.x, y: 0.11, z: opts.zStart + 0.25 },
      { w: width, h: 0.22, d: 0.5, x: opts.x, y: 0.11, z: opts.zEnd - 0.25 },
    ]),
    kit.darkWood,
  );
  deck.name = 'bridge-deck';
  deck.castShadow = true;
  deck.receiveShadow = true;
  group.add(deck);

  // Rails: three posts a side, a top rail and a mid rail (oxblood lacquer).
  const railBoxes: Array<{ w: number; h: number; d: number; x: number; y: number; z: number }> = [];
  for (const side of [-1, 1]) {
    const rx = opts.x + (side * (width - 0.12)) / 2;
    for (const z of [opts.zStart + 0.18, zMid, opts.zEnd - 0.18]) {
      railBoxes.push({ w: 0.1, h: 1.02, d: 0.1, x: rx, y: deckY + 0.51, z });
    }
    railBoxes.push({ w: 0.08, h: 0.08, d: len, x: rx, y: deckY + 1.02, z: zMid });
    railBoxes.push({ w: 0.06, h: 0.06, d: len - 0.3, x: rx, y: deckY + 0.55, z: zMid });
  }
  const rails = new THREE.Mesh(mergedBoxes(railBoxes), kit.lacquer);
  rails.name = 'bridge-rails';
  rails.castShadow = true;
  group.add(rails);
  return group;
}

export interface LanternOptions {
  kit?: MaterialKit;
  /** Body radius in meters (paper lanterns run ~0.125..0.23). */
  radius?: number;
  /** Cord length from the attachment origin down to the lantern cap. */
  hangLength?: number;
  seed?: number;
}

/**
 * A ribbed paper lantern hanging from its cord. Group origin is the beam
 * attachment point; the body hangs below it. Two meshes: glowing ribbed
 * lathe body (dark cap/base baked into the gradient texture) and the dark
 * cord + cap hardware.
 */
export function buildLantern(opts: LanternOptions = {}): THREE.Group {
  const kit = opts.kit ?? makeMaterialKit();
  const rng = mulberry32(opts.seed ?? 0xa11ce);
  const r = opts.radius ?? 0.14 + rng() * 0.09;
  const hang = opts.hangLength ?? 0.5 + rng() * 0.8;
  const h = r * 2.4;

  // Ribbed ellipsoid profile: scalloped silhouette, pinched dark ends.
  const pts: THREE.Vector2[] = [new THREE.Vector2(r * 0.2, 0), new THREE.Vector2(r * 0.42, h * 0.03)];
  const bodyPts = 20;
  for (let k = 0; k <= bodyPts; k++) {
    const t = k / bodyPts;
    const y = h * (0.06 + 0.88 * t);
    const shape = Math.pow(Math.sin(Math.PI * (0.06 + 0.88 * t)), 0.6);
    const rib = 1 + 0.05 * Math.sin(t * Math.PI * 10);
    pts.push(new THREE.Vector2(Math.max(r * shape * rib, r * 0.3), y));
  }
  pts.push(new THREE.Vector2(r * 0.4, h * 0.985), new THREE.Vector2(r * 0.18, h));
  const bodyGeo = new THREE.LatheGeometry(pts, 14);
  bodyGeo.translate(0, -hang - h, 0);

  const group = new THREE.Group();
  group.name = 'lantern';
  const body = new THREE.Mesh(bodyGeo, kit.paper);
  body.name = 'lantern-body';
  body.rotation.y = rng() * Math.PI;
  group.add(body);

  // Cord + top cap disc + base ring, one dark merged mesh.
  const cord = new THREE.CylinderGeometry(0.008, 0.008, hang, 5);
  cord.translate(0, -hang / 2, 0);
  const cap = new THREE.CylinderGeometry(r * 0.24, r * 0.3, 0.035, 10);
  cap.translate(0, -hang + 0.01, 0);
  const ring = new THREE.CylinderGeometry(r * 0.26, r * 0.22, 0.03, 10);
  ring.translate(0, -hang - h - 0.01, 0);
  const hardwareGeo = mergeGeometries([cord, cap, ring], false) ?? cord;
  if (hardwareGeo !== cord) cord.dispose();
  cap.dispose();
  ring.dispose();
  const hardware = new THREE.Mesh(hardwareGeo, kit.darkWood);
  hardware.name = 'lantern-hardware';
  group.add(hardware);
  return group;
}

export interface BrazierOptions {
  kit?: MaterialKit;
  /** Index used for the anchor / light names. */
  index?: number;
  /**
   * Attach a point light (default true for standalone use). buildArena
   * passes false: braziers burn emissive-only and the four relocatable
   * station lights follow the active station instead (see module header).
   */
  light?: boolean;
}

export interface BrazierBuild {
  group: THREE.Group;
  /** Null when opts.light is false (emissive-only brazier). */
  light: THREE.PointLight | null;
  /** Empty group at the flame seat, named "brazier-anchor-N". */
  anchor: THREE.Group;
}

/** Stone brazier: merged pedestal+bowl mesh, glowing ember fill, flame
 *  anchor, and (optionally) a point light. */
export function buildBrazier(opts: BrazierOptions = {}): BrazierBuild {
  const kit = opts.kit ?? makeMaterialKit();
  const index = opts.index ?? 0;
  const group = new THREE.Group();
  group.name = `brazier-${index}`;

  const pedestal = new THREE.CylinderGeometry(0.26, 0.44, 1.0, 8);
  pedestal.translate(0, 0.5, 0);
  const bowl = new THREE.CylinderGeometry(0.56, 0.3, 0.32, 8);
  bowl.translate(0, 1.14, 0);
  const lip = new THREE.CylinderGeometry(0.6, 0.56, 0.09, 8);
  lip.translate(0, 1.33, 0);
  const merged = mergeGeometries([pedestal, bowl, lip], false) ?? pedestal;
  if (merged !== pedestal) pedestal.dispose();
  bowl.dispose();
  lip.dispose();
  const mesh = new THREE.Mesh(merged, kit.stone);
  mesh.name = 'brazier-stone';
  mesh.castShadow = true;
  group.add(mesh);

  // Glowing ember fill so an unlit brazier still reads as burning.
  const emberGeo = new THREE.CylinderGeometry(0.44, 0.3, 0.14, 8);
  emberGeo.translate(0, 1.3, 0);
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0x1a0d06,
    emissive: EMBER_ORANGE,
    emissiveIntensity: 1.7,
    roughness: 0.95,
    flatShading: true,
  });
  const embers = new THREE.Mesh(emberGeo, emberMat);
  embers.name = 'brazier-embers';
  group.add(embers);

  let light: THREE.PointLight | null = null;
  if (opts.light !== false) {
    light = new THREE.PointLight(FIRELIGHT, 3.4, 9.5, 2);
    light.name = `brazier-light-${index}`;
    light.position.set(0, 1.75, 0);
    group.add(light);
  }

  const anchor = new THREE.Group();
  anchor.name = `brazier-anchor-${index}`;
  anchor.position.set(0, 1.4, 0);
  group.add(anchor);

  return { group, light, anchor };
}

export interface BannerRunOptions {
  /** Hanging positions: world x/z of the rod center plus yaw. */
  slots: Array<{ x: number; z: number; rotY: number }>;
  /** Rod height the cloth hangs from. */
  topY?: number;
  width?: number;
  height?: number;
}

export interface BannerRunBuild {
  group: THREE.Group;
  material: THREE.ShaderMaterial;
  uTime: THREE.IUniform<number>;
}

/**
 * Oxblood cloth banners with a muted antique-gold band, vertex sway, a slight
 * center sag and a frayed hem (deterministic per-strip discard).
 */
export function buildBannerRun(opts: BannerRunOptions): BannerRunBuild {
  const uTime: THREE.IUniform<number> = { value: 0 };
  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib['fog']),
    uTime,
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec3 p = position;
        // Top edge (uv.y = 1) is pinned, the free hem sways the most.
        float weight = 1.0 - uv.y;
        float phase = modelMatrix[3][0] * 1.7 + modelMatrix[3][2] * 0.9;
        p.x += sin(uTime * 1.4 + phase + uv.y * 2.4) * 0.085 * weight;
        p.z += cos(uTime * 1.1 + phase * 1.3 + uv.y * 1.9) * 0.05 * weight;
        // Slight sag: the hem center hangs lower than the pinned corners.
        p.y -= sin(uv.x * 3.14159) * 0.07 * weight;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      #include <fog_pars_fragment>
      void main() {
        // Frayed hem: deterministic ragged strips torn off the bottom edge.
        float strip = floor(vUv.x * 13.0);
        float tear = fract(sin(strip * 12.9898) * 43758.5453);
        if (vUv.y < tear * 0.055 + 0.012) discard;
        // Deep oxblood cloth, darker toward the hem.
        vec3 col = vec3(0.337, 0.086, 0.063);
        // Single muted antique-gold band near the hem. No lettering.
        float band = step(0.16, vUv.y) - step(0.27, vUv.y);
        col = mix(col, vec3(0.541, 0.416, 0.184), clamp(band, 0.0, 1.0));
        col *= 0.7 + 0.3 * vUv.y;
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }
    `,
  });

  const group = new THREE.Group();
  group.name = 'banner-run';
  const width = opts.width ?? 1.4;
  const height = opts.height ?? 2.4;
  const topY = opts.topY ?? COLUMN_TOP + 0.05;
  const geo = new THREE.PlaneGeometry(width, height, 8, 14);
  geo.translate(0, -height / 2, 0); // pin the top edge at the mesh origin
  opts.slots.forEach(({ x, z, rotY }, i) => {
    const banner = new THREE.Mesh(geo, material);
    banner.name = `banner-${i}`;
    banner.position.set(x, topY, z);
    banner.rotation.y = rotY;
    group.add(banner);
  });
  return { group, material, uTime };
}

/**
 * Shared coal-lump piece (coal wall AND coal channel): three emissive tiers
 * of instanced dodecahedron lumps (hot core, mid, ash crust). `sample` is
 * called `count` times with the rng and returns a world position plus a heat
 * value in [0, 1]; rotation and scale jitter come from the same rng, so the
 * result is deterministic per seed.
 */
function buildCoalLumps(
  rng: () => number,
  count: number,
  sample: (rng: () => number) => { x: number; y: number; z: number; heat: number },
): { group: THREE.Group; hotMat: THREE.MeshStandardMaterial } {
  const coalGeo = new THREE.DodecahedronGeometry(0.21, 0);
  const hotMat = new THREE.MeshStandardMaterial({
    color: 0x1a0d06,
    emissive: EMBER_ORANGE,
    emissiveIntensity: 2.6,
    roughness: 0.85,
    flatShading: true,
  });
  const midMat = new THREE.MeshStandardMaterial({
    color: 0x1f120a,
    emissive: 0xb03a10,
    emissiveIntensity: 1.0,
    roughness: 0.9,
    flatShading: true,
  });
  const ashMat = new THREE.MeshStandardMaterial({
    color: 0x241a12,
    emissive: 0x481505,
    emissiveIntensity: 0.4,
    roughness: 1.0,
    flatShading: true,
  });

  const placements: Array<{ tier: 0 | 1 | 2; m: THREE.Matrix4 }> = [];
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const s0 = sample(rng);
    const tier: 0 | 1 | 2 = s0.heat > 0.62 ? 0 : s0.heat > 0.34 ? 1 : 2;
    dummy.position.set(s0.x, s0.y, s0.z);
    dummy.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    const s = 0.75 + rng() * 0.85;
    dummy.scale.set(s, s * (0.75 + rng() * 0.4), s);
    dummy.updateMatrix();
    placements.push({ tier, m: dummy.matrix.clone() });
  }
  const group = new THREE.Group();
  group.name = 'coal-lumps';
  const tiers: Array<{ mat: THREE.MeshStandardMaterial; name: string }> = [
    { mat: hotMat, name: 'coals-hot' },
    { mat: midMat, name: 'coals-mid' },
    { mat: ashMat, name: 'coals-ash' },
  ];
  tiers.forEach((tier, ti) => {
    const items = placements.filter((p) => p.tier === ti);
    const mesh = new THREE.InstancedMesh(coalGeo, tier.mat, Math.max(items.length, 1));
    mesh.name = tier.name;
    items.forEach((p, i) => mesh.setMatrixAt(i, p.m));
    if (items.length === 0) mesh.count = 0;
    group.add(mesh);
  });
  return { group, hotMat };
}

export interface CoalWallOptions {
  kit: MaterialKit;
  seed?: number;
  width?: number;
  z?: number;
}

export interface CoalWallBuild {
  group: THREE.Group;
  update(dt: number, elapsed: number): void;
}

/**
 * The arena's key-light source: a low mounded bed of coals. Ash-dark mound,
 * three instanced coal tiers (hot core low, ash-crusted tops), a broad soft
 * glow and a slow-pulsing heat shimmer.
 */
export function buildCoalWall(opts: CoalWallOptions): CoalWallBuild {
  const rng = mulberry32(opts.seed ?? 0xc0a1);
  const width = opts.width ?? 10.4;
  const wallZ = opts.z ?? -21.6;
  const group = new THREE.Group();
  group.name = 'coal-wall';

  // Ash mound understructure, half sunk into the floor.
  const moundGeo = new THREE.SphereGeometry(1, 12, 7);
  moundGeo.scale(width * 0.55, 0.95, 1.5);
  const moundMat = new THREE.MeshStandardMaterial({
    color: 0x171008,
    emissive: 0x48180a,
    emissiveIntensity: 0.6,
    roughness: 1.0,
    flatShading: true,
  });
  const mound = new THREE.Mesh(moundGeo, moundMat);
  mound.name = 'coal-mound';
  mound.position.set(0, -0.05, wallZ);
  group.add(mound);

  // Coal lumps in three emissive tiers (shared piece with the channel).
  // Hot core low in the mound center, ash crust on top and at the edges.
  const lumps = buildCoalLumps(rng, 84, (r) => {
    const u = r() * 2 - 1; // -1..1 across the mound
    const x = u * width * 0.5;
    const crest = 0.9 * Math.sqrt(Math.max(1 - u * u * 0.85, 0.05));
    const hf = r(); // 0 floor .. 1 crest
    const y = 0.12 + hf * crest;
    const z = wallZ + (r() - 0.5) * (1.5 - hf);
    const heat = (1 - hf) * (1 - Math.abs(u) * 0.6) + r() * 0.25;
    return { x, y, z, heat };
  });
  const hotMat = lumps.hotMat;
  group.add(lumps.group);

  // Broad soft under-glow toward the lane: linear vertical falloff with
  // feathered sides (a radial sprite here painted a hard dome arch rim over
  // the bed from the POV camera).
  const glowCtx = make2d(64);
  let glowTex: THREE.Texture | null = null;
  if (glowCtx) {
    const vg = glowCtx.createLinearGradient(0, 64, 0, 0);
    vg.addColorStop(0, 'rgba(255, 150, 70, 0.6)');
    vg.addColorStop(0.45, 'rgba(220, 110, 45, 0.22)');
    vg.addColorStop(1, 'rgba(120, 60, 20, 0)');
    glowCtx.clearRect(0, 0, 64, 64);
    glowCtx.fillStyle = vg;
    glowCtx.fillRect(0, 0, 64, 64);
    // Feather the side edges so the plane never shows a vertical seam.
    for (const [x0, x1] of [
      [0, 12],
      [64, 52],
    ] as const) {
      const hg = glowCtx.createLinearGradient(x0, 0, x1, 0);
      hg.addColorStop(0, 'rgba(0, 0, 0, 1)');
      hg.addColorStop(1, 'rgba(0, 0, 0, 0)');
      glowCtx.globalCompositeOperation = 'destination-out';
      glowCtx.fillStyle = hg;
      glowCtx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), 64);
      glowCtx.globalCompositeOperation = 'source-over';
    }
    glowTex = canvasTexture(glowCtx);
  }
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xff7828,
    map: glowTex,
    transparent: true,
    opacity: glowTex ? 0.34 : 0.14,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const glowGeo = new THREE.PlaneGeometry(width + 6, 2.8);
  const glowPlane = new THREE.Mesh(glowGeo, glowMat);
  glowPlane.name = 'coal-glow';
  glowPlane.position.set(0, 0.7, wallZ + 1.4);
  glowPlane.renderOrder = 9;
  group.add(glowPlane);

  // Heat shimmer: vertical streaks slowly pulsing above the crest.
  const shimmerTex = makeShimmerTexture((opts.seed ?? 0xc0a1) ^ 0x5a5a);
  const shimmerMat = new THREE.MeshBasicMaterial({
    color: 0xff9040,
    map: shimmerTex,
    transparent: true,
    opacity: shimmerTex ? 0.16 : 0.06,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const shimmerGeo = new THREE.PlaneGeometry(width * 0.55, 2.6);
  const shimmer = new THREE.Mesh(shimmerGeo, shimmerMat);
  shimmer.name = 'coal-shimmer';
  shimmer.position.set(0, 1.9, wallZ + 0.4);
  shimmer.renderOrder = 9;
  group.add(shimmer);

  const shimmerBase = shimmerMat.opacity;
  const update = (_dt: number, elapsed: number): void => {
    shimmerMat.opacity = shimmerBase * (0.72 + 0.28 * Math.sin(elapsed * 1.9));
    shimmer.position.y = 1.9 + 0.1 * Math.sin(elapsed * 0.9);
    // The hot core seethes slowly.
    hotMat.emissiveIntensity = 2.6 + 0.4 * Math.sin(elapsed * 2.3);
  };
  return { group, update };
}

export interface CoalChannelOptions {
  kit: MaterialKit;
  seed?: number;
  xStart?: number;
  xEnd?: number;
  /** Center z of the channel strip. */
  z?: number;
  /** z-extent of the coal bed between the curbs. */
  width?: number;
}

export interface CoalChannelBuild {
  group: THREE.Group;
  update(dt: number, elapsed: number): void;
}

/**
 * The dry coal channel: a curbed east-west strip of banked coals crossing
 * the courtyard's north half, glowing under the bridge. Reuses the coal-bed
 * lump piece (buildCoalLumps) plus stone curbs and a soft lying glow plane.
 */
export function buildCoalChannel(opts: CoalChannelOptions): CoalChannelBuild {
  const rng = mulberry32(opts.seed ?? 0xc4a2);
  const xStart = opts.xStart ?? -9.5;
  const xEnd = opts.xEnd ?? 2.5;
  const zC = opts.z ?? -15.0;
  const width = opts.width ?? 1.6;
  const len = xEnd - xStart;
  const xMid = (xStart + xEnd) / 2;
  const group = new THREE.Group();
  group.name = 'coal-channel';

  // Stone curbs along both edges plus an east end cap.
  const curbs = new THREE.Mesh(
    mergedBoxes([
      { w: len, h: 0.22, d: 0.3, x: xMid, y: 0.11, z: zC - width / 2 - 0.15 },
      { w: len, h: 0.22, d: 0.3, x: xMid, y: 0.11, z: zC + width / 2 + 0.15 },
      { w: 0.3, h: 0.22, d: width + 0.6, x: xEnd + 0.15, y: 0.11, z: zC },
    ]),
    opts.kit.stone,
  );
  curbs.name = 'channel-curbs';
  curbs.receiveShadow = true;
  group.add(curbs);

  // Banked coals: hotter toward the middle of the run and the strip center.
  const lumps = buildCoalLumps(rng, 46, (r) => {
    const u = r(); // 0..1 along the run
    const x = xStart + 0.4 + u * (len - 0.8);
    const v = r() * 2 - 1; // -1..1 across the strip
    const y = 0.06 + r() * 0.16;
    const z = zC + v * width * 0.36;
    const heat = (1 - Math.abs(v) * 0.5) * (0.55 + 0.45 * Math.sin(u * Math.PI)) + r() * 0.2;
    return { x, y, z, heat };
  });
  const hotMat = lumps.hotMat;
  group.add(lumps.group);

  // Soft glow lying over the strip.
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xff7828,
    map: opts.kit.glow,
    transparent: true,
    opacity: opts.kit.glow ? 0.32 : 0.12,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(len + 1, width + 1.6), glowMat);
  glow.name = 'channel-glow';
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(xMid, 0.34, zC);
  glow.renderOrder = 9;
  group.add(glow);

  const update = (_dt: number, elapsed: number): void => {
    // Breathes out of phase with the coal wall so the two beds read alive.
    hotMat.emissiveIntensity = 2.4 + 0.5 * Math.sin(elapsed * 1.7 + 1.9);
    glowMat.opacity = (opts.kit.glow ? 0.32 : 0.12) * (0.8 + 0.2 * Math.sin(elapsed * 1.3));
  };
  return { group, update };
}

export interface BackdropOptions {
  kit: MaterialKit;
  seed?: number;
}

/**
 * Depth layers past the hall: warm charcoal plaster side walls (mid-field)
 * and two far roofline silhouette planes pre-tinted toward the fog color so
 * they read as architecture dissolving into warm haze, never a cool void.
 */
export function buildBackdrop(opts: BackdropOptions): THREE.Group {
  const kit = opts.kit;
  const group = new THREE.Group();
  group.name = 'backdrop';

  // Mid-field plaster walls with subtle tooth (courtyard perimeter).
  const wallGeo = new THREE.PlaneGeometry(34, 7.5);
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(wallGeo, kit.plaster);
    wall.name = `plaster-wall-${side < 0 ? 'l' : 'r'}`;
    wall.position.set(side * 10.8, 3.4, -10.5);
    wall.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    wall.receiveShadow = true;
    group.add(wall);
  }
  // End wall behind the player so shot reverses never see raw void.
  const endWall = new THREE.Mesh(wallGeo, kit.plaster);
  endWall.name = 'plaster-wall-end';
  endWall.position.set(0, 3.4, 4.6);
  endWall.rotation.y = Math.PI;
  group.add(endWall);

  // Far rooflines: silhouetted gate / hall profiles, hand-tinted pre-fogged.
  const makeRoofline = (
    seed: number,
    w: number,
    h: number,
    tint: number,
    name: string,
  ): THREE.Mesh => {
    const ctx = make2d(256, 96);
    let tex: THREE.Texture | null = null;
    if (ctx) {
      const rng = mulberry32(seed);
      ctx.clearRect(0, 0, 256, 96);
      ctx.fillStyle = '#ffffff';
      // A run of hipped roof profiles: straight shallow slopes to a broad
      // flat ridge (curved profiles here read as a giant dome at distance),
      // small eave kick tips, narrower wall masses, ridge blocks on top.
      let x = 0;
      while (x < 256) {
        const bw = 36 + rng() * 44;
        const base = 96;
        const ridgeY = 40 + rng() * 18;
        const eaveY = ridgeY + 12 + rng() * 8;
        const overhang = bw * 0.12;
        // Wall mass (narrower than the eaves).
        ctx.fillRect(x + overhang, eaveY, bw - overhang * 2, base - eaveY);
        // Roof: straight slopes, wide flat ridge, tiny upturned eave tips.
        ctx.beginPath();
        ctx.moveTo(x, eaveY + 2);
        ctx.lineTo(x + bw * 0.28, ridgeY);
        ctx.lineTo(x + bw * 0.72, ridgeY);
        ctx.lineTo(x + bw, eaveY + 2);
        ctx.lineTo(x + bw, eaveY + 8);
        ctx.lineTo(x, eaveY + 8);
        ctx.closePath();
        ctx.fill();
        // Ridge finial block.
        ctx.fillRect(x + bw * 0.4, ridgeY - 5, bw * 0.2, 5);
        x += bw + 10 + rng() * 18;
      }
      tex = canvasTexture(ctx);
    }
    const mat = new THREE.MeshBasicMaterial({
      color: tint,
      map: tex,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      fog: false,
    });
    if (!tex) mat.opacity = 0.65;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.name = name;
    return mesh;
  };

  const seed = opts.seed ?? 0xf09;
  const near = makeRoofline(seed, 34, 5.2, 0x1d100a, 'roofline-near');
  near.position.set(0, 2.5, -27);
  near.renderOrder = 1;
  const far = makeRoofline(seed ^ 0x77, 44, 7.2, 0x2b1810, 'roofline-far');
  far.position.set(0, 3.6, -31);
  far.renderOrder = 0;
  group.add(near, far);
  return group;
}

export interface FloorOptions {
  kit?: MaterialKit;
  seed?: number;
  width?: number;
  length?: number;
  /** World z of the floor center. */
  centerZ?: number;
}

/**
 * Worn broad-plank floor in tatami tan: per-plank tone variation, grain and
 * butt joints in a repeating canvas tile, plus a baked vignette overlay that
 * darkens toward the walls. No grid lines.
 */
export function buildFloor(opts: FloorOptions = {}): THREE.Group {
  const seed = opts.seed ?? 0xf100;
  const width = opts.width ?? 24;
  const length = opts.length ?? 32;
  const centerZ = opts.centerZ ?? -(LANE_LENGTH / 2) + 2;
  const group = new THREE.Group();
  group.name = 'floor';

  // Plank tile: planks run along z (canvas vertical strips).
  const makePlankTexture = (): THREE.Texture | null => {
    const ctx = make2d(256);
    if (!ctx) return null;
    const rng = mulberry32(seed);
    ctx.fillStyle = '#b09a6a';
    ctx.fillRect(0, 0, 256, 256);
    const planks = 5;
    const pw = 256 / planks;
    for (let p = 0; p < planks; p++) {
      const x0 = p * pw;
      // Per-plank tone variation.
      const tone = (rng() - 0.5) * 0.16;
      ctx.fillStyle =
        tone > 0
          ? `rgba(232, 210, 160, ${tone})`
          : `rgba(52, 38, 20, ${-tone})`;
      ctx.fillRect(x0, 0, pw, 256);
      // Long grain streaks.
      for (let gI = 0; gI < 7; gI++) {
        const gx = x0 + 4 + rng() * (pw - 8);
        const drift = (rng() - 0.5) * 6;
        ctx.strokeStyle = `rgba(74, 56, 30, ${0.10 + rng() * 0.1})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.bezierCurveTo(gx + drift, 80, gx - drift, 170, gx + drift, 256);
        ctx.stroke();
      }
      // A knot now and then.
      if (rng() < 0.6) {
        const kx = x0 + pw * (0.25 + rng() * 0.5);
        const ky = rng() * 256;
        ctx.fillStyle = 'rgba(58, 42, 22, 0.5)';
        ctx.beginPath();
        ctx.ellipse(kx, ky, 2.5 + rng() * 2, 1.5 + rng(), 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // Butt joint at a staggered height.
      const jy = 256 * ((p * 0.37 + rng() * 0.3) % 1);
      ctx.strokeStyle = 'rgba(44, 32, 16, 0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0 + 1, jy);
      ctx.lineTo(x0 + pw - 1, jy);
      ctx.stroke();
      // Plank seam.
      ctx.strokeStyle = 'rgba(40, 29, 15, 0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0, 256);
      ctx.stroke();
    }
    return canvasTexture(ctx, [4, 5]);
  };

  const plankTex = makePlankTexture();
  const floorMat = new THREE.MeshStandardMaterial({
    color: plankTex ? 0xc4b28a : TATAMI,
    map: plankTex ?? null,
    roughness: 0.92,
    metalness: 0.0,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, length), floorMat);
  floor.name = 'plank-floor';
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, centerZ);
  floor.receiveShadow = true;
  group.add(floor);

  // Vignette overlay: transparent center falling to warm near-black edges.
  const vigCtx = make2d(128);
  if (vigCtx) {
    const g = vigCtx.createRadialGradient(64, 64, 18, 64, 64, 66);
    g.addColorStop(0, 'rgba(10, 7, 4, 0)');
    g.addColorStop(0.62, 'rgba(10, 7, 4, 0.12)');
    g.addColorStop(1, 'rgba(10, 7, 4, 0.62)');
    vigCtx.clearRect(0, 0, 128, 128);
    vigCtx.fillStyle = g;
    vigCtx.fillRect(0, 0, 128, 128);
    const vigTex = canvasTexture(vigCtx);
    const vigMat = new THREE.MeshBasicMaterial({
      map: vigTex,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const vig = new THREE.Mesh(new THREE.PlaneGeometry(width, length), vigMat);
    vig.name = 'floor-vignette';
    vig.rotation.x = -Math.PI / 2;
    vig.position.set(0, 0.012, centerZ);
    vig.renderOrder = 1;
    group.add(vig);
  }
  return group;
}

export interface DustMotesOptions {
  kit: MaterialKit;
  seed?: number;
  count?: number;
  /** Horizontal x spread, meters (motes span +/- spreadX / 2). */
  spreadX?: number;
  /** z range the motes drift in. */
  zMin?: number;
  zMax?: number;
}

export interface DustMotesBuild {
  group: THREE.Group;
  update(dt: number, elapsed: number): void;
}

/**
 * Dust motes drifting in the key-light shaft down the lane center: one
 * additive Points cloud, parchment tinted, very low opacity, deterministic.
 */
export function buildDustMotes(opts: DustMotesOptions): DustMotesBuild {
  const rng = mulberry32(opts.seed ?? 0xd057);
  const count = opts.count ?? 48;
  const spreadX = opts.spreadX ?? 4.4;
  const zMin = opts.zMin ?? -18;
  const zMax = opts.zMax ?? -3;
  const base = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    base[i * 3] = (rng() - 0.5) * spreadX;
    base[i * 3 + 1] = 0.4 + rng() * 2.8;
    base[i * 3 + 2] = zMax - rng() * (zMax - zMin);
    phase[i] = rng() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(base);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: PARCHMENT,
    map: opts.kit.glow,
    size: 0.055,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.name = 'dust-motes';
  const group = new THREE.Group();
  group.name = 'dust';
  group.add(points);

  const attr = geo.getAttribute('position') as THREE.BufferAttribute;
  const update = (_dt: number, elapsed: number): void => {
    for (let i = 0; i < count; i++) {
      const p = phase[i] ?? 0;
      const bx = base[i * 3] ?? 0;
      const by = base[i * 3 + 1] ?? 1;
      const bz = base[i * 3 + 2] ?? -6;
      attr.setXYZ(
        i,
        bx + Math.sin(elapsed * 0.21 + p) * 0.35,
        by + Math.sin(elapsed * 0.13 + p * 1.7) * 0.28,
        bz + Math.cos(elapsed * 0.17 + p) * 0.3,
      );
    }
    attr.needsUpdate = true;
  };
  return { group, update };
}

// ---------------------------------------------------------------------------
// buildArena
// ---------------------------------------------------------------------------

export function buildArena(scene: THREE.Scene): Arena {
  const rng = mulberry32(0x51ee7);
  const group = new THREE.Group();
  group.name = 'arena';

  const previousFog = scene.fog;
  const previousBackground = scene.background;
  scene.fog = new THREE.FogExp2(FOG_TONE, 0.042);
  scene.background = new THREE.Color(BACKDROP_TONE);

  const kit = makeMaterialKit(0x7a11);

  // --- Floor ---------------------------------------------------------------
  group.add(buildFloor({ kit, seed: 0xf100, width: 30, length: 34, centerZ: -9.5 }));

  // --- Entry porch (station 0 framing): two column pairs + timber frame ----
  const entryZs = [0.4, -3.2];
  const entryPositions: Array<[number, number]> = [];
  for (const z of entryZs) {
    entryPositions.push([-COLUMN_X, z], [COLUMN_X, z]);
  }
  group.add(buildColumnRow({ kit, positions: entryPositions }));
  group.add(buildTimberFrame({ kit, columnZs: entryZs, entryHeader: true }));

  // --- Colonnade run along the west edge (station 1 backdrop) --------------
  const colonnadeZs = [-3.5, -7, -10.5, -14, -17.5];
  group.add(buildColonnade({ kit, x: -7.6, columnZs: colonnadeZs }));

  // --- Spirit gate on the east edge (station 4) ----------------------------
  group.add(buildGreatGate({ kit, x: 7.4, zCenter: -6, span: 4.8 }));

  // --- Raised terrace + broad steps, northeast (station 2 vantage) ---------
  const terrace = new THREE.Group();
  terrace.name = 'terrace';
  const terraceBase = new THREE.Mesh(
    mergedBoxes([
      { w: 6.0, h: 0.82, d: 4.8, x: 6.4, y: 0.41, z: -17.0 },
    ]),
    kit.stone,
  );
  terraceBase.name = 'terrace-base';
  terraceBase.receiveShadow = true;
  terrace.add(terraceBase);
  const terraceTop = new THREE.Mesh(
    mergedBoxes([{ w: 6.0, h: 0.08, d: 4.8, x: 6.4, y: 0.86, z: -17.0 }]),
    kit.darkWood,
  );
  terraceTop.name = 'terrace-top';
  terraceTop.receiveShadow = true;
  terrace.add(terraceTop);
  group.add(terrace);
  group.add(
    buildSteps({ kit, x: 6.4, topZ: -14.6, topY: 0.9, width: 4.5, stepCount: 3, rise: 0.225, run: 0.5 }),
  );

  // --- Dry coal channel + railed bridge (stations 3 and 5) -----------------
  const channel = buildCoalChannel({ kit, seed: 0xc4a2, xStart: -9.5, xEnd: 2.5, z: -15.0, width: 1.6 });
  group.add(channel.group);
  group.add(buildBridge({ kit, x: -3.5, zStart: -12.9, zEnd: -17.1, width: 1.7, deckY: 0.5 }));

  // --- Banners: entry + colonnade run, and a lower pair on the gate --------
  const banners = buildBannerRun({
    slots: [
      { x: -3.48, z: -1.4, rotY: Math.PI / 2 },
      { x: 3.48, z: -1.4, rotY: -Math.PI / 2 },
      { x: -7.48, z: -5.25, rotY: Math.PI / 2 },
      { x: -7.48, z: -15.75, rotY: Math.PI / 2 },
    ],
    topY: COLUMN_TOP + 0.1,
  });
  group.add(banners.group);
  const gateBanners = buildBannerRun({
    slots: [
      { x: 7.32, z: -4.9, rotY: Math.PI / 2 },
      { x: 7.32, z: -7.1, rotY: Math.PI / 2 },
    ],
    topY: 3.3,
    width: 1.05,
    height: 1.7,
  });
  group.add(gateBanners.group);

  // --- Braziers: emissive-only, one composition per station (light policy:
  // the four relocatable station lights below follow the ACTIVE station) ----
  const brazierSpots: Array<[number, number, number]> = [
    [-2.6, 0, -2.8], // entry west
    [2.6, 0, -2.8], // entry east
    [-6.2, 0, -9.0], // colonnade
    [-6.2, 0, -12.0], // colonnade
    [6.8, 0, -2.6], // gate flank south
    [6.8, 0, -9.4], // gate flank north
    [-1.6, 0, -12.3], // bridge south landing
    [4.9, 0.9, -16.6], // terrace
  ];
  const brazierAnchors: THREE.Group[] = [];
  brazierSpots.forEach(([x, y, z], i) => {
    const b = buildBrazier({ kit, index: i, light: false });
    b.group.position.set(x, y, z);
    group.add(b.group);
    brazierAnchors.push(b.anchor);
  });

  // --- Lantern canopy over the courtyard + station lanterns ----------------
  const rodA = new THREE.CylinderGeometry(0.03, 0.03, 14.6, 6);
  rodA.rotateZ(Math.PI / 2);
  rodA.translate(-0.3, 4.55, -8.6);
  const rodB = new THREE.CylinderGeometry(0.03, 0.03, 10.2, 6);
  rodB.rotateZ(Math.PI / 2);
  rodB.translate(-2.5, 4.4, -11.6);
  const rodGeo = mergeGeometries([rodA, rodB], false) ?? rodA;
  if (rodGeo !== rodA) rodA.dispose();
  rodB.dispose();
  const rods = new THREE.Mesh(rodGeo, kit.darkWood);
  rods.name = 'canopy-rods';
  group.add(rods);

  // [x, y, z, hangLength, radius]
  const lanternSpots: Array<[number, number, number, number, number]> = [
    // Canopy rod A (z -8.6)
    [-5.2, 4.55, -8.6, 1.35, 0.21],
    [-1.8, 4.55, -8.6, 0.9, 0.15],
    [1.6, 4.55, -8.6, 1.5, 0.19],
    [5.0, 4.55, -8.6, 1.05, 0.165],
    // Canopy rod B (z -11.6)
    [-6.0, 4.4, -11.6, 1.1, 0.14],
    [-2.7, 4.4, -11.6, 1.6, 0.22],
    [0.6, 4.4, -11.6, 1.25, 0.18],
    // Under the gate's lower lintel
    [7.35, 3.35, -6.0, 0.45, 0.2],
    // Bridge rail end posts
    [-2.71, 1.62, -13.08, 0.26, 0.115],
    [-4.29, 1.62, -16.92, 0.26, 0.115],
  ];
  lanternSpots.forEach(([x, y, z, hang, radius], i) => {
    const lantern = buildLantern({ kit, radius, hangLength: hang, seed: 0x1a2b + i * 977 });
    lantern.position.set(x, y, z);
    group.add(lantern);
  });

  // --- Coal wall (key light source) ----------------------------------------
  const coalWall = buildCoalWall({ kit, seed: 0xc0a1, width: 14 });
  group.add(coalWall.group);

  // --- Backdrop: plaster walls + far roofline silhouettes ------------------
  group.add(buildBackdrop({ kit, seed: 0xf09 }));

  // --- Layered haze planes (cheap warm fog volume feel) --------------------
  const hazeMat = new THREE.MeshBasicMaterial({
    color: 0xb06a30,
    map: kit.glow,
    transparent: true,
    opacity: kit.glow ? 0.09 : 0.05,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  // Wide enough that the radial falloff edge stays outside the frame: at 15 m
  // wide the gradient rim read as a dark dome arch over the coal bed.
  const hazeGeo = new THREE.PlaneGeometry(26, 11);
  const hazePlanes: THREE.Mesh[] = [];
  for (const z of [-5, -11, -17]) {
    const haze = new THREE.Mesh(hazeGeo, hazeMat);
    haze.name = `haze-${-z}`;
    haze.position.set(0, 2.4, z);
    haze.renderOrder = 10;
    group.add(haze);
    hazePlanes.push(haze);
  }

  // --- Dust motes over the courtyard ---------------------------------------
  const motes = buildDustMotes({ kit, seed: 0xd057, spreadX: 13, zMin: -19, zMax: -2 });
  group.add(motes.group);

  // --- Lighting ------------------------------------------------------------
  // ONE dominant warm key raking low from the coal wall, FOUR relocatable
  // station point lights on layered-noise flicker (see the module header
  // light policy), and only a whisper of warm ambient so unlit surfaces
  // fall to charcoal instead of gray.
  const key = new THREE.DirectionalLight(0xffa050, 2.6);
  key.name = 'coal-wall-key';
  key.position.set(0, 2.6, -22.5);
  key.target.position.set(0, 0.8, -2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 36;
  key.shadow.camera.left = -11;
  key.shadow.camera.right = 11;
  key.shadow.camera.top = 8;
  key.shadow.camera.bottom = -3;
  key.shadow.radius = 4;
  key.shadow.bias = -0.0015;
  group.add(key, key.target);

  // Warm hemisphere whisper: ember glow from below, near-black from above.
  const ambient = new THREE.HemisphereLight(0x1a100a, 0x2a1408, 0.62);
  ambient.name = 'ember-ambient';
  group.add(ambient);

  // The four relocatable station lights (start at station 0).
  const stationLights: THREE.PointLight[] = [];
  const stationLightPhases: number[] = [];
  for (let i = 0; i < 4; i++) {
    const light = new THREE.PointLight(FIRELIGHT, 3.4, 9.5, 2);
    light.name = `station-light-${i}`;
    group.add(light);
    stationLights.push(light);
    stationLightPhases.push(rng() * Math.PI * 2);
  }
  const setActiveStation = (index: number): void => {
    const slots = STATION_LIGHT_SLOTS[
      ((Math.floor(index) % STATION_LIGHT_SLOTS.length) + STATION_LIGHT_SLOTS.length) %
        STATION_LIGHT_SLOTS.length
    ];
    if (!slots) return;
    stationLights.forEach((light, i) => {
      const slot = slots[i];
      if (slot) light.position.set(slot[0], slot[1], slot[2]);
    });
  };
  setActiveStation(0);

  scene.add(group);

  // --- Runtime -------------------------------------------------------------
  let bannerTime = 0;
  const keyBase = key.intensity;

  const update = (dt: number, elapsed: number): void => {
    bannerTime += dt;
    banners.uTime.value = bannerTime;
    gateBanners.uTime.value = bannerTime;

    // Layered sine flicker per station light: subtle, always positive.
    for (let i = 0; i < stationLights.length; i++) {
      const light = stationLights[i];
      const phase = stationLightPhases[i];
      if (light === undefined || phase === undefined) continue;
      const n =
        0.82 +
        0.13 * Math.sin(elapsed * 9.7 + phase) +
        0.08 * Math.sin(elapsed * 23.3 + phase * 1.7) +
        0.05 * Math.sin(elapsed * 41.1 + phase * 0.6);
      light.intensity = 3.4 * n;
    }

    // The coal wall and channel breathe very slowly, out of phase.
    key.intensity = keyBase * (1 + 0.05 * Math.sin(elapsed * 1.7));
    coalWall.update(dt, elapsed);
    channel.update(dt, elapsed);

    // Haze drifts almost imperceptibly.
    for (let i = 0; i < hazePlanes.length; i++) {
      const haze = hazePlanes[i];
      if (haze === undefined) continue;
      haze.position.x = Math.sin(elapsed * 0.11 + i * 2.1) * 0.35;
    }

    motes.update(dt, elapsed);
  };

  // Traversal-based disposal: every geometry / material / texture reachable
  // from the group, each exactly once, plus the shared kit.
  let disposed = false;
  const dispose = (): void => {
    scene.remove(group);
    if (!disposed) {
      disposed = true;
      const seen = new Set<{ dispose(): void }>();
      group.traverse((obj) => {
        const anyObj = obj as Partial<{
          geometry: THREE.BufferGeometry;
          material: THREE.Material | THREE.Material[];
        }>;
        if (anyObj.geometry) seen.add(anyObj.geometry);
        const mats = Array.isArray(anyObj.material)
          ? anyObj.material
          : anyObj.material
            ? [anyObj.material]
            : [];
        for (const mat of mats) {
          seen.add(mat);
          const texMat = mat as Partial<{
            map: THREE.Texture | null;
            emissiveMap: THREE.Texture | null;
          }>;
          if (texMat.map) seen.add(texMat.map);
          if (texMat.emissiveMap) seen.add(texMat.emissiveMap);
        }
      });
      for (const d of seen) d.dispose();
      kit.dispose();
      key.shadow.dispose();
    }
    group.clear();
    if (scene.fog instanceof THREE.FogExp2 && scene.fog.color.getHex() === FOG_TONE) {
      scene.fog = previousFog;
    }
    if (
      scene.background instanceof THREE.Color &&
      scene.background.getHex() === BACKDROP_TONE
    ) {
      scene.background = previousBackground;
    }
  };

  return {
    group,
    playerPosition: new THREE.Vector3(0, 1.5, 0),
    enemyAnchor: new THREE.Vector3(0, 1.1, -6),
    lights: { key, ambient, braziers: stationLights },
    brazierAnchors,
    setActiveStation,
    update,
    dispose,
  };
}
