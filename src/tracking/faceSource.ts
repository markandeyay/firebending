/**
 * Live face tracking source: wraps MediaPipe FaceLandmarker with
 * outputFacialTransformationMatrixes enabled. Head yaw/pitch come from the
 * facial transformation matrix; position is the normalized face center from
 * the landmarks, mirrored into player space.
 *
 * This source does NOT schedule itself. The caller (LiveLandmarkSource)
 * decides when to run detection (every 4th frame nominally, every 8th when
 * degraded), so the face rate is a scheduling concern, not a detector one.
 *
 * MediaPipe symbols are imported type-only or dynamically inside the factory
 * so headless tests never load the WASM runtime. Matrix math is exported as
 * pure functions.
 *
 * MATRIX CONVENTION: the facial transformation matrix is a 4x4 stored
 * column-major in Matrix.data (usable directly by three.js fromArray). It
 * maps the canonical face model into MediaPipe's camera space: right-handed,
 * x to the right of the UNMIRRORED image, y up, z toward the viewer; the
 * canonical face looks along +z (toward the camera).
 *
 * SIGN DERIVATION (player space per types.ts: positive yaw = player looks to
 * their own right, positive pitch = player looks up):
 * - A camera-space yaw of +a about +y turns the nose toward image-right,
 *   which is the player's LEFT on an unmirrored frame. Mirroring flips
 *   rotations about the vertical axis, so playerYaw = -cameraYaw.
 * - A camera-space pitch of +b about +x (with y up) turns the nose DOWN,
 *   so playerPitch = -cameraPitch.
 */

import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import type { FaceFrame, Vec3 } from './types';
import { VISION_WASM_URL } from './handSource';
import type { RawLandmark } from './handSource';

/** Official Google CDN model asset (float16). */
export const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/**
 * Extract camera-space yaw and pitch (radians) from a column-major 4x4
 * transformation matrix, assuming YXZ rotation order (roll ignored).
 * Column-major element R[row][col] lives at data[col * 4 + row].
 * - cameraYaw: rotation about +y; positive turns the nose toward image-right.
 * - cameraPitch: rotation about +x (y up); positive turns the nose down.
 * Pure; safe for any array of at least 12 numbers.
 */
export function matrixToCameraYawPitch(data: readonly number[]): {
  yaw: number;
  pitch: number;
} {
  const m02 = data[8] ?? 0; // R[0][2]
  const m12 = data[9] ?? 0; // R[1][2]
  const m22 = data[10] ?? 1; // R[2][2]
  return {
    yaw: Math.atan2(m02, m22),
    pitch: Math.asin(clamp(-m12, -1, 1)),
  };
}

/**
 * Full pipeline: transformation matrix -> player-space head yaw/pitch.
 * Positive yaw = player looks to their own right; positive pitch = up.
 */
export function matrixToPlayerYawPitch(data: readonly number[]): {
  yaw: number;
  pitch: number;
} {
  const cam = matrixToCameraYawPitch(data);
  return { yaw: -cam.yaw, pitch: -cam.pitch };
}

/**
 * Normalized face center from raw image-space landmarks, mirrored into
 * player space (x -> 1 - x). Pure.
 */
export function faceCenter(landmarks: readonly RawLandmark[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  const n = landmarks.length;
  if (n === 0) return { x: 0.5, y: 0.5, z: 0 };
  for (const lm of landmarks) {
    x += lm.x;
    y += lm.y;
    z += lm.z;
  }
  return { x: 1 - x / n, y: y / n, z: z / n };
}

/**
 * Create a FaceLandmarker: 1 face, VIDEO mode, transformation matrixes on,
 * GPU delegate with CPU fallback. MediaPipe is dynamically imported so tests
 * never load it.
 */
export async function createFaceLandmarker(): Promise<FaceLandmarker> {
  const vision = await import('@mediapipe/tasks-vision');
  const fileset = await vision.FilesetResolver.forVisionTasks(VISION_WASM_URL);
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    outputFacialTransformationMatrixes: true,
  });
  try {
    return await vision.FaceLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('FaceLandmarker GPU delegate failed, falling back to CPU', err);
    return await vision.FaceLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

/**
 * Run face detection on a video frame; returns a player-space FaceFrame or
 * null when no face is present. Called by the scheduler, not on its own timer.
 */
export function detectFace(
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  timestampMs: number,
): FaceFrame | null {
  const result = landmarker.detectForVideo(video, timestampMs);
  const landmarks = result.faceLandmarks[0];
  const matrix = result.facialTransformationMatrixes[0];
  if (!landmarks || landmarks.length === 0) return null;
  const { yaw, pitch } = matrix
    ? matrixToPlayerYawPitch(matrix.data)
    : { yaw: 0, pitch: 0 };
  return {
    yaw,
    pitch,
    position: faceCenter(landmarks),
    confidence: 1,
  };
}
