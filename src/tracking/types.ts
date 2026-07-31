/**
 * The universal input type. Gameplay code never touches MediaPipe directly;
 * everything consumes LandmarkFrame objects from a LandmarkSource.
 * Coordinates are normalized [0..1] in mirrored "player space": x grows to the
 * player's right, y grows downward, z is negative toward the camera.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** MediaPipe hand landmark indices (21 points). */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export const HAND_LANDMARK_COUNT = 21;

export interface HandFrame {
  /** 21 landmarks, normalized, already mirrored into player space. */
  landmarks: Vec3[];
  /** Presence confidence 0..1. */
  confidence: number;
  /**
   * OPTIONAL MediaPipe world landmarks: 21 points in METERS, roughly
   * hand-centered, mirrored into player space consistently with `landmarks`
   * (x negated; y down and z unchanged, matching the MediaPipe axes). Live
   * detection fills it; recordings and fixtures that predate the field lack
   * it, and all downstream code must treat its absence as fully supported
   * (see vfx/gloves.ts shapeLandmarks for the screen-space fallback).
   */
  world?: Vec3[];
}

/**
 * Head pose for camera parallax. Since Round 3 Phase 2 this is DERIVED from
 * PoseLandmarker head landmarks (nose/eyes/ears) via headPoseFromPose in
 * poseSource.ts; there is no separate face model. The type and the
 * frame.face field are unchanged, so recordings that carry face data from
 * the old FaceLandmarker era load and replay exactly as before.
 */
export interface FaceFrame {
  /** Head yaw in radians, positive = player looks to their right. */
  yaw: number;
  /** Head pitch in radians, positive = player looks up. */
  pitch: number;
  /** Head center, normalized screen coords. */
  position: Vec3;
  confidence: number;
}

/** MediaPipe pose landmark indices for the joints we extract (33-point model). */
export const POSE_LM = {
  NOSE: 0,
  LEFT_EYE: 2,
  RIGHT_EYE: 5,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
} as const;

/**
 * Head landmarks from the pose model, screen space, MIRRORED into player
 * space like every other screen point (x -> 1 - x). Anatomical LEFT fills the
 * `left*` fields, matching the arm convention: after mirroring the player's
 * left eye/ear appears on the left side of the screen. The framing gate uses
 * these for head-top estimates; headPoseFromPose derives yaw/pitch from the
 * same raw points.
 */
export interface PoseHead {
  nose: Vec3;
  leftEye: Vec3;
  rightEye: Vec3;
  leftEar: Vec3;
  rightEar: Vec3;
}

/**
 * One leg of the body pose (Round 3 Phase 3), mirrored screen space. Each
 * point is present only when the pose model reported it VISIBLE (visibility
 * >= LEG_VISIBILITY_FLOOR in poseSource.ts, or no visibility scores at all):
 * a seated player behind a desk typically has no reliable knees or ankles,
 * and downstream body math (src/tracking/body.ts) must treat every absent
 * point as fully supported.
 */
export interface PoseLeg {
  knee?: Vec3;
  ankle?: Vec3;
}

/** One arm-plus-hip chain of the body pose. */
export interface PoseArm {
  shoulder: Vec3;
  elbow: Vec3;
  wrist: Vec3;
  hip: Vec3;
}

/**
 * Body pose subset from MediaPipe PoseLandmarker: the eight joints the game
 * uses (shoulders, elbows, wrists, hips), in MIRRORED player space (x -> 1-x,
 * same convention as hands). The player's LEFT arm fills the `left` fields.
 * `world` carries the same joints from worldLandmarks (meters, hip-centered),
 * mirrored consistently (world x negated); preferred for angle math because
 * it is metric and depth-corrected. `t` is the DETECTION timestamp (ms since
 * source start) on real samples: pose runs below frame rate (~25 Hz worker
 * cadence, or half frame rate on the main-thread fallback) and frames
 * between detections are sample-and-held or interpolated (`interpolated`
 * true, `t` = the interpolation target time). Downstream angular-velocity
 * math must difference on real-sample `t` only (skip interpolated frames),
 * never on frame dt, and can use frame.t - pose.t as a freshness measure.
 */
export interface PoseFrame {
  /** Detection timestamp, ms since source start (held frames keep it). */
  t: number;
  left: PoseArm;
  right: PoseArm;
  /** World-landmark joints (meters, hip-centered, x mirrored). */
  world: { left: PoseArm; right: PoseArm } | null;
  /** Presence/visibility confidence 0..1. */
  confidence: number;
  /**
   * OPTIONAL per-wrist visibility scores 0..1 straight from the pose model,
   * used by the ROI hand-crop path to decide whether a wrist is reliable
   * enough to crop around. Fixtures and recordings that predate the field
   * lack it, and downstream code must treat its absence as fully supported.
   */
  wristVisibility?: { left: number; right: number };
  /**
   * OPTIONAL head landmarks (nose/eyes/ears) in mirrored screen space, for
   * the framing gate and head-pose derivation. Fixtures and recordings that
   * predate the field lack it; absence must be fully supported.
   */
  head?: PoseHead;
  /**
   * OPTIONAL legs (knees 25/26, ankles 27/28) in mirrored screen space, for
   * stance width, knee bend and the standing score (src/tracking/body.ts).
   * Present only when at least one leg point was visible; fixtures and
   * recordings that predate the field lack it, and absence (of the field or
   * of any individual point) must be fully supported.
   */
  legs?: { left: PoseLeg; right: PoseLeg };
  /**
   * OPTIONAL: true when this frame was produced by interpolating (or
   * capped-extrapolating) between two real pose SAMPLES rather than by a
   * detection. Interpolated frames give downstream consumers smooth
   * per-frame pose, but sample-timestamp math (the elbow angular-velocity
   * tracker in gestures/moves.ts) must SKIP them and difference only real
   * samples. Absent on all real samples, fixtures and recordings.
   */
  interpolated?: boolean;
}

export interface LandmarkFrame {
  /** Milliseconds since source start. */
  t: number;
  /** Player's left hand (already mirror-normalized). */
  left: HandFrame | null;
  /** Player's right hand. */
  right: HandFrame | null;
  face: FaceFrame | null;
  /**
   * Body pose, when a pose tracker ran. OPTIONAL: every fixture and recording
   * that predates pose support lacks the field, and all downstream code must
   * treat an absent/null pose as a fully supported state.
   */
  pose?: PoseFrame | null;
  /**
   * OPTIONAL capture timestamp of the SOURCE VIDEO FRAME this LandmarkFrame
   * was derived from, in the performance.now() clock domain (LIVE camera
   * only: requestVideoFrameCallback metadata.captureTime when the browser
   * provides it, else the metadata presentation time, else the callback
   * now). It measures photon-to-X latency: performance.now() minus captureTs
   * at any pipeline stage is the age of the light that produced the frame.
   * Fixtures and recordings NEVER carry it (their t is a synthetic clock
   * with no wall-time meaning), and all downstream code must treat its
   * absence as fully supported.
   */
  captureTs?: number;
}

export type FrameListener = (frame: LandmarkFrame) => void;

/**
 * The one interface between input and game. Two implementations:
 * live camera (MediaPipe) and replay (recorded/synthetic JSON).
 */
export interface LandmarkSource {
  start(): Promise<void>;
  stop(): void;
  /** Subscribe to frames; returns an unsubscribe function. */
  onFrame(listener: FrameListener): () => void;
}

/** Serialized recording format used by fixtures and the capture tool. */
export interface LandmarkRecording {
  version: 1;
  /** Human-readable label, e.g. "jab-right" or "idle-talking". */
  label: string;
  /** Nominal capture rate. */
  fps: number;
  frames: LandmarkFrame[];
}
