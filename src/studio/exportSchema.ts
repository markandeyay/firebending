/**
 * Recording-studio export CONTRACT (Round 3 Phase 4). The studio's export
 * button emits exactly this shape as firebending-drill-<yyyy-mm-dd>.json and
 * the analyze tool imports these types; treat every change here as a
 * versioned schema change (bump `version`).
 *
 * CLOCKS: every time in this file is VIDEO time, milliseconds since the
 * take's MediaRecorder started. Frames were captured on the tracking source's
 * frame clock and re-based via the take's frameClockOffset (see
 * src/studio/clock.ts): videoMs = frame.t + offset. `trimmedRange`, rep
 * boundaries and quality timestamps all share this one clock, so the analyze
 * tool never needs the offset again; it is carried anyway for provenance.
 */

import type { HandFrame, PoseFrame } from '../tracking/types';
import type { MotionProfile, MotionThresholds } from '../gestures/profile';
import type { CaptureHealth } from './captureRate';

export type { CaptureHealth };

// ---------------------------------------------------------------------------
// Take identity
// ---------------------------------------------------------------------------

/** The 16 studio drill slots, in board order. */
export const TAKE_IDS = [
  'jab-left-x5',
  'jab-right-x5',
  'alt-jab-combo-x3',
  'palm-strike-left-x5',
  'palm-strike-right-x5',
  'palm-static-5s',
  'fire-stream-4s-x2',
  'flame-fan-4s-x2',
  'twin-cannon-x3',
  'rising-flame-x3',
  'fire-whip-left-x3',
  'fire-whip-right-x3',
  'breath-charge-x3',
  'neg-talking-30s',
  'neg-idle-20s',
  'neg-reaching-20s',
] as const;

export type TakeId = (typeof TAKE_IDS)[number];

/** Review status of one recorded take. A slot with no takes is Not recorded. */
export type TakeStatus = 'recorded' | 'confirmed' | 'needs-redo';

// ---------------------------------------------------------------------------
// Per-frame data
// ---------------------------------------------------------------------------

/**
 * Derived motion/pose signals for one hand-and-arm side, sampled on the
 * exact frame. Computed with the SAME code the game runs (gestures/poses,
 * gestures/motion, tracking/poseSource), windowed identically to MoveEngine.
 */
export interface StudioSideSignals {
  /** Elbow angle at the latest consumed pose sample, radians (0 = no pose yet). */
  elbowAngle: number;
  /** Elbow-extension angular velocity, rad/s, positive = extending. */
  elbowVel: number;
  /** Windowed wrist speed, normalized units/sec. */
  wristSpeed: number;
  /** Windowed wrist velocity x component (player-right positive), u/s. */
  velX: number;
  /** Windowed wrist velocity y component (down positive), u/s. */
  velY: number;
  /** Windowed relative hand-bbox-diagonal growth, 1/sec. */
  bboxGrowth: number;
  /** Instantaneous pose-classifier scores 0..1 (no hysteresis). */
  fist: number;
  palm: number;
  grip: number;
}

/** Pose-derived body signals for one frame. */
export interface StudioBodySignals {
  /** False when the frame carried no pose; the numbers below are then 0. */
  present: boolean;
  shoulderCenterY: number;
  shoulderWidth: number;
  shoulderTiltRad: number;
  hipCenterY: number;
  hipWidth: number;
  hipTiltRad: number;
  /** 0..1 standing likelihood (src/tracking/body.ts). */
  standingScore: number;
}

export interface StudioFrameSignals {
  left: StudioSideSignals;
  right: StudioSideSignals;
  body: StudioBodySignals;
}

/**
 * One captured frame. `t` is VIDEO time ms (see module header). Hands carry
 * the full 21 raw player-space landmarks plus metric world landmarks when
 * the tracker provided them; `pose` is the frame's PoseFrame verbatim,
 * including the `interpolated` flag on worker-path lerped samples.
 */
export interface StudioFrame {
  t: number;
  left: HandFrame | null;
  right: HandFrame | null;
  pose: PoseFrame | null;
  signals: StudioFrameSignals;
}

// ---------------------------------------------------------------------------
// Reps and quality
// ---------------------------------------------------------------------------

/** One labeled rep window, video ms. Rejected candidates are not exported. */
export interface StudioRep {
  startMs: number;
  endMs: number;
  /** True when the user explicitly confirmed the rep in review. */
  confirmed: boolean;
  /** True when the marker was placed by hand (M key), not peak detection. */
  manual: boolean;
}

/** Quality warning kinds flagged during capture. */
export type QualityKind = 'framing' | 'confidence' | 'hand-lost';

export interface StudioQualityEvent {
  tMs: number;
  kind: QualityKind;
}

// ---------------------------------------------------------------------------
// Takes and the export envelope
// ---------------------------------------------------------------------------

export interface StudioTakeExport {
  id: TakeId;
  /** 1-based index within the slot (multiple takes per slot are kept). */
  takeIndex: number;
  /** Exactly one take per slot is starred as the best. */
  starred: boolean;
  status: TakeStatus;
  /** Achieved capture rate, frames/sec, over the untrimmed take. */
  fps: number;
  /**
   * Mean of the INSTANTANEOUS landmark rates (1000/gap per frame pair)
   * over the untrimmed take. Additive optional field (version stays 1,
   * same pattern as meta.synthetic): takes recorded before the capture
   * hard gate lack it and must load fine.
   */
  fpsMean?: number;
  /** Minimum instantaneous landmark fps over the untrimmed take (the
   *  worst single frame gap). Additive optional field, see fpsMean. */
  fpsMin?: number;
  /** Kept range [startMs, endMs], video ms. Frames outside are discarded. */
  trimmedRange: [number, number];
  /** The derived motion thresholds active when the take was captured. */
  thresholds: MotionThresholds;
  /** frameClockOffset used to re-base frame times (provenance only). */
  frameClockOffset: number;
  /** ONLY the frames inside trimmedRange, t ascending. */
  frames: StudioFrame[];
  reps: StudioRep[];
  /** Quality warnings inside trimmedRange. */
  quality: StudioQualityEvent[];
}

export interface StudioExportMeta {
  cameraWidth: number;
  cameraHeight: number;
  /** Median shoulder width across exported frames (normalized units). */
  distanceEstimate: number;
  /** Free-text lighting note typed on the export screen. */
  lightingNote: string;
  /** Human-readable framing/quality summary line. */
  framingSummary: string;
  /** The player's stored motion profile, when one exists in localStorage. */
  motionProfile: MotionProfile | null;
  /**
   * True when this export was SYNTHESIZED (pipeline tests build fake
   * exports from the synthetic fixtures). The studio never writes the
   * field; the analyze tool treats a missing value as a real capture and
   * labels reports from synthetic inputs loudly. Purely additive optional
   * field: version stays 1, absent on all real exports.
   */
  synthetic?: boolean;
}

export interface StudioExport {
  version: 1;
  /** ISO timestamp of the export. */
  exportedAt: string;
  meta: StudioExportMeta;
  takes: StudioTakeExport[];
  /**
   * Capture-rate health summary over the exported takes' measured fps
   * (src/studio/captureRate.ts). Additive optional field (version stays
   * 1): exports written before the capture hard gate lack it and the
   * analyze tool must treat its absence as "unknown", not "healthy".
   */
  captureHealth?: CaptureHealth;
}
