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
// Tuning constants. Tuned on real hands: HaGRID landmark annotations
// (fixtures/hagrid/, docs/hagrid-report.md), cross-checked against the
// synthetic fixtures. PALM_FACING_* and GRIP_RAISED_Y_* could not be tuned
// from stills (2D landmarks / cropped framing) and keep their original
// values.
// ---------------------------------------------------------------------------

/** Finger ratio at or below this counts as fully curled. */
export const FIST_CURL_FULL_RATIO = 0.92;
/** Finger ratio at or above this counts as not curled at all. */
export const FIST_CURL_NONE_RATIO = 1.43;

/** Finger ratio at or below this counts as not extended. */
export const PALM_EXT_NONE_RATIO = 1.3;
/** Finger ratio at or above this counts as fully extended. */
export const PALM_EXT_FULL_RATIO = 1.65;
/** Adjacent fingertip gap / hand scale at or below this = fingers together. */
export const PALM_GAP_TIGHT = 0.55;
/** Adjacent fingertip gap / hand scale at or above this = fingers spread. */
export const PALM_GAP_SPREAD = 1.0;
/** Signed palm-normal z (toward camera) where facing credit starts / maxes. */
export const PALM_FACING_MIN = 0.1;
export const PALM_FACING_FULL = 0.6;

// palmScore2D edges (pure 2D; tuned on HaGRID via tools/hagrid/features.ts +
// analyze.ts, see docs/hagrid-report.md appendix). The extension and gap
// edges reuse the HaGRID-tuned palmScore values: HaGRID landmarks are 2D
// (z = 0), so those edges were ALREADY tuned on exactly the 2D quantities.

/** 2D finger extension edges (tip/MCP wrist-distance ratio, x/y only). */
export const PALM2D_EXT_NONE_RATIO = 1.3;
export const PALM2D_EXT_FULL_RATIO = 1.65;
/** 2D adjacent-fingertip gap / 2D hand scale: together / spread edges. */
export const PALM2D_GAP_TIGHT = 0.55;
export const PALM2D_GAP_SPREAD = 1.0;
/**
 * Signed 2D palm winding area (det(indexMCP-wrist, pinkyMCP-wrist) / s^2,
 * sign-flipped for the left hand so positive = palm toward camera). HaGRID:
 * palm p5 0.35 / stop p5 0.33, stop_inverted p95 -0.40, no_gesture p75
 * -0.20, mute median 0.01. Swept 0.15/0.25/0.35/0.40/0.45/0.55: FULL 0.35
 * is the largest edge that keeps recall exactly at the 3D scorer's values
 * (0.9317 at enter 0.75, 0.9583 at exit 0.55) while maximizing precision
 * (suite 0.6817 vs 3D 0.6671); 0.40 starts dropping recall (0.9233).
 * MIN 0.1 also nicks recall (0.9300), so 0.05 stays.
 */
export const PALM2D_WIND_MIN = 0.05;
export const PALM2D_WIND_FULL = 0.35;
/**
 * Min-area-rect aspect (minor/major) of the 2D landmark hull. A permissive
 * tail-guard against edge-on silhouettes only: HaGRID palm p5 0.43, stop p5
 * 0.28, so full credit at 0.25 costs almost no positives while cutting
 * knife-thin (strongly foreshortened) hands. FULL 0.35 was tried and drops
 * recall to 0.9100 at enter 0.75 (narrow real stop hands lose credit); the
 * guard must stay at 0.25.
 */
export const PALM2D_ASPECT_MIN = 0.12;
export const PALM2D_ASPECT_FULL = 0.25;

/** Thumb tip distance to index PIP/MCP, / hand scale: near / far edges. */
export const GRIP_THUMB_NEAR = 1.1;
export const GRIP_THUMB_FAR = 1.7;
/** Thumb tip rise above thumb MCP, / hand scale: none / full edges. */
export const GRIP_THUMB_RISE_MIN = 0.15;
export const GRIP_THUMB_RISE_FULL = 0.4;
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
 * tip-to-wrist over MCP-to-wrist distance, smoothstepped so ratios at or
 * below FIST_CURL_FULL_RATIO score 1 (tip at or inside the knuckle) and
 * ratios at or above FIST_CURL_NONE_RATIO score 0. Average across
 * index/middle/ring/pinky. The thumb is ignored so the fist family works
 * with either thumb tuck; the cost is that a thumbs-down reads as a fist.
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
 * 1. Extension: per-finger ratio smoothstepped PALM_EXT_NONE_RATIO ->
 *    PALM_EXT_FULL_RATIO, averaged.
 * 2. Together: mean adjacent fingertip gap (index-middle, middle-ring,
 *    ring-pinky) divided by hand scale, credited below PALM_GAP_TIGHT and
 *    gone by PALM_GAP_SPREAD (real relaxed-open palms sit wider than the
 *    synthetic ideal; see the HaGRID report).
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
// palmScore2D (pure 2D palm detection; no landmark z anywhere)
// ---------------------------------------------------------------------------

/** 2D (x/y only) distance between two landmarks. */
function dist2D(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 2D hand scale unit: wrist to middle MCP distance, x/y only. */
export function handScale2D(hand: HandFrame): number {
  return dist2D(lm(hand, LM.WRIST), lm(hand, LM.MIDDLE_MCP));
}

interface Pt2 {
  x: number;
  y: number;
}

const cross2 = (o: Pt2, a: Pt2, b: Pt2): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/**
 * Monotone-chain convex hull over the x/y projection of the given points,
 * returned in counter-clockwise order (screen coords, y down). Collinear
 * points are dropped. Fewer than 3 distinct points return what exists.
 * Exported for tools and tests.
 */
export function convexHull2D(points: readonly Vec3[]): Pt2[] {
  const p: Pt2[] = points
    .map((q) => ({ x: q.x, y: q.y }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length <= 2) return p;
  const lower: Pt2[] = [];
  for (const pt of p) {
    while (lower.length >= 2) {
      const o = lower[lower.length - 2];
      const a = lower[lower.length - 1];
      if (o && a && cross2(o, a, pt) <= 0) lower.pop();
      else break;
    }
    lower.push(pt);
  }
  const upper: Pt2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    if (!pt) continue;
    while (upper.length >= 2) {
      const o = upper[upper.length - 2];
      const a = upper[upper.length - 1];
      if (o && a && cross2(o, a, pt) <= 0) upper.pop();
      else break;
    }
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Aspect ratio (minor extent / major extent, 0..1) of the minimum-area
 * bounding rectangle of the 2D landmark hull (rotating calipers over hull
 * edges). Rotation-invariant, unlike an axis-aligned bbox: a tilted open
 * hand keeps its true silhouette proportions. Degenerate hulls return 0.
 * Exported for tools and tests.
 */
export function hullAspect2D(hand: HandFrame): number {
  const h = convexHull2D(hand.landmarks);
  if (h.length < 3) return 0;
  let bestArea = Infinity;
  let bestAspect = 0;
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    if (!a || !b) continue;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const elen = Math.sqrt(ex * ex + ey * ey);
    if (elen < EPS) continue;
    const ux = ex / elen;
    const uy = ey / elen;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const pt of h) {
      const u = pt.x * ux + pt.y * uy;
      const v = -pt.x * uy + pt.y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const hh = maxV - minV;
    const area = w * hh;
    if (area < bestArea) {
      bestArea = area;
      const major = Math.max(w, hh);
      bestAspect = major < EPS ? 0 : Math.min(w, hh) / major;
    }
  }
  return clamp01(bestAspect);
}

/**
 * Signed 2D palm winding area: det(indexMCP - wrist, pinkyMCP - wrist)
 * divided by the squared 2D hand scale, sign-flipped for the left hand so
 * the result is positive iff the palm faces the camera (same winding
 * argument as palmScore's facing factor, but WITHOUT the 3D normalization:
 * the determinant reads only landmark x/y). Twice the signed area of the
 * wrist / index-MCP / pinky-MCP triangle in hand-scale units: large when the
 * palm is flat to the camera, near 0 edge-on, negative for back-of-hand.
 * Exported for tools and tests.
 */
export function palmWinding2D(hand: HandFrame, handedness: Handedness): number {
  const s = handScale2D(hand);
  if (s < EPS) return 0;
  const w = lm(hand, LM.WRIST);
  const i = lm(hand, LM.INDEX_MCP);
  const p = lm(hand, LM.PINKY_MCP);
  const det = (i.x - w.x) * (p.y - w.y) - (i.y - w.y) * (p.x - w.x);
  const signed = handedness === 'right' ? det : -det;
  const wind = signed / (s * s);
  return Number.isFinite(wind) ? wind : 0;
}

/**
 * Open palm shown to the camera, from PURE 2D features (landmark x/y only;
 * no z anywhere). Motivation: palmScore's facing factor divides the winding
 * determinant by the full 3D cross-product length, whose x/y components are
 * built from MediaPipe's monocular-depth z guesses; live z noise inflates
 * that length, shrinks |normal.z| and multiplies real palms down (the
 * "palm poses barely recognized live" report). This scorer keeps the same
 * winding INFORMATION via the raw 2D determinant, which no z noise can
 * touch. Product of four factors:
 *
 * 1. Extension: per-finger 2D tip/MCP wrist-distance ratio, smoothstepped
 *    PALM2D_EXT_NONE_RATIO -> PALM2D_EXT_FULL_RATIO, averaged.
 * 2. Together: mean adjacent 2D fingertip gap / 2D hand scale, credited
 *    below PALM2D_GAP_TIGHT, gone by PALM2D_GAP_SPREAD.
 * 3. Winding: palmWinding2D smoothstepped PALM2D_WIND_MIN -> _FULL
 *    (positive = palm toward camera; rejects back-of-hand and edge-on).
 * 4. Aspect: min-area-rect aspect of the 2D landmark hull, smoothstepped
 *    PALM2D_ASPECT_MIN -> _FULL; a permissive guard that only cuts
 *    knife-thin (strongly foreshortened) silhouettes.
 *
 * Edges tuned on HaGRID (docs/hagrid-report.md appendix). All-finite and
 * clamped like every other scorer.
 */
export function palmScore2D(hand: HandFrame, handedness: Handedness): number {
  const s = handScale2D(hand);
  if (s < EPS) return 0;

  // 1. Extension (2D ratios).
  const wrist = lm(hand, LM.WRIST);
  let extSum = 0;
  for (const [mcp, , , tip] of FINGERS) {
    const mcpDist = dist2D(lm(hand, mcp), wrist);
    if (mcpDist < EPS) continue;
    const r = dist2D(lm(hand, tip), wrist) / mcpDist;
    extSum += smoothstep(PALM2D_EXT_NONE_RATIO, PALM2D_EXT_FULL_RATIO, r);
  }
  const extension = extSum / FINGERS.length;

  // 2. Fingers together (2D gaps).
  const tips = [LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];
  let gapSum = 0;
  let gapCount = 0;
  for (let i = 0; i + 1 < tips.length; i++) {
    const a = tips[i];
    const b = tips[i + 1];
    if (a === undefined || b === undefined) continue;
    gapSum += dist2D(lm(hand, a), lm(hand, b)) / s;
    gapCount++;
  }
  const meanGap = gapCount > 0 ? gapSum / gapCount : Infinity;
  const together = 1 - smoothstep(PALM2D_GAP_TIGHT, PALM2D_GAP_SPREAD, meanGap);

  // 3. Winding (2D facing surrogate).
  const facing = smoothstep(
    PALM2D_WIND_MIN,
    PALM2D_WIND_FULL,
    palmWinding2D(hand, handedness),
  );

  // 4. Hull aspect guard.
  const aspect = smoothstep(PALM2D_ASPECT_MIN, PALM2D_ASPECT_FULL, hullAspect2D(hand));

  return clamp01(extension * together * facing * aspect);
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
 *    / hand scale, credited below GRIP_THUMB_NEAR and gone by
 *    GRIP_THUMB_FAR. HaGRID finding: a REAL vertical thumb stands well off
 *    the knuckle line (median 0.74 hand-scale units vs 0.22 for a tucked
 *    fist thumb), so the edges are permissive; rejecting fists here would
 *    also reject real grips.
 * 3. Thumb up: (thumbMCP.y - thumbTip.y) / hand scale (y is DOWN, so a
 *    positive rise means the tip is above the MCP), credited from
 *    GRIP_THUMB_RISE_MIN, full at GRIP_THUMB_RISE_FULL.
 * 4. Raised: wrist y in the upper part of the frame; full credit below
 *    GRIP_RAISED_Y_FULL, none above GRIP_RAISED_Y_NONE.
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
