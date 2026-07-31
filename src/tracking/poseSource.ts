/**
 * Live body-pose tracking source: wraps MediaPipe PoseLandmarker (LITE model,
 * Tasks Vision). Mirrors faceSource.ts's structure: this source does NOT
 * schedule itself; the caller (LiveLandmarkSource) decides when to run
 * detection (every 2nd frame nominally, every 4th when degraded) and
 * sample-and-holds the result between detections.
 *
 * WHY POSE: hand landmarks collapse into a small noisy cluster when a fist
 * clenches, so any hand-only "toward camera" signal is weakest exactly when a
 * jab happens. The elbow extension angle from body pose is anchored on large,
 * stable joints and opens fast and unambiguously during a punch; the move
 * layer fuses it with the hand-derived secondaries (see gestures/moves.ts).
 *
 * MediaPipe symbols are imported type-only or dynamically inside the factory
 * so headless tests never load the WASM runtime. The coordinate extraction
 * and elbow-angle math are exported pure functions.
 *
 * COORDINATES: PoseLandmarker's normalized landmarks are unmirrored image
 * space and its LEFT/RIGHT indices are ANATOMICAL (landmark 11 is the
 * person's own left shoulder; the model infers body orientation, unlike the
 * hand model's mirrored-selfie handedness convention). Player space per
 * types.ts is the mirrored view, so screen joints map x -> 1 - x and the
 * anatomical-left joints fill the `left` fields directly: after mirroring,
 * the player's left arm appears on the left side of the screen, consistent
 * with frame.left for hands. World landmarks (meters, hip-centered, x
 * image-right) are mirrored by negating x.
 */

import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { PoseArm, PoseFrame, Vec3 } from './types';
import { POSE_LM } from './types';
import { VISION_WASM_URL } from './handSource';
import type { RawLandmark } from './handSource';

/** Official Google CDN model asset (LITE, float16). */
export const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/** Landmarks may carry a per-point visibility score in Tasks Vision. */
export interface RawPoseLandmark extends RawLandmark {
  visibility?: number;
}

const JOINT_INDICES = [
  POSE_LM.LEFT_SHOULDER,
  POSE_LM.RIGHT_SHOULDER,
  POSE_LM.LEFT_ELBOW,
  POSE_LM.RIGHT_ELBOW,
  POSE_LM.LEFT_WRIST,
  POSE_LM.RIGHT_WRIST,
  POSE_LM.LEFT_HIP,
  POSE_LM.RIGHT_HIP,
] as const;

function screenVec(lm: RawLandmark): Vec3 {
  return { x: 1 - lm.x, y: lm.y, z: lm.z };
}

function worldVec(lm: RawLandmark): Vec3 {
  return { x: -lm.x, y: lm.y, z: lm.z };
}

function armOf(
  landmarks: readonly RawLandmark[],
  side: 'left' | 'right',
  map: (lm: RawLandmark) => Vec3,
): PoseArm | null {
  const shoulder =
    landmarks[side === 'left' ? POSE_LM.LEFT_SHOULDER : POSE_LM.RIGHT_SHOULDER];
  const elbow = landmarks[side === 'left' ? POSE_LM.LEFT_ELBOW : POSE_LM.RIGHT_ELBOW];
  const wrist = landmarks[side === 'left' ? POSE_LM.LEFT_WRIST : POSE_LM.RIGHT_WRIST];
  const hip = landmarks[side === 'left' ? POSE_LM.LEFT_HIP : POSE_LM.RIGHT_HIP];
  if (!shoulder || !elbow || !wrist || !hip) return null;
  return { shoulder: map(shoulder), elbow: map(elbow), wrist: map(wrist), hip: map(hip) };
}

/**
 * Extract the game's PoseFrame from raw MediaPipe landmarks: screen joints
 * mirrored into player space (x -> 1 - x), world joints (meters,
 * hip-centered) mirrored by negating x. Confidence is the mean visibility of
 * the eight screen joints (1 when the model reports no visibility). Returns
 * null when any required joint is missing. Pure and unit-testable.
 */
export function extractPoseFrame(
  landmarks: readonly RawPoseLandmark[],
  worldLandmarks: readonly RawPoseLandmark[] | null,
  timestampMs: number,
): PoseFrame | null {
  const left = armOf(landmarks, 'left', screenVec);
  const right = armOf(landmarks, 'right', screenVec);
  if (!left || !right) return null;

  let world: PoseFrame['world'] = null;
  if (worldLandmarks && worldLandmarks.length > POSE_LM.RIGHT_HIP) {
    const wl = armOf(worldLandmarks, 'left', worldVec);
    const wr = armOf(worldLandmarks, 'right', worldVec);
    if (wl && wr) world = { left: wl, right: wr };
  }

  let visSum = 0;
  let visCount = 0;
  for (const i of JOINT_INDICES) {
    const v = landmarks[i]?.visibility;
    if (typeof v === 'number' && Number.isFinite(v)) {
      visSum += v;
      visCount++;
    }
  }
  const confidence = visCount > 0 ? visSum / visCount : 1;

  // Per-wrist visibility for the ROI hand-crop path (roiCrop.ts). A model
  // that reports no visibility scores counts as fully visible, matching the
  // aggregate-confidence convention above.
  const lwVis = landmarks[POSE_LM.LEFT_WRIST]?.visibility;
  const rwVis = landmarks[POSE_LM.RIGHT_WRIST]?.visibility;
  const wristVisibility = {
    left: typeof lwVis === 'number' && Number.isFinite(lwVis) ? lwVis : 1,
    right: typeof rwVis === 'number' && Number.isFinite(rwVis) ? rwVis : 1,
  };

  return { t: timestampMs, left, right, world, confidence, wristVisibility };
}

/**
 * Elbow angle in radians: the angle at the elbow between (shoulder - elbow)
 * and (wrist - elbow). A straight arm is ~pi, a right-angle guard is ~pi/2.
 * Degenerate input (a joint collapsed onto the elbow) yields 0, never NaN.
 * Works in either coordinate space; poseWorld (metric) is preferred by the
 * caller because screen-space foreshortening compresses the angle when the
 * forearm points at the camera.
 */
export function elbowAngle(shoulder: Vec3, elbow: Vec3, wrist: Vec3): number {
  const ax = shoulder.x - elbow.x;
  const ay = shoulder.y - elbow.y;
  const az = shoulder.z - elbow.z;
  const bx = wrist.x - elbow.x;
  const by = wrist.y - elbow.y;
  const bz = wrist.z - elbow.z;
  const la = Math.sqrt(ax * ax + ay * ay + az * az);
  const lb = Math.sqrt(bx * bx + by * by + bz * bz);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const cos = (ax * bx + ay * by + az * bz) / (la * lb);
  return Math.acos(Math.min(1, Math.max(-1, cos)));
}

/**
 * Angular velocity between two consecutive elbow-angle samples, rad/s.
 * Positive = the arm is EXTENDING (opening toward straight), the primary
 * punch signal. dtSec must come from the pose sample timestamps, not frame
 * dt: pose runs at half frame rate and is sample-and-held between
 * detections. Non-positive dt yields 0.
 */
export function elbowAngularVelocity(
  prevAngle: number,
  currAngle: number,
  dtSec: number,
): number {
  if (!(dtSec > 0)) return 0;
  const v = (currAngle - prevAngle) / dtSec;
  return Number.isFinite(v) ? v : 0;
}

/**
 * Create a PoseLandmarker: 1 pose, VIDEO mode, LITE model, GPU delegate with
 * CPU fallback. MediaPipe is dynamically imported so tests never load it.
 */
export async function createPoseLandmarker(): Promise<PoseLandmarker> {
  const vision = await import('@mediapipe/tasks-vision');
  const fileset = await vision.FilesetResolver.forVisionTasks(VISION_WASM_URL);
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
    runningMode: 'VIDEO' as const,
    numPoses: 1,
  });
  try {
    return await vision.PoseLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('PoseLandmarker GPU delegate failed, falling back to CPU', err);
    return await vision.PoseLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

/**
 * Run pose detection on a video frame; returns a player-space PoseFrame or
 * null when no body is present. Called by the scheduler, not on its own
 * timer. timestampMs must be monotonically increasing (VIDEO mode).
 */
export function detectPose(
  landmarker: PoseLandmarker,
  video: HTMLVideoElement,
  timestampMs: number,
): PoseFrame | null {
  const result = landmarker.detectForVideo(video, timestampMs);
  const landmarks = result.landmarks[0];
  if (!landmarks || landmarks.length <= POSE_LM.RIGHT_HIP) return null;
  const world = result.worldLandmarks[0] ?? null;
  return extractPoseFrame(landmarks, world, timestampMs);
}
