/**
 * Synthetic landmark fixture engine (Phase 0, T002).
 *
 * Canonical 21-landmark hand poses defined in a local hand frame, placed at
 * wrist positions, interpolated between keyframes with easing, and jittered
 * with seeded Gaussian noise so generation is fully deterministic.
 *
 * Pure data in, LandmarkRecording out. No file system access in this module;
 * fixtures/generate.ts is the writer script and tests import this directly to
 * build custom sequences.
 *
 * Coordinate conventions (see src/tracking/types.ts): normalized [0..1],
 * x grows to the player's right, y grows downward, z is negative toward the
 * camera. Poses below are authored for the player's RIGHT hand with fingers
 * pointing up and palm facing the camera; left hands mirror the local x axis.
 */

import type {
  FaceFrame,
  HandFrame,
  LandmarkFrame,
  LandmarkRecording,
  Vec3,
} from '../src/tracking/types';
import { HAND_LANDMARK_COUNT } from '../src/tracking/types';

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** Tiny deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash, used to derive a stable seed from a fixture label. */
export function hashLabel(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Standard normal sample via Box-Muller, driven by the given PRNG. */
export function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

export type EaseName = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

const EASES: Record<EaseName, (u: number) => number> = {
  linear: (u) => u,
  easeIn: (u) => u * u * u,
  easeOut: (u) => 1 - Math.pow(1 - u, 3),
  easeInOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
};

// ---------------------------------------------------------------------------
// Canonical hand poses (local frame, right hand, unit hand length)
// ---------------------------------------------------------------------------
//
// Local frame: wrist at origin, y negative toward the fingertips (up when the
// hand is raised), x positive toward the pinky side of a right hand (so the
// thumb sits at negative x, toward the body center), z negative toward the
// camera. One unit is one hand length (wrist to extended middle fingertip).

export type PoseName = 'rest' | 'fist' | 'palm' | 'grip';

type Triple = readonly [number, number, number];

const PALM_LOCAL: readonly Triple[] = [
  [0, 0, 0], // WRIST
  [-0.18, -0.12, -0.02], // THUMB_CMC
  [-0.3, -0.26, -0.04], // THUMB_MCP
  [-0.38, -0.38, -0.05], // THUMB_IP
  [-0.44, -0.48, -0.06], // THUMB_TIP
  [-0.16, -0.52, -0.02], // INDEX_MCP
  [-0.18, -0.7, -0.03], // INDEX_PIP
  [-0.19, -0.83, -0.04], // INDEX_DIP
  [-0.2, -0.94, -0.05], // INDEX_TIP
  [-0.02, -0.55, -0.02], // MIDDLE_MCP
  [-0.02, -0.75, -0.03], // MIDDLE_PIP
  [-0.02, -0.89, -0.04], // MIDDLE_DIP
  [-0.02, -1.0, -0.05], // MIDDLE_TIP
  [0.11, -0.52, -0.02], // RING_MCP
  [0.12, -0.71, -0.03], // RING_PIP
  [0.13, -0.84, -0.04], // RING_DIP
  [0.14, -0.94, -0.05], // RING_TIP
  [0.24, -0.46, -0.02], // PINKY_MCP
  [0.26, -0.6, -0.03], // PINKY_PIP
  [0.27, -0.7, -0.04], // PINKY_DIP
  [0.28, -0.79, -0.05], // PINKY_TIP
];

const FIST_LOCAL: readonly Triple[] = [
  [0, 0, 0], // WRIST
  [-0.16, -0.1, -0.03], // THUMB_CMC
  [-0.26, -0.2, -0.06], // THUMB_MCP
  [-0.24, -0.31, -0.09], // THUMB_IP
  [-0.18, -0.38, -0.11], // THUMB_TIP (folded across the curled fingers)
  [-0.14, -0.5, -0.05], // INDEX_MCP
  [-0.15, -0.55, -0.14], // INDEX_PIP (knuckle forward)
  [-0.15, -0.45, -0.18], // INDEX_DIP (curling back down)
  [-0.15, -0.36, -0.14], // INDEX_TIP (tucked toward the palm heel)
  [-0.01, -0.53, -0.05], // MIDDLE_MCP
  [-0.01, -0.58, -0.15], // MIDDLE_PIP
  [-0.01, -0.47, -0.2], // MIDDLE_DIP
  [-0.01, -0.37, -0.15], // MIDDLE_TIP
  [0.11, -0.5, -0.05], // RING_MCP
  [0.12, -0.55, -0.14], // RING_PIP
  [0.12, -0.44, -0.19], // RING_DIP
  [0.12, -0.35, -0.14], // RING_TIP
  [0.23, -0.44, -0.05], // PINKY_MCP
  [0.24, -0.48, -0.12], // PINKY_PIP
  [0.24, -0.39, -0.16], // PINKY_DIP
  [0.24, -0.31, -0.12], // PINKY_TIP
];

// Thumb geometry matches REAL vertical-thumb grips (HaGRID 'like' class,
// docs/hagrid-report.md): the thumb stands extended and clear of the index
// knuckle line (median 0.74 hand-scale units away, rise ~0.5), not wrapped
// over the fingers as originally guessed. The old wrapped thumb sat
// mid-slope on both gripScore thumb factors and made the score jittery.
const GRIP_LOCAL: readonly Triple[] = [
  [0, 0, 0], // WRIST
  [-0.18, -0.12, -0.03], // THUMB_CMC
  [-0.3, -0.24, -0.05], // THUMB_MCP
  [-0.34, -0.42, -0.06], // THUMB_IP
  [-0.36, -0.58, -0.06], // THUMB_TIP (standing tall, off the knuckles)
  [-0.15, -0.51, -0.04], // INDEX_MCP
  [-0.16, -0.6, -0.14], // INDEX_PIP
  [-0.16, -0.52, -0.21], // INDEX_DIP
  [-0.15, -0.42, -0.2], // INDEX_TIP (curled around a handle)
  [-0.01, -0.54, -0.04], // MIDDLE_MCP
  [-0.01, -0.63, -0.15], // MIDDLE_PIP
  [-0.01, -0.54, -0.23], // MIDDLE_DIP
  [-0.01, -0.43, -0.21], // MIDDLE_TIP
  [0.11, -0.51, -0.04], // RING_MCP
  [0.12, -0.6, -0.14], // RING_PIP
  [0.12, -0.51, -0.22], // RING_DIP
  [0.12, -0.41, -0.2], // RING_TIP
  [0.23, -0.45, -0.04], // PINKY_MCP
  [0.24, -0.53, -0.12], // PINKY_PIP
  [0.24, -0.45, -0.18], // PINKY_DIP
  [0.24, -0.36, -0.16], // PINKY_TIP
];

const REST_LOCAL: readonly Triple[] = [
  [0, 0, 0], // WRIST
  [-0.18, -0.11, -0.02], // THUMB_CMC
  [-0.3, -0.24, -0.04], // THUMB_MCP
  [-0.37, -0.34, -0.06], // THUMB_IP
  [-0.42, -0.42, -0.08], // THUMB_TIP
  [-0.16, -0.51, -0.02], // INDEX_MCP
  [-0.18, -0.66, -0.06], // INDEX_PIP
  [-0.19, -0.75, -0.09], // INDEX_DIP
  [-0.19, -0.82, -0.12], // INDEX_TIP (softly curled)
  [-0.02, -0.54, -0.02], // MIDDLE_MCP
  [-0.02, -0.7, -0.07], // MIDDLE_PIP
  [-0.02, -0.79, -0.11], // MIDDLE_DIP
  [-0.02, -0.86, -0.14], // MIDDLE_TIP
  [0.11, -0.51, -0.02], // RING_MCP
  [0.12, -0.66, -0.07], // RING_PIP
  [0.13, -0.74, -0.11], // RING_DIP
  [0.13, -0.81, -0.14], // RING_TIP
  [0.23, -0.45, -0.02], // PINKY_MCP
  [0.25, -0.56, -0.06], // PINKY_PIP
  [0.26, -0.63, -0.09], // PINKY_DIP
  [0.26, -0.69, -0.12], // PINKY_TIP
];

function toVecs(rows: readonly Triple[], name: string): Vec3[] {
  if (rows.length !== HAND_LANDMARK_COUNT) {
    throw new Error(`pose ${name} has ${rows.length} landmarks, expected ${HAND_LANDMARK_COUNT}`);
  }
  return rows.map((r) => vec(r[0], r[1], r[2]));
}

/** Canonical poses in the local right-hand frame, unit hand length. */
export const POSES: Record<PoseName, Vec3[]> = {
  rest: toVecs(REST_LOCAL, 'rest'),
  fist: toVecs(FIST_LOCAL, 'fist'),
  palm: toVecs(PALM_LOCAL, 'palm'),
  grip: toVecs(GRIP_LOCAL, 'grip'),
};

/** Hand length (wrist to extended middle fingertip) in normalized units. */
export const HAND_SCALE = 0.16;

/**
 * Perspective constant for depth-consistent hand sizing. A real hand that
 * moves toward the camera grows on screen; the original generator moved the
 * wrist in z without scaling the hand, which would leave the palm-span
 * growth signal (src/gestures/motion.ts) at zero for every thrust. A hand
 * whose wrist sits at depth z (negative toward the camera) has its landmark
 * spread scaled around the wrist by 1 / (1 + z * PERSPECTIVE_K). K = 1.8
 * makes the guard-to-extension punch (z -0.05 -> -0.30) roughly double the
 * span, producing a windowed growth rate comparable to the punch's speed
 * spike (measured ~3 1/s raw), while slow negatives (slow-reach,
 * talking-hands) stay far below the spike-growth threshold.
 */
export const PERSPECTIVE_K = 1.8;

/** Smallest allowed perspective denominator: guards degenerate depths. */
const PERSPECTIVE_DENOM_MIN = 0.2;

/** Apparent-size multiplier for a wrist at depth z (see PERSPECTIVE_K). */
export function perspectiveScale(z: number): number {
  return 1 / Math.max(1 + z * PERSPECTIVE_K, PERSPECTIVE_DENOM_MIN);
}

export type HandSide = 'left' | 'right';

/**
 * Place a canonical pose at a wrist position in player space.
 * Left hands mirror the local x axis so the thumb points toward body center.
 * Returns clean landmarks with no noise; useful for building custom frames.
 */
export function placePose(
  pose: PoseName,
  wrist: Vec3,
  side: HandSide,
  scale: number = HAND_SCALE,
): Vec3[] {
  const mirror = side === 'left' ? -1 : 1;
  return POSES[pose].map((p) =>
    vec(wrist.x + p.x * mirror * scale, wrist.y + p.y * scale, wrist.z + p.z * scale),
  );
}

// ---------------------------------------------------------------------------
// Keyframe tracks
// ---------------------------------------------------------------------------

export const DEFAULT_CONF = 0.96;

/** Below this interpolated confidence the hand is emitted as null (untracked). */
export const PRESENCE_FLOOR = 0.15;

export interface HandKeyframe {
  /** Milliseconds from recording start. */
  t: number;
  /** null means the hand is not tracked at this keyframe (out of frame). */
  pose: PoseName | null;
  /** Wrist position in player space. Kept even for pose null, for continuity. */
  wrist: Vec3;
  /** Presence confidence at this keyframe; defaults to DEFAULT_CONF. */
  conf?: number;
  /** Easing applied over the segment that ARRIVES at this keyframe. */
  ease?: EaseName;
}

/** Terse keyframe constructor for spec authoring. */
export function kf(
  t: number,
  pose: PoseName | null,
  x: number,
  y: number,
  z: number,
  opts: { conf?: number; ease?: EaseName } = {},
): HandKeyframe {
  const out: HandKeyframe = { t, pose, wrist: vec(x, y, z) };
  if (opts.conf !== undefined) out.conf = opts.conf;
  if (opts.ease !== undefined) out.ease = opts.ease;
  return out;
}

export interface FixtureSpec {
  label: string;
  durationMs: number;
  /** Nominal frame rate; defaults to 30. */
  fps?: number;
  /** PRNG seed; defaults to a hash of the label. */
  seed?: number;
  /** Per-landmark Gaussian jitter, normalized units; defaults to 0.003. */
  noiseSigma?: number;
  left: HandKeyframe[];
  right: HandKeyframe[];
}

function bracket(
  track: readonly HandKeyframe[],
  t: number,
): { a: HandKeyframe; b: HandKeyframe } {
  const first = track[0];
  if (!first) throw new Error('empty keyframe track');
  let a = first;
  for (const k of track) {
    if (k.t <= t) {
      a = k;
    } else {
      return { a, b: k };
    }
  }
  return { a, b: a };
}

function keyConf(k: HandKeyframe): number {
  return k.pose === null ? 0 : (k.conf ?? DEFAULT_CONF);
}

/**
 * Sample a hand track at time t. Interpolates wrist and pose shape between
 * the bracketing keyframes with easing, then applies Gaussian jitter to every
 * landmark. Returns null when the interpolated confidence falls below
 * PRESENCE_FLOOR (hand out of frame or lost).
 */
export function sampleHand(
  track: readonly HandKeyframe[],
  t: number,
  side: HandSide,
  rng: () => number,
  noiseSigma: number,
): HandFrame | null {
  if (track.length === 0) return null;
  const { a, b } = bracket(track, t);
  const span = b.t - a.t;
  const u = span > 0 ? clamp01((t - a.t) / span) : 0;
  const e = EASES[b.ease ?? 'easeInOut'](u);

  const conf = lerp(keyConf(a), keyConf(b), e);
  if (conf < PRESENCE_FLOOR) return null;

  const poseA: PoseName = a.pose ?? b.pose ?? 'rest';
  const poseB: PoseName = b.pose ?? a.pose ?? 'rest';
  const shapeA = POSES[poseA];
  const shapeB = POSES[poseB];
  const mirror = side === 'left' ? -1 : 1;
  const wx = lerp(a.wrist.x, b.wrist.x, e);
  const wy = lerp(a.wrist.y, b.wrist.y, e);
  const wz = lerp(a.wrist.z, b.wrist.z, e);

  // Depth-consistent sizing: scale the whole hand around the wrist by the
  // apparent-size factor for this depth (see PERSPECTIVE_K above), so a
  // thrust grows the on-screen hand exactly as a real approach would.
  const ps = perspectiveScale(wz);
  const landmarks: Vec3[] = shapeA.map((pa, i) => {
    const pb = shapeB[i] ?? pa;
    const lx = lerp(pa.x, pb.x, e) * mirror * HAND_SCALE * ps;
    const ly = lerp(pa.y, pb.y, e) * HAND_SCALE * ps;
    const lz = lerp(pa.z, pb.z, e) * HAND_SCALE * ps;
    return vec(
      round4(wx + lx + gaussian(rng) * noiseSigma),
      round4(wy + ly + gaussian(rng) * noiseSigma),
      round4(wz + lz + gaussian(rng) * noiseSigma),
    );
  });

  return {
    landmarks,
    confidence: clamp01(round3(conf + gaussian(rng) * 0.01)),
  };
}

// ---------------------------------------------------------------------------
// Face
// ---------------------------------------------------------------------------

const FACE_BASE = { x: 0.5, y: 0.3, z: -0.02 };

/** Neutral head with small noise; plausible for a player facing the webcam. */
export function sampleFace(rng: () => number): FaceFrame {
  return {
    yaw: round4(gaussian(rng) * 0.02),
    pitch: round4(gaussian(rng) * 0.02),
    position: vec(
      round4(FACE_BASE.x + gaussian(rng) * 0.004),
      round4(FACE_BASE.y + gaussian(rng) * 0.004),
      round4(FACE_BASE.z + gaussian(rng) * 0.002),
    ),
    confidence: clamp01(round3(0.92 + gaussian(rng) * 0.02)),
  };
}

// ---------------------------------------------------------------------------
// Recording generation
// ---------------------------------------------------------------------------

function assertSorted(track: readonly HandKeyframe[], label: string, side: HandSide): void {
  for (let i = 1; i < track.length; i++) {
    const prev = track[i - 1];
    const cur = track[i];
    if (prev && cur && cur.t < prev.t) {
      throw new Error(`fixture ${label}: ${side} keyframes not sorted at t=${cur.t}`);
    }
  }
}

/** Sample a spec into a 30 fps LandmarkRecording. Deterministic per spec. */
export function generateRecording(spec: FixtureSpec): LandmarkRecording {
  assertSorted(spec.left, spec.label, 'left');
  assertSorted(spec.right, spec.label, 'right');
  const fps = spec.fps ?? 30;
  const sigma = spec.noiseSigma ?? 0.003;
  const rng = mulberry32(spec.seed ?? hashLabel(spec.label));
  const frameDur = 1000 / fps;
  const frameCount = Math.max(1, Math.round(spec.durationMs / frameDur) + 1);
  const frames: LandmarkFrame[] = [];
  for (let i = 0; i < frameCount; i++) {
    const t = i * frameDur;
    frames.push({
      t: round3(t),
      left: sampleHand(spec.left, t, 'left', rng, sigma),
      right: sampleHand(spec.right, t, 'right', rng, sigma),
      face: sampleFace(rng),
    });
  }
  return { version: 1, label: spec.label, fps, frames };
}
