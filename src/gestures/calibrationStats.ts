/**
 * Calibration statistics (spec Section 8). During the 2 second ignition
 * window the calibration screen collects LandmarkFrames; captureCalibration
 * reduces them to per-player baselines that tune gesture thresholds:
 * neutral wrist positions, wrist-to-wrist span (shoulder width proxy),
 * baseline hand size for depth normalization, and a span-normalized velocity
 * scale so speed thresholds adapt to the player's distance from the camera.
 *
 * Pure functions only. Medians throughout so tracking jitter and brief
 * dropouts cannot skew the baselines.
 */

import type { HandFrame, LandmarkFrame, Vec3 } from '../tracking/types';
import { LM } from '../tracking/types';

export interface CalibrationStats {
  /** Median wrist position of the player's left hand, normalized coords. */
  neutralLeftWrist: Vec3;
  /** Median wrist position of the player's right hand, normalized coords. */
  neutralRightWrist: Vec3;
  /** Median wrist-to-wrist distance, a shoulder width proxy. */
  wristSpan: number;
  /**
   * Median REAL shoulder width (pose shoulder-to-shoulder distance,
   * normalized screen units) when body pose was present during the capture;
   * null otherwise. Preferred over wristSpan for velocity scaling: wrists
   * wander during the capture window, shoulders do not.
   */
  shoulderWidth: number | null;
  /** Median wrist to middle MCP distance across both hands. */
  handSize: number;
  /**
   * Multiplier for velocity thresholds. 1 at the reference size; a player
   * farther from the camera (smaller on-screen body, smaller on-screen
   * velocities) gets a scale above 1 so raw velocities are boosted before
   * thresholding.
   */
  velocityScale: number;
  /** Number of captured frames in which both hands were present. */
  sampleCount: number;
}

/** Wrist span that maps to velocityScale 1, in normalized screen units. */
export const REFERENCE_WRIST_SPAN = 0.5;
/**
 * Pose shoulder width that maps to velocityScale 1. Reference: a seated
 * player at a normal desk distance (~60..80 cm from a typical webcam FOV)
 * shows a shoulder line about a third of the frame wide; 0.32 keeps the
 * live scale ~1 there, above 1 when they sit farther back. Revisit against
 * real capture data once live pose recordings exist.
 */
export const REFERENCE_SHOULDER_WIDTH = 0.32;
export const VELOCITY_SCALE_MIN = 0.5;
export const VELOCITY_SCALE_MAX = 3;

/**
 * Fallback used when calibration is skipped (replay fixtures, tests).
 * Values approximate a player at a comfortable distance, hands at rest
 * just below chest height.
 */
export const DEFAULT_CALIBRATION: CalibrationStats = {
  neutralLeftWrist: { x: 0.35, y: 0.62, z: 0 },
  neutralRightWrist: { x: 0.65, y: 0.62, z: 0 },
  wristSpan: REFERENCE_WRIST_SPAN,
  shoulderWidth: null,
  handSize: 0.09,
  velocityScale: 1,
  sampleCount: 0,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Component-wise median of a set of points. */
function medianVec(points: Vec3[]): Vec3 {
  return {
    x: median(points.map((p) => p.x)),
    y: median(points.map((p) => p.y)),
    z: median(points.map((p) => p.z)),
  };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function wristOf(hand: HandFrame): Vec3 | undefined {
  return hand.landmarks[LM.WRIST];
}

function middleMcpOf(hand: HandFrame): Vec3 | undefined {
  return hand.landmarks[LM.MIDDLE_MCP];
}

/**
 * Velocity threshold multiplier. Prefers the REAL shoulder width from body
 * pose when the capture had one (shoulders are rigid; wrists wander), and
 * falls back to the wrist-span proxy otherwise. Clamped so a degenerate
 * capture can never disable or hair-trigger the move detectors.
 */
export function velocityScaleFor(
  span: number,
  shoulderWidth?: number | null,
): number {
  if (
    shoulderWidth !== undefined &&
    shoulderWidth !== null &&
    Number.isFinite(shoulderWidth) &&
    shoulderWidth > 0
  ) {
    const raw = REFERENCE_SHOULDER_WIDTH / shoulderWidth;
    return Math.min(VELOCITY_SCALE_MAX, Math.max(VELOCITY_SCALE_MIN, raw));
  }
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = REFERENCE_WRIST_SPAN / span;
  return Math.min(VELOCITY_SCALE_MAX, Math.max(VELOCITY_SCALE_MIN, raw));
}

/**
 * Reduce the captured frames to CalibrationStats. Frames missing a hand are
 * ignored for that hand's statistics; the span uses only frames with both
 * hands. If no frame ever contained both hands the capture is unusable and
 * DEFAULT_CALIBRATION is returned.
 */
export function captureCalibration(frames: LandmarkFrame[]): CalibrationStats {
  const leftWrists: Vec3[] = [];
  const rightWrists: Vec3[] = [];
  const spans: number[] = [];
  const handSizes: number[] = [];
  const shoulderWidths: number[] = [];

  for (const frame of frames) {
    const lw = frame.left ? wristOf(frame.left) : undefined;
    const rw = frame.right ? wristOf(frame.right) : undefined;

    if (frame.left && lw) {
      leftWrists.push(lw);
      const mcp = middleMcpOf(frame.left);
      if (mcp) handSizes.push(distance(lw, mcp));
    }
    if (frame.right && rw) {
      rightWrists.push(rw);
      const mcp = middleMcpOf(frame.right);
      if (mcp) handSizes.push(distance(rw, mcp));
    }
    if (lw && rw) spans.push(distance(lw, rw));

    // Real shoulder width from body pose when the frame carries one (frames
    // and recordings without pose are fully supported and just skip this).
    const pose = frame.pose;
    if (pose) {
      const w = distance(pose.left.shoulder, pose.right.shoulder);
      if (Number.isFinite(w) && w > 0) shoulderWidths.push(w);
    }
  }

  if (spans.length === 0) return { ...DEFAULT_CALIBRATION };

  const wristSpan = median(spans);
  const shoulderWidth = shoulderWidths.length > 0 ? median(shoulderWidths) : null;
  return {
    neutralLeftWrist:
      leftWrists.length > 0
        ? medianVec(leftWrists)
        : { ...DEFAULT_CALIBRATION.neutralLeftWrist },
    neutralRightWrist:
      rightWrists.length > 0
        ? medianVec(rightWrists)
        : { ...DEFAULT_CALIBRATION.neutralRightWrist },
    wristSpan,
    shoulderWidth,
    handSize:
      handSizes.length > 0 ? median(handSizes) : DEFAULT_CALIBRATION.handSize,
    velocityScale: velocityScaleFor(wristSpan, shoulderWidth),
    sampleCount: spans.length,
  };
}
