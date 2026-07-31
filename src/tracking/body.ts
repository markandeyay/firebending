/**
 * Full-body signals over a PoseFrame (Round 3 Phase 3). ALL pure functions,
 * no state, no DOM: the framing gate, the duck detector and the move layer's
 * hip-relative bands consume these, and the recording studio (next phase)
 * runs the same math offline.
 *
 * COORDINATES: PoseFrame joints are normalized mirrored player screen space
 * (x grows to the player's right, y grows DOWN, z negative toward the
 * camera; see tracking/types.ts). World joints (meters, hip-centered,
 * mirrored) are preferred for angle math when present because screen-space
 * foreshortening compresses angles.
 *
 * GEOMETRY ASSUMPTIONS (documented per the standing-score contract):
 * - A STANDING adult facing a webcam presents a visible torso whose vertical
 *   hip-below-shoulder span is comparable to the shoulder width: biacromial
 *   width ~0.36 m vs shoulder-to-hip length ~0.45-0.50 m gives a span/width
 *   ratio around 1.2-1.4 when upright and roughly frontal.
 * - A SEATED player (desk chair) reads lower on the same ratio: the reclined
 *   chair back and the forward-jutting pelvis foreshorten the visible torso
 *   toward ~0.6-0.9 shoulder widths.
 * - Knees disambiguate when visible: a standing knee is near straight
 *   (hip-knee-ankle angle approaching pi), a seated knee is sharply bent
 *   (~pi/2). Knees hidden behind a desk contribute a NEUTRAL 0.5, so the
 *   torso ratio alone still separates the common cases.
 * - Torso yaw within ~30 degrees of frontal keeps the ratio meaningful; a
 *   full profile view compresses shoulder width toward zero, which the
 *   degenerate-width guard maps to score 0 (not standing evidence).
 */

import type { PoseFrame, Vec3 } from './types';
import { elbowAngle } from './poseSource';

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** A body cross-line (shoulders or hips) in screen space. */
export interface BodyLine {
  /** Midpoint of the two joints. */
  center: Vec3;
  /** Planar screen distance between the two joints (normalized units). */
  width: number;
  /**
   * Line angle vs horizontal, radians: atan2 of (right joint - left joint).
   * 0 when level; positive when the player's RIGHT side sits LOWER on
   * screen (y grows down).
   */
  tiltRad: number;
}

function lineOf(left: Vec3, right: Vec3): BodyLine {
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  return {
    center: {
      x: (left.x + right.x) / 2,
      y: (left.y + right.y) / 2,
      z: (left.z + right.z) / 2,
    },
    width: Math.hypot(dx, dy),
    tiltRad: Math.atan2(dy, dx),
  };
}

/** Shoulder line: center, width and tilt of the two shoulder joints. */
export function shoulderLine(pose: PoseFrame): BodyLine {
  return lineOf(pose.left.shoulder, pose.right.shoulder);
}

/** Hip line: center, width and tilt of the two hip joints. */
export function hipLine(pose: PoseFrame): BodyLine {
  return lineOf(pose.left.hip, pose.right.hip);
}

// ---------------------------------------------------------------------------
// Torso rotation
// ---------------------------------------------------------------------------

/**
 * Torso yaw in radians from the shoulder-line depth difference: 0 facing the
 * camera, positive when the player turns toward their OWN right (the right
 * shoulder swings toward the camera, i.e. to smaller z). World joints
 * (metric) preferred; the screen-landmark z (a monocular depth guess scaled
 * roughly like x) is the documented fallback. Degenerate shoulder spans
 * (full profile or a tracking glitch) return the saturated +-pi/2.
 */
export function torsoRotationRad(pose: PoseFrame): number {
  const src = pose.world ?? pose;
  const l = src.left.shoulder;
  const r = src.right.shoulder;
  // Turning right rotates the shoulder segment about the vertical axis so
  // dz = zRight - zLeft goes negative; yaw = atan2(zLeft - zRight, dxPlanar).
  return Math.atan2(l.z - r.z, Math.abs(r.x - l.x));
}

// ---------------------------------------------------------------------------
// Stance
// ---------------------------------------------------------------------------

/**
 * Horizontal stance spread normalized by shoulder width: ankle spread when
 * both ankles are visible, else knee spread, else hip spread (~always ~0.6
 * of shoulder width, the documented "legs unseen" floor). A degenerate
 * shoulder width returns 0.
 */
export function stanceWidth(pose: PoseFrame): number {
  const sw = shoulderLine(pose).width;
  if (sw < 1e-6) return 0;
  const la = pose.legs?.left.ankle;
  const ra = pose.legs?.right.ankle;
  if (la && ra) return Math.abs(ra.x - la.x) / sw;
  const lk = pose.legs?.left.knee;
  const rk = pose.legs?.right.knee;
  if (lk && rk) return Math.abs(rk.x - lk.x) / sw;
  return Math.abs(pose.right.hip.x - pose.left.hip.x) / sw;
}

/**
 * Knee bend angle for one leg, radians: the angle AT the knee between the
 * (hip - knee) and (ankle - knee) segments. A straight standing leg is near
 * pi, a seated leg near pi/2. Null when the knee or ankle is not visible.
 * Screen-space joints (legs carry no world variant); degenerate geometry
 * (a joint collapsed onto the knee) yields 0 via the shared angle helper.
 */
export function kneeBendRad(pose: PoseFrame, side: 'left' | 'right'): number | null {
  const leg = side === 'left' ? pose.legs?.left : pose.legs?.right;
  const hip = side === 'left' ? pose.left.hip : pose.right.hip;
  if (!leg || !leg.knee || !leg.ankle) return null;
  return elbowAngle(hip, leg.knee, leg.ankle);
}

// ---------------------------------------------------------------------------
// Vertical center of mass
// ---------------------------------------------------------------------------

/** Shoulder-line contribution to the vertical center of mass. */
export const COM_SHOULDER_WEIGHT = 0.4;
/** Hip-line contribution: hip-heavy on purpose (see verticalCenterOfMass). */
export const COM_HIP_WEIGHT = 0.6;

/**
 * Weighted vertical torso center (normalized screen y, grows DOWN):
 * COM_SHOULDER_WEIGHT * shoulder-center y + COM_HIP_WEIGHT * hip-center y.
 * Hip-heavy on purpose for duck detection: a real duck (knees bending, the
 * whole body dropping) moves the hips as much as the shoulders, while a bow
 * from the waist drops only the shoulders. Weighting the hips makes the
 * signal harder to fake by leaning forward than the old 4-point midpoint.
 */
export function verticalCenterOfMass(pose: PoseFrame): number {
  const sy = (pose.left.shoulder.y + pose.right.shoulder.y) / 2;
  const hy = (pose.left.hip.y + pose.right.hip.y) / 2;
  return COM_SHOULDER_WEIGHT * sy + COM_HIP_WEIGHT * hy;
}

// ---------------------------------------------------------------------------
// Standing score
// ---------------------------------------------------------------------------

/** Torso span/width ratio at (and below) which the pose reads fully seated. */
export const SEATED_TORSO_RATIO = 0.7;
/** Torso span/width ratio at (and above) which the pose reads fully standing. */
export const STANDING_TORSO_RATIO = 1.15;
/** Knee angle read as fully bent (seated), radians (~109 degrees). */
export const KNEE_BENT_RAD = 1.9;
/** Knee angle read as fully straight (standing), radians (~166 degrees). */
export const KNEE_STRAIGHT_RAD = 2.9;
/** Blend weights: torso ratio dominates, knees refine. */
export const STANDING_RATIO_WEIGHT = 0.6;
export const STANDING_KNEE_WEIGHT = 0.4;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * 0..1 standing likelihood: ~1 for a standing player, ~0 for a seated one.
 * Composed (see the module-header geometry assumptions) from:
 * - the hip-below-shoulder vertical span over the shoulder width, ramped
 *   from SEATED_TORSO_RATIO (0) to STANDING_TORSO_RATIO (1);
 * - knee straightness, ramped from KNEE_BENT_RAD (0) to KNEE_STRAIGHT_RAD
 *   (1), averaged over the visible knees; knees hidden entirely contribute
 *   a NEUTRAL 0.5 so desk framings are judged by the torso alone.
 * Weighted STANDING_RATIO_WEIGHT / STANDING_KNEE_WEIGHT. Degenerate shoulder
 * width (profile view, glitch) returns 0.
 */
export function standingScore(pose: PoseFrame): number {
  const sw = shoulderLine(pose).width;
  if (sw < 1e-6) return 0;
  const span = hipLine(pose).center.y - shoulderLine(pose).center.y; // y down
  const ratioScore = clamp01(
    (span / sw - SEATED_TORSO_RATIO) / (STANDING_TORSO_RATIO - SEATED_TORSO_RATIO),
  );

  let kneeSum = 0;
  let kneeCount = 0;
  for (const side of ['left', 'right'] as const) {
    const angle = kneeBendRad(pose, side);
    if (angle === null) continue;
    kneeSum += clamp01((angle - KNEE_BENT_RAD) / (KNEE_STRAIGHT_RAD - KNEE_BENT_RAD));
    kneeCount++;
  }
  const kneeScore = kneeCount > 0 ? kneeSum / kneeCount : 0.5;

  return clamp01(
    STANDING_RATIO_WEIGHT * ratioScore + STANDING_KNEE_WEIGHT * kneeScore,
  );
}
