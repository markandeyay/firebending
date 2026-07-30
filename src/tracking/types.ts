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
}

export interface FaceFrame {
  /** Head yaw in radians, positive = player looks to their right. */
  yaw: number;
  /** Head pitch in radians, positive = player looks up. */
  pitch: number;
  /** Head center, normalized screen coords. */
  position: Vec3;
  confidence: number;
}

export interface LandmarkFrame {
  /** Milliseconds since source start. */
  t: number;
  /** Player's left hand (already mirror-normalized). */
  left: HandFrame | null;
  /** Player's right hand. */
  right: HandFrame | null;
  face: FaceFrame | null;
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
