/**
 * Pose vocabulary (spec Section 6): pure functions that score a single
 * HandFrame 0..1. No state, no thresholds crossing frames; hysteresis and
 * multi-frame logic live in moves.ts.
 *
 * Scale normalization: every distance-based feature is divided by the hand
 * scale unit (wrist to middle MCP distance), so moving toward or away from
 * the camera does not change scores. Ratio features (tip vs MCP distance)
 * are scale-free by construction.
 *
 * Coordinates are player space (see tracking/types.ts): normalized 0..1,
 * x grows to the player's right, y grows DOWN, z is negative toward the
 * camera.
 *
 * All scores clamp and guard degenerate input (zero hand scale, collapsed
 * landmarks): they return finite numbers, never NaN.
 */

import type { HandFrame, Vec3 } from '../tracking/types';
import { LM } from '../tracking/types';
import { wristVelocity } from '../tracking/filters';

/** Which player slot a hand came from (frame.left or frame.right). */
export type Handedness = 'left' | 'right';

// ---------------------------------------------------------------------------
// Vector helpers (exported for moves.ts)
// ---------------------------------------------------------------------------

const EPS = 1e-6;

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function len(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function dist(a: Vec3, b: Vec3): number {
  return len(sub(a, b));
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Returns the zero vector for near-zero input instead of dividing by ~0. */
export function normalize(v: Vec3): Vec3 {
  const l = len(v);
  if (l < EPS) return { x: 0, y: 0, z: 0 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Standard smoothstep: 0 at edge0, 1 at edge1, smooth in between. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Landmark access
// ---------------------------------------------------------------------------

/** Checked landmark accessor (noUncheckedIndexedAccess). Throws on missing. */
export function lm(hand: HandFrame, index: number): Vec3 {
  const p = hand.landmarks[index];
  if (!p) throw new Error(`missing hand landmark ${index}`);
  return p;
}

/**
 * Hand scale unit: wrist to middle MCP distance. Roughly the palm length,
 * shrinks/grows with distance from camera. Returns 0 for a collapsed hand.
 */
export function handScale(hand: HandFrame): number {
  return dist(lm(hand, LM.WRIST), lm(hand, LM.MIDDLE_MCP));
}

/** The four non-thumb fingers as [mcp, pip, dip, tip] landmark indices. */
const FINGERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_DIP, LM.INDEX_TIP],
  [LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_DIP, LM.MIDDLE_TIP],
  [LM.RING_MCP, LM.RING_PIP, LM.RING_DIP, LM.RING_TIP],
  [LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_DIP, LM.PINKY_TIP],
];

/**
 * Extension ratio for one finger: tip-to-wrist distance over MCP-to-wrist
 * distance. Curled tip sits at or inside the knuckle (ratio <= ~1.0);
 * a straight finger reaches ~1.8..1.9. Scale-free. Returns null when the
 * MCP is degenerate (collapsed hand).
 */
function fingerRatio(hand: HandFrame, mcp: number, tip: number): number | null {
  const wrist = lm(hand, LM.WRIST);
  const mcpDist = dist(lm(hand, mcp), wrist);
  if (mcpDist < EPS) return null;
  return dist(lm(hand, tip), wrist) / mcpDist;
}

// ---------------------------------------------------------------------------
// Tuning constants (PROVISIONAL: tuned on synthetic geometry only)
// ---------------------------------------------------------------------------

/** Finger ratio at or below this counts as fully curled. */
export const FIST_CURL_FULL_RATIO = 1.05;
/** Finger ratio at or above this counts as not curled at all. */
export const FIST_CURL_NONE_RATIO = 1.45;

/** Finger ratio at or below this counts as not extended. */
export const PALM_EXT_NONE_RATIO = 1.15;
/** Finger ratio at or above this counts as fully extended. */
export const PALM_EXT_FULL_RATIO = 1.55;
/** Adjacent fingertip gap / hand scale at or below this = fingers together. */
export const PALM_GAP_TIGHT = 0.35;
/** Adjacent fingertip gap / hand scale at or above this = fingers spread. */
export const PALM_GAP_SPREAD = 0.8;
/** Signed palm-normal z (toward camera) where facing credit starts / maxes. */
export const PALM_FACING_MIN = 0.1;
export const PALM_FACING_FULL = 0.6;

/** Thumb tip distance to index PIP/MCP, / hand scale: near / far edges. */
export const GRIP_THUMB_NEAR = 0.5;
export const GRIP_THUMB_FAR = 1.0;
/** Thumb tip rise above thumb MCP, / hand scale: none / full edges. */
export const GRIP_THUMB_RISE_MIN = 0.15;
export const GRIP_THUMB_RISE_FULL = 0.5;
/** Raised-hand band: full credit below y 0.55, none above y 0.65 (y is DOWN). */
export const GRIP_RAISED_Y_FULL = 0.55;
export const GRIP_RAISED_Y_NONE = 0.65;

/** Default wrist-to-wrist distance for handsTogether. Calibrated later. */
export const HANDS_TOGETHER_THRESHOLD = 0.12;

// ---------------------------------------------------------------------------
// fistScore
// ---------------------------------------------------------------------------

/**
 * All four fingertips curled toward the palm. Per finger: ratio of
 * tip-to-wrist over MCP-to-wrist distance, smoothstepped so ratio <= 1.05
 * scores 1 (tip at or inside the knuckle) and ratio >= 1.45 scores 0.
 * Average across index/middle/ring/pinky. The thumb is ignored so the
 * fist family works with either thumb tuck.
 */
export function fistScore(hand: HandFrame): number {
  let sum = 0;
  for (const [mcp, , , tip] of FINGERS) {
    const r = fingerRatio(hand, mcp, tip);
    if (r === null) continue; // degenerate finger contributes 0
    sum += 1 - smoothstep(FIST_CURL_FULL_RATIO, FIST_CURL_NONE_RATIO, r);
  }
  return clamp01(sum / FINGERS.length);
}

// ---------------------------------------------------------------------------
// palmScore
// ---------------------------------------------------------------------------

/**
 * Open palm shown to the camera. Product of three factors (all must hold):
 *
 * 1. Extension: per-finger ratio smoothstepped 1.15 -> 1.55, averaged.
 * 2. Together: mean adjacent fingertip gap (index-middle, middle-ring,
 *    ring-pinky) divided by hand scale, credited below 0.35 and gone by 0.8.
 * 3. Facing: palm normal from cross(indexMCP - wrist, pinkyMCP - wrist).
 *
 * Handedness resolution for the facing factor: the winding wrist -> index
 * -> pinky is mirrored between the two hands, so the raw cross product
 * flips sign per hand. In player space (x right, y down, +z away from
 * camera, a right-handed basis) a RIGHT hand facing the camera has its
 * index MCP at smaller x than its pinky MCP, and cross(indexMCP - wrist,
 * pinkyMCP - wrist) comes out with POSITIVE z; a LEFT hand facing the
 * camera gives NEGATIVE z. We therefore take handedness (which frame slot
 * the hand came from) and flip the sign for the left hand, giving a single
 * signed "toward camera" scalar that is positive iff the palm faces the
 * camera for either hand. abs() was rejected because it could not tell
 * palm from back-of-hand.
 */
export function palmScore(hand: HandFrame, handedness: Handedness): number {
  const s = handScale(hand);
  if (s < EPS) return 0;

  // 1. Extension.
  let extSum = 0;
  for (const [mcp, , , tip] of FINGERS) {
    const r = fingerRatio(hand, mcp, tip);
    if (r === null) continue;
    extSum += smoothstep(PALM_EXT_NONE_RATIO, PALM_EXT_FULL_RATIO, r);
  }
  const extension = extSum / FINGERS.length;

  // 2. Fingers together.
  const tips = [LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];
  let gapSum = 0;
  let gapCount = 0;
  for (let i = 0; i + 1 < tips.length; i++) {
    const a = tips[i];
    const b = tips[i + 1];
    if (a === undefined || b === undefined) continue;
    gapSum += dist(lm(hand, a), lm(hand, b)) / s;
    gapCount++;
  }
  const meanGap = gapCount > 0 ? gapSum / gapCount : Infinity;
  const together = 1 - smoothstep(PALM_GAP_TIGHT, PALM_GAP_SPREAD, meanGap);

  // 3. Facing camera.
  const wrist = lm(hand, LM.WRIST);
  const u = sub(lm(hand, LM.INDEX_MCP), wrist);
  const v = sub(lm(hand, LM.PINKY_MCP), wrist);
  const normal = normalize(cross(u, v)); // zero vector if degenerate
  const towardCameraZ = handedness === 'right' ? normal.z : -normal.z;
  const facing = smoothstep(PALM_FACING_MIN, PALM_FACING_FULL, towardCameraZ);

  return clamp01(extension * together * facing);
}

// ---------------------------------------------------------------------------
// gripScore
// ---------------------------------------------------------------------------

/**
 * Whip grip: fingers curled like a fist but the thumb wrapped vertically
 * (thumb tip resting near the index PIP/MCP knuckle line, thumb pointing
 * up), with the hand raised in the upper part of the frame. Product of:
 *
 * 1. Curl: same per-finger curl as fistScore.
 * 2. Thumb near: min distance from thumb tip to index PIP or index MCP,
 *    / hand scale, credited below 0.5 and gone by 1.0.
 * 3. Thumb up: (thumbMCP.y - thumbTip.y) / hand scale (y is DOWN, so a
 *    positive rise means the tip is above the MCP), credited from 0.15,
 *    full at 0.5. A fist's sideways-tucked thumb has ~zero rise, which is
 *    what separates grip from fist.
 * 4. Raised: wrist y in the upper 60% of the frame; full credit below
 *    y 0.55, none above y 0.65.
 *
 * "Roughly static" is the move layer's job, not scored here.
 */
export function gripScore(hand: HandFrame): number {
  const s = handScale(hand);
  if (s < EPS) return 0;

  // 1. Curl (reuse the fist metric).
  const curl = fistScore(hand);

  // 2. Thumb wrapped near the index knuckles.
  const thumbTip = lm(hand, LM.THUMB_TIP);
  const dNear =
    Math.min(
      dist(thumbTip, lm(hand, LM.INDEX_PIP)),
      dist(thumbTip, lm(hand, LM.INDEX_MCP))
    ) / s;
  const thumbNear = 1 - smoothstep(GRIP_THUMB_NEAR, GRIP_THUMB_FAR, dNear);

  // 3. Thumb pointing up.
  const rise = (lm(hand, LM.THUMB_MCP).y - thumbTip.y) / s;
  const thumbUp = smoothstep(GRIP_THUMB_RISE_MIN, GRIP_THUMB_RISE_FULL, rise);

  // 4. Hand raised.
  const wristY = lm(hand, LM.WRIST).y;
  const raised = 1 - smoothstep(GRIP_RAISED_Y_FULL, GRIP_RAISED_Y_NONE, wristY);

  return clamp01(curl * thumbNear * thumbUp * raised);
}

// ---------------------------------------------------------------------------
// handSpeed
// ---------------------------------------------------------------------------

export interface HandSpeed {
  /** Magnitude of the average wrist velocity, normalized units per second. */
  speed: number;
  /** Average wrist velocity over the window. */
  velocity: Vec3;
  /**
   * Magnitude of motion toward the camera (-z component of velocity) when
   * moving toward it, else 0. Always >= 0.
   */
  towardCamera: number;
}

const ZERO_SPEED: HandSpeed = {
  speed: 0,
  velocity: { x: 0, y: 0, z: 0 },
  towardCamera: 0,
};

/**
 * Filtered wrist velocity over a window of recent HandFrames (oldest first)
 * sampled at a fixed per-frame dt. Averages the pairwise per-frame
 * velocities, which for a uniform window equals (last - first) / span but
 * stays well defined if the caller later weights frames. Fewer than two
 * frames, or a non-positive dt, yields zero motion.
 */
export function handSpeed(prevHands: HandFrame[], dtSec: number): HandSpeed {
  if (prevHands.length < 2 || !(dtSec > 0)) return ZERO_SPEED;

  let vx = 0;
  let vy = 0;
  let vz = 0;
  let pairs = 0;
  for (let i = 0; i + 1 < prevHands.length; i++) {
    const a = prevHands[i];
    const b = prevHands[i + 1];
    if (!a || !b) continue;
    const v = wristVelocity(a, b, dtSec);
    vx += v.x;
    vy += v.y;
    vz += v.z;
    pairs++;
  }
  if (pairs === 0) return ZERO_SPEED;

  const velocity: Vec3 = { x: vx / pairs, y: vy / pairs, z: vz / pairs };
  if (
    !Number.isFinite(velocity.x) ||
    !Number.isFinite(velocity.y) ||
    !Number.isFinite(velocity.z)
  ) {
    return ZERO_SPEED;
  }
  return {
    speed: len(velocity),
    velocity,
    // z is negative toward the camera, so toward-camera motion has vz < 0.
    towardCamera: velocity.z < 0 ? -velocity.z : 0,
  };
}

// ---------------------------------------------------------------------------
// handsTogether
// ---------------------------------------------------------------------------

export interface HandsTogether {
  together: boolean;
  /** Wrist-to-wrist distance in normalized units. */
  distance: number;
}

/**
 * True when the two wrists are within threshold (default 0.12 normalized;
 * PROVISIONAL, calibrationStats will tune this per player).
 */
export function handsTogether(
  l: HandFrame,
  r: HandFrame,
  threshold: number = HANDS_TOGETHER_THRESHOLD
): HandsTogether {
  const d = dist(lm(l, LM.WRIST), lm(r, LM.WRIST));
  const distance = Number.isFinite(d) ? d : 0;
  return { together: distance < threshold, distance };
}
