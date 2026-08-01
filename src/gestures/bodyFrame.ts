/**
 * Body-local reference frame from body pose (position-state-machine rebuild,
 * 2026-07-31). The velocity-threshold engine failed five rounds because
 * velocity is a derivative and dies as fps drops (the player's machine
 * captures at ~14 fps). Everything in the new detection core is expressed in
 * POSITIONS inside this body-local frame, so the downstream math is
 * translation, distance and scale invariant, and a dropped frame costs a
 * sample, never a signal.
 *
 * FRAME DEFINITION (screen space is mirrored player space, tracking/types.ts:
 * x grows to the player's right, y grows DOWN):
 *   origin = shoulder midpoint.
 *   right  = normalized shoulder line (left shoulder -> right shoulder),
 *            which is roughly +x for a player squarely facing the camera.
 *   up     = WORLD vertical (screen -y), NOT the shoulder-line normal: the
 *            player stands squarely facing the camera, and anchoring "up" to
 *            gravity keeps zone boundaries honest when the shoulder line
 *            wobbles a few degrees.
 *   scale  = shoulder width (left-to-right shoulder distance).
 *
 * BODY COORDINATES keep the SCREEN y-down convention on purpose: body x is
 * the projection on the right axis, body y is the raw vertical offset, both
 * divided by shoulder width. Positive body y is therefore BELOW the shoulder
 * line (hips sit near +1.2) and negative body y is above it. Matching screen
 * orientation means aim vectors and zone math never need a sign flip against
 * the rest of the codebase; "up" in prose is negative body y.
 *
 * SLOW DRIFT RE-ESTIMATION: the frame follows the player with an EMA over
 * real pose SAMPLES (time constant FRAME_TAU_MS, a couple of seconds) plus a
 * hard per-sample clamp on how far the origin, axis angle and scale may move.
 * WHY both: the EMA handles the player slowly drifting around their play
 * space; the clamp guarantees that a punch, a lean, or one garbage pose
 * sample cannot yank the reference frame the gestures are measured against.
 * A frame that moved with the punch would erase the very extension signal
 * the detectors read.
 *
 * Interpolated frames and repeated (sample-and-held) timestamps are skipped:
 * the frame learns only from real detections, mirroring the elbow-tracker
 * discipline in moves.ts. Low-confidence samples are rejected outright.
 */

import type { PoseFrame, Vec3 } from '../tracking/types';

/** A point in body-local coordinates (shoulder-width units, y grows down). */
export interface BodyPoint {
  x: number;
  y: number;
}

/**
 * Per-landmark confidence floor for pose-driven state machines (from the
 * Puioio rep-counter validation: gate on required-landmark confidence 0.75;
 * below it the machine is simply not fed). Shared by the arm phase machines
 * (extension.ts) and the engine's pause logic.
 */
export const POSE_CONFIDENCE_FLOOR = 0.75;

/** EMA time constant for frame drift re-estimation, ms. A couple of seconds:
 *  slow enough that no single motion moves the frame, fast enough to follow
 *  a player shuffling half a step sideways within a few breaths. */
export const FRAME_TAU_MS = 2000;

/**
 * Per-sample clamp on origin motion, as a fraction of shoulder width. At the
 * nominal ~14 Hz pose rate this allows at most ~0.7 shoulder widths of frame
 * travel per second, far above real drift but far below what a punch-induced
 * shoulder jerk would demand, so violent samples are absorbed.
 */
export const FRAME_ORIGIN_MAX_STEP = 0.05;

/** Per-sample clamp on relative scale change (2 percent per sample). */
export const FRAME_SCALE_MAX_STEP = 0.02;

/** Per-sample clamp on the right-axis rotation, radians (~1.7 degrees). */
export const FRAME_AXIS_MAX_STEP_RAD = 0.03;

/** Per-sample clamp on hip-line motion, shoulder-width units. */
export const FRAME_HIP_MAX_STEP = 0.05;

/**
 * Shoulder widths below this (normalized screen units) are degenerate (a
 * collapsed or sideways pose) and are rejected before they can poison the
 * frame scale everything downstream divides by.
 */
export const MIN_SHOULDER_WIDTH = 0.02;

/**
 * Fallback hip line in body units before any hips have been observed:
 * anatomically the hip midpoint sits a bit over one shoulder width below the
 * shoulder line (measured on the user's drills: ~1.15).
 */
export const DEFAULT_HIP_Y = 1.15;

/** EMA lerp toward target with a hard per-sample step clamp. */
function stepToward(
  current: number,
  target: number,
  alpha: number,
  maxStep: number,
): number {
  let d = (target - current) * alpha;
  if (d > maxStep) d = maxStep;
  else if (d < -maxStep) d = -maxStep;
  return current + d;
}

/**
 * Maintains the slowly-drifting body frame and answers toBody queries.
 * Allocation-conscious: all state is flat scalars; toBody writes into a
 * caller-provided BodyPoint.
 */
export class BodyFrameTracker {
  private has = false;
  /** Origin (shoulder midpoint), screen space. */
  private ox = 0.5;
  private oy = 0.4;
  /** Right axis angle (atan2 of the shoulder line), radians. */
  private axisAngle = 0;
  private scaleVal = 0.3;
  /** Hip midpoint y in BODY units (positive = below the shoulder line). */
  private hipYVal = DEFAULT_HIP_Y;
  /** Slow per-side shoulder anchors, screen space (extension.ts reads them
   *  as the stable end of the shoulder-to-wrist reach measurement). */
  private readonly lShoulder = { x: 0.34, y: 0.4 };
  private readonly rShoulder = { x: 0.66, y: 0.4 };
  private lastSampleT: number | null = null;

  /** True once at least one confident real sample has seeded the frame. */
  get ready(): boolean {
    return this.has;
  }

  /** Shoulder width, normalized screen units. The scale unit of body space. */
  get scale(): number {
    return this.scaleVal;
  }

  /** Hip midpoint y in body units (roughly +1.15 below the origin). */
  get hipY(): number {
    return this.hipYVal;
  }

  /** The slowly-updated shoulder anchor for one side, screen space. The
   *  returned object is LIVE internal state: read, never retain or mutate. */
  shoulderAnchor(side: 'left' | 'right'): Readonly<{ x: number; y: number }> {
    return side === 'left' ? this.lShoulder : this.rShoulder;
  }

  /**
   * Screen point -> body-local coordinates. Body x projects on the right
   * axis; body y is the raw vertical offset (world vertical as the up axis,
   * see the module header); both in shoulder-width units.
   */
  toBody(p: Vec3, out: BodyPoint): BodyPoint {
    const dx = p.x - this.ox;
    const dy = p.y - this.oy;
    const ca = Math.cos(this.axisAngle);
    const sa = Math.sin(this.axisAngle);
    out.x = (dx * ca + dy * sa) / this.scaleVal;
    out.y = dy / this.scaleVal;
    return out;
  }

  /**
   * Consume one PoseFrame. Only confident REAL samples advance the frame:
   * interpolated frames, repeated timestamps, low-confidence detections and
   * degenerate (collapsed) shoulder lines are all skipped, and skipping is a
   * fully supported no-op.
   */
  update(pose: PoseFrame): void {
    if (pose.interpolated === true) return; // lerped frame: not a sample
    if (this.lastSampleT === pose.t) return; // held sample: nothing new
    if (pose.confidence < POSE_CONFIDENCE_FLOOR) return;

    const ls = pose.left.shoulder;
    const rs = pose.right.shoulder;
    const sdx = rs.x - ls.x;
    const sdy = rs.y - ls.y;
    const width = Math.hypot(sdx, sdy);
    if (!Number.isFinite(width) || width < MIN_SHOULDER_WIDTH) return;

    const mx = (ls.x + rs.x) / 2;
    const my = (ls.y + rs.y) / 2;
    const angle = Math.atan2(sdy, sdx);
    const hipMidY = (pose.left.hip.y + pose.right.hip.y) / 2;

    if (!this.has) {
      // First confident sample seeds the frame directly; the clamps only
      // discipline CHANGE, and there is nothing yet to protect.
      this.ox = mx;
      this.oy = my;
      this.axisAngle = angle;
      this.scaleVal = width;
      this.hipYVal = (hipMidY - my) / width;
      this.lShoulder.x = ls.x;
      this.lShoulder.y = ls.y;
      this.rShoulder.x = rs.x;
      this.rShoulder.y = rs.y;
      this.lastSampleT = pose.t;
      this.has = true;
      return;
    }

    const dtMs = Math.max(0, pose.t - (this.lastSampleT ?? pose.t));
    this.lastSampleT = pose.t;
    const alpha = 1 - Math.exp(-dtMs / FRAME_TAU_MS);

    // Origin and per-side anchors: same EMA, same clamp (screen units).
    const originStep = FRAME_ORIGIN_MAX_STEP * this.scaleVal;
    this.ox = stepToward(this.ox, mx, alpha, originStep);
    this.oy = stepToward(this.oy, my, alpha, originStep);
    this.lShoulder.x = stepToward(this.lShoulder.x, ls.x, alpha, originStep);
    this.lShoulder.y = stepToward(this.lShoulder.y, ls.y, alpha, originStep);
    this.rShoulder.x = stepToward(this.rShoulder.x, rs.x, alpha, originStep);
    this.rShoulder.y = stepToward(this.rShoulder.y, rs.y, alpha, originStep);

    // Axis: wrap the delta so a near-pi flip cannot spin the long way round.
    let dAngle = angle - this.axisAngle;
    while (dAngle > Math.PI) dAngle -= 2 * Math.PI;
    while (dAngle < -Math.PI) dAngle += 2 * Math.PI;
    this.axisAngle = stepToward(
      this.axisAngle,
      this.axisAngle + dAngle,
      alpha,
      FRAME_AXIS_MAX_STEP_RAD,
    );

    // Scale: relative clamp, so the guard scales with the player.
    this.scaleVal = stepToward(
      this.scaleVal,
      width,
      alpha,
      FRAME_SCALE_MAX_STEP * this.scaleVal,
    );

    // Hip line, kept in body units so it survives the player drifting.
    const hipTarget = (hipMidY - this.oy) / this.scaleVal;
    if (Number.isFinite(hipTarget)) {
      this.hipYVal = stepToward(this.hipYVal, hipTarget, alpha, FRAME_HIP_MAX_STEP);
    }
  }
}
