/**
 * Live body-pose tracking source: wraps MediaPipe PoseLandmarker (Tasks
 * Vision; LITE model shipped, FULL selectable). This source does NOT
 * schedule itself; the caller (LiveLandmarkSource, or the pose worker on the
 * off-thread path) decides when to run detection and sample-and-holds or
 * interpolates the result between detections.
 *
 * WHY POSE: hand landmarks collapse into a small noisy cluster when a fist
 * clenches, so any hand-only "toward camera" signal is weakest exactly when a
 * jab happens. The elbow extension angle from body pose is anchored on large,
 * stable joints and opens fast and unambiguously during a punch; the move
 * layer fuses it with the hand-derived secondaries (see gestures/moves.ts).
 *
 * HEAD POSE (Round 3 Phase 2): the pose model's 33 landmarks include the
 * nose (0), eyes (1-6) and ears (7-8), which is everything camera parallax
 * needs, so the separate FaceLandmarker was deleted. headPoseFromPose below
 * derives the FaceFrame from raw pose landmarks; frame.face keeps its type
 * and its consumers (camera rig, HUD, duck fallback, filters) unchanged.
 *
 * MediaPipe symbols are imported type-only or dynamically inside the factory
 * so headless tests never load the WASM runtime. The coordinate extraction,
 * head-pose derivation, interpolation and elbow-angle math are exported pure
 * functions.
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
import type { FaceFrame, PoseArm, PoseFrame, PoseHead, Vec3 } from './types';
import { POSE_LM } from './types';
import { VISION_WASM_URL } from './handSource';
import type { RawLandmark } from './handSource';

/** Pose model variant. LITE is the shipped default; FULL is selectable for
 * measurement (perf gate &pose=full) and adopted only if measured budgets
 * hold (see the tracker decision rule). */
export type PoseModelVariant = 'lite' | 'full';

/** Official Google CDN model assets (float16). */
export const POSE_MODEL_URLS: Readonly<Record<PoseModelVariant, string>> = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};

/** Back-compat alias: the shipped (LITE) model asset. */
export const POSE_MODEL_URL = POSE_MODEL_URLS.lite;

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
 * Head landmarks (nose/eyes/ears) in mirrored player screen space, for the
 * framing gate's head-top estimate. Returns undefined when any point is
 * missing (short landmark arrays from old-style callers). Pure.
 */
function headOf(landmarks: readonly RawPoseLandmark[]): PoseHead | undefined {
  const nose = landmarks[POSE_LM.NOSE];
  const leftEye = landmarks[POSE_LM.LEFT_EYE];
  const rightEye = landmarks[POSE_LM.RIGHT_EYE];
  const leftEar = landmarks[POSE_LM.LEFT_EAR];
  const rightEar = landmarks[POSE_LM.RIGHT_EAR];
  if (!nose || !leftEye || !rightEye || !leftEar || !rightEar) return undefined;
  return {
    nose: screenVec(nose),
    leftEye: screenVec(leftEye),
    rightEye: screenVec(rightEye),
    leftEar: screenVec(leftEar),
    rightEar: screenVec(rightEar),
  };
}

/**
 * Extract the game's PoseFrame from raw MediaPipe landmarks: screen joints
 * mirrored into player space (x -> 1 - x), world joints (meters,
 * hip-centered) mirrored by negating x. Confidence is the mean visibility of
 * the eight screen joints (1 when the model reports no visibility). Head
 * points (nose/eyes/ears, mirrored) fill the optional `head` field. Returns
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

  const head = headOf(landmarks);
  return {
    t: timestampMs,
    left,
    right,
    world,
    confidence,
    wristVisibility,
    ...(head ? { head } : {}),
  };
}

// ---------------------------------------------------------------------------
// Head pose from pose landmarks (replaces FaceLandmarker, R3 Phase 2)
// ---------------------------------------------------------------------------

/**
 * The nose sits roughly this fraction of the ear-to-ear distance in front of
 * the ear line, so the projected nose offset saturates around
 * NOSE_RADIUS_RATIO * earDist at a 90 degree turn: offset / (ratio * dist)
 * is the sine of the head angle.
 */
export const NOSE_RADIUS_RATIO = 0.5;

/** Ears closer than this fraction of the frame are degenerate (profile view
 * or a tracking glitch); no head pose can be derived. */
export const HEAD_EAR_MIN_DIST = 0.02;

const clamp1 = (v: number): number => Math.min(1, Math.max(-1, v));

/**
 * Derive the camera-parallax FaceFrame from RAW (unmirrored) pose landmarks
 * using nose (0) and ears (7, 8). Pure; the single live source of frame.face
 * since FaceLandmarker was deleted.
 *
 * SIGN DERIVATION (player space per types.ts: positive yaw = the player
 * looks toward their OWN right, positive pitch = looking up):
 * - The raw frame is an unmirrored photo of the player, so the player's own
 *   right side sits at SMALL raw x (the viewer's left). Turning the head
 *   toward the player's right therefore moves the nose toward smaller raw x
 *   than the ear midpoint. Mirroring (x -> 1 - x) flips that into player
 *   space, where the player's right is +x: mirrored nose x GREATER than the
 *   mirrored ear midpoint x means the player looks right. We mirror first
 *   and read the offset directly, so the sign falls out of the same mapping
 *   every other player-space point uses.
 * - Image y grows DOWN. Looking up lifts the nose above the ear line
 *   (smaller y), so pitch uses earMidY - noseY.
 * Both offsets are normalized by the ear-to-ear distance (distance-invariant)
 * and mapped through an asin-style clamp: offset ~ noseRadius * sin(angle)
 * with noseRadius ~ NOSE_RADIUS_RATIO * earDist.
 *
 * position: the mirrored nose point (z straight from the nose landmark).
 * confidence: mean visibility of nose + ears, 1 when absent.
 * Degenerate ears (collapsed together) -> null.
 */
export function headPoseFromPose(
  landmarks: readonly RawPoseLandmark[],
): FaceFrame | null {
  const nose = landmarks[POSE_LM.NOSE];
  const leftEar = landmarks[POSE_LM.LEFT_EAR];
  const rightEar = landmarks[POSE_LM.RIGHT_EAR];
  if (!nose || !leftEar || !rightEar) return null;

  const earDist = Math.hypot(leftEar.x - rightEar.x, leftEar.y - rightEar.y);
  if (!(earDist >= HEAD_EAR_MIN_DIST)) return null;

  // Mirror into player space first; signs then read directly off player axes.
  const noseM = screenVec(nose);
  const earMidM = {
    x: 1 - (leftEar.x + rightEar.x) / 2,
    y: (leftEar.y + rightEar.y) / 2,
  };
  const radius = NOSE_RADIUS_RATIO * earDist;
  // Player looks right => mirrored nose x exceeds the mirrored ear-mid x.
  const yaw = Math.asin(clamp1((noseM.x - earMidM.x) / radius));
  // Player looks up => nose rises above the ear line (y grows down).
  const pitch = Math.asin(clamp1((earMidM.y - noseM.y) / radius));

  let visSum = 0;
  let visCount = 0;
  for (const lm of [nose, leftEar, rightEar]) {
    const v = lm.visibility;
    if (typeof v === 'number' && Number.isFinite(v)) {
      visSum += v;
      visCount++;
    }
  }
  return {
    yaw,
    pitch,
    position: noseM,
    confidence: visCount > 0 ? visSum / visCount : 1,
  };
}

// ---------------------------------------------------------------------------
// Pose interpolation (worker path, R3 Phase 2)
// ---------------------------------------------------------------------------

/**
 * Extrapolation cap: an interpolation target further than this past the
 * newest sample is clamped, so a stalled worker freezes the pose at +80 ms
 * instead of launching the joints along a stale velocity.
 */
export const POSE_EXTRAPOLATION_CAP_MS = 80;

const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

function lerpVec(a: Vec3, b: Vec3, u: number): Vec3 {
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u) };
}

function lerpArm(a: PoseArm, b: PoseArm, u: number): PoseArm {
  return {
    shoulder: lerpVec(a.shoulder, b.shoulder, u),
    elbow: lerpVec(a.elbow, b.elbow, u),
    wrist: lerpVec(a.wrist, b.wrist, u),
    hip: lerpVec(a.hip, b.hip, u),
  };
}

/**
 * Linear interpolation between two pose SAMPLES (a older, b newer) at target
 * time tMs, so per-frame consumers see smooth pose between ~25 Hz worker
 * results. tMs beyond b.t extrapolates linearly, capped at
 * POSE_EXTRAPOLATION_CAP_MS past b.t; tMs before a.t clamps to a. The
 * result carries `interpolated: true` and t = the (capped) target time;
 * sample-timestamp consumers (the elbow tracker) skip such frames.
 * Non-joint fields (confidence, visibility) come from the newer sample.
 * World joints interpolate only when both samples carry them; the head
 * likewise. Pure. Returns b unchanged (minus flag) when the samples are not
 * time-ordered (a.t >= b.t).
 */
export function lerpPoseFrames(a: PoseFrame, b: PoseFrame, tMs: number): PoseFrame {
  if (!(b.t > a.t)) return b;
  const capped = Math.min(tMs, b.t + POSE_EXTRAPOLATION_CAP_MS);
  const target = Math.max(capped, a.t);
  const u = (target - a.t) / (b.t - a.t);
  const world =
    a.world && b.world
      ? {
          left: lerpArm(a.world.left, b.world.left, u),
          right: lerpArm(a.world.right, b.world.right, u),
        }
      : null;
  const head =
    a.head && b.head
      ? {
          nose: lerpVec(a.head.nose, b.head.nose, u),
          leftEye: lerpVec(a.head.leftEye, b.head.leftEye, u),
          rightEye: lerpVec(a.head.rightEye, b.head.rightEye, u),
          leftEar: lerpVec(a.head.leftEar, b.head.leftEar, u),
          rightEar: lerpVec(a.head.rightEar, b.head.rightEar, u),
        }
      : undefined;
  return {
    t: target,
    left: lerpArm(a.left, b.left, u),
    right: lerpArm(a.right, b.right, u),
    world,
    confidence: b.confidence,
    ...(b.wristVisibility ? { wristVisibility: b.wristVisibility } : {}),
    ...(head ? { head } : {}),
    interpolated: true,
  };
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
 * Create a PoseLandmarker: 1 pose, VIDEO mode, GPU delegate with CPU
 * fallback. `variant` selects the model asset; LITE is the shipped default
 * (FULL only via explicit opt-in, e.g. perf gate &pose=full, pending the
 * measured decision rule). MediaPipe is dynamically imported so tests never
 * load it.
 */
export async function createPoseLandmarker(
  variant: PoseModelVariant = 'lite',
): Promise<PoseLandmarker> {
  const vision = await import('@mediapipe/tasks-vision');
  const fileset = await vision.FilesetResolver.forVisionTasks(VISION_WASM_URL);
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: POSE_MODEL_URLS[variant], delegate },
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

/**
 * One pose detection producing BOTH the PoseFrame and the derived head-pose
 * FaceFrame from the same raw landmarks (main-thread fallback path; the
 * worker path runs the same two pure functions on posted raw arrays).
 */
export function detectPoseAndHead(
  landmarker: PoseLandmarker,
  video: HTMLVideoElement,
  timestampMs: number,
): { pose: PoseFrame | null; face: FaceFrame | null } {
  const result = landmarker.detectForVideo(video, timestampMs);
  const landmarks = result.landmarks[0];
  if (!landmarks || landmarks.length <= POSE_LM.RIGHT_HIP) {
    return { pose: null, face: null };
  }
  const world = result.worldLandmarks[0] ?? null;
  return {
    pose: extractPoseFrame(landmarks, world, timestampMs),
    face: headPoseFromPose(landmarks),
  };
}
