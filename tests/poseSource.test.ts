/**
 * Pure pose-source math (src/tracking/poseSource.ts): player-space
 * mirroring for screen and world joints, elbow angle at known geometries,
 * angular velocity from consecutive samples, the head-pose derivation that
 * replaced FaceLandmarker (SIGN CONTRACT per types.ts), and the worker-path
 * pose interpolation. No MediaPipe, no camera.
 */

import { describe, expect, it } from 'vitest';
import {
  HEAD_EAR_MIN_DIST,
  NOSE_RADIUS_RATIO,
  POSE_EXTRAPOLATION_CAP_MS,
  POSE_MODEL_URLS,
  elbowAngle,
  elbowAngularVelocity,
  extractPoseFrame,
  headPoseFromPose,
  lerpPoseFrames,
  type RawPoseLandmark,
} from '../src/tracking/poseSource';
import { POSE_LM } from '../src/tracking/types';
import type { PoseFrame, Vec3 } from '../src/tracking/types';

/** 33 raw landmarks, all parked at a filler point unless overridden. */
function rawLandmarks(
  overrides: Partial<Record<number, RawPoseLandmark>>,
): RawPoseLandmark[] {
  const out: RawPoseLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
  }));
  for (const [key, value] of Object.entries(overrides)) {
    if (value) out[Number(key)] = value;
  }
  return out;
}

describe('extractPoseFrame', () => {
  it('mirrors screen joints (x -> 1 - x) and keeps y and z', () => {
    // The person's anatomical LEFT shoulder sits on the image RIGHT of an
    // unmirrored frame (x = 0.7); after mirroring it must land on the
    // player-space LEFT (x = 0.3), consistent with the hand convention.
    const lms = rawLandmarks({
      [POSE_LM.LEFT_SHOULDER]: { x: 0.7, y: 0.3, z: -0.1 },
      [POSE_LM.RIGHT_SHOULDER]: { x: 0.3, y: 0.31, z: -0.1 },
    });
    const frame = extractPoseFrame(lms, null, 1234);
    if (!frame) throw new Error('expected a PoseFrame');
    expect(frame.t).toBe(1234);
    expect(frame.left.shoulder.x).toBeCloseTo(0.3, 10);
    expect(frame.left.shoulder.y).toBeCloseTo(0.3, 10);
    expect(frame.left.shoulder.z).toBeCloseTo(-0.1, 10);
    expect(frame.right.shoulder.x).toBeCloseTo(0.7, 10);
    expect(frame.left.shoulder.x).toBeLessThan(frame.right.shoulder.x);
    expect(frame.world).toBeNull();
  });

  it('mirrors world joints by negating x only', () => {
    const lms = rawLandmarks({});
    const world = rawLandmarks({
      [POSE_LM.LEFT_WRIST]: { x: 0.25, y: -0.1, z: -0.3 },
    });
    const frame = extractPoseFrame(lms, world, 0);
    if (!frame || !frame.world) throw new Error('expected world joints');
    expect(frame.world.left.wrist.x).toBeCloseTo(-0.25, 10);
    expect(frame.world.left.wrist.y).toBeCloseTo(-0.1, 10);
    expect(frame.world.left.wrist.z).toBeCloseTo(-0.3, 10);
  });

  it('averages joint visibility into confidence, defaulting to 1', () => {
    const noVis = extractPoseFrame(rawLandmarks({}), null, 0);
    expect(noVis?.confidence).toBe(1);

    const lms = rawLandmarks({});
    for (const i of [
      POSE_LM.LEFT_SHOULDER,
      POSE_LM.RIGHT_SHOULDER,
      POSE_LM.LEFT_ELBOW,
      POSE_LM.RIGHT_ELBOW,
      POSE_LM.LEFT_WRIST,
      POSE_LM.RIGHT_WRIST,
      POSE_LM.LEFT_HIP,
      POSE_LM.RIGHT_HIP,
    ]) {
      const lm = lms[i];
      if (lm) lm.visibility = 0.5;
    }
    const withVis = extractPoseFrame(lms, null, 0);
    expect(withVis?.confidence).toBeCloseTo(0.5, 10);
  });

  it('returns null when required joints are missing', () => {
    const tooShort: RawPoseLandmark[] = Array.from({ length: 12 }, () => ({
      x: 0.5,
      y: 0.5,
      z: 0,
    }));
    expect(extractPoseFrame(tooShort, null, 0)).toBeNull();
  });

  it('fills the optional head points, mirrored like every screen joint', () => {
    // Anatomical LEFT ear sits at image RIGHT (x = 0.6) on an unmirrored
    // frame; after mirroring it must land player-left (x = 0.4).
    const lms = rawLandmarks({
      [POSE_LM.NOSE]: { x: 0.5, y: 0.3, z: -0.2 },
      [POSE_LM.LEFT_EYE]: { x: 0.55, y: 0.27, z: -0.15 },
      [POSE_LM.RIGHT_EYE]: { x: 0.45, y: 0.27, z: -0.15 },
      [POSE_LM.LEFT_EAR]: { x: 0.6, y: 0.3, z: -0.05 },
      [POSE_LM.RIGHT_EAR]: { x: 0.4, y: 0.3, z: -0.05 },
    });
    const frame = extractPoseFrame(lms, null, 0);
    if (!frame || !frame.head) throw new Error('expected head points');
    expect(frame.head.nose.x).toBeCloseTo(0.5, 10);
    expect(frame.head.nose.z).toBeCloseTo(-0.2, 10);
    expect(frame.head.leftEar.x).toBeCloseTo(0.4, 10);
    expect(frame.head.rightEar.x).toBeCloseTo(0.6, 10);
    expect(frame.head.leftEye.x).toBeCloseTo(0.45, 10);
    expect(frame.head.rightEye.x).toBeCloseTo(0.55, 10);
    expect(frame.head.leftEar.x).toBeLessThan(frame.head.rightEar.x);
  });
});

// ---------------------------------------------------------------------------
// headPoseFromPose: the FaceLandmarker replacement (SIGN CONTRACT)
// ---------------------------------------------------------------------------

/**
 * Head-only raw landmark set. On an unmirrored frame the player's own
 * RIGHT side sits at SMALL image x, so the anatomical-left ear (index 7)
 * gets the LARGER x. earDist 0.2 -> nose radius 0.1 with the 0.5 ratio.
 */
function headLandmarks(
  noseX: number,
  noseY: number,
  visibility?: number,
): RawPoseLandmark[] {
  const vis = visibility !== undefined ? { visibility } : {};
  return rawLandmarks({
    [POSE_LM.NOSE]: { x: noseX, y: noseY, z: -0.3, ...vis },
    [POSE_LM.LEFT_EAR]: { x: 0.6, y: 0.5, z: 0, ...vis },
    [POSE_LM.RIGHT_EAR]: { x: 0.4, y: 0.5, z: 0, ...vis },
  });
}

describe('headPoseFromPose (sign contract per types.ts)', () => {
  it('is neutral when the nose sits centered on the ear midpoint', () => {
    const face = headPoseFromPose(headLandmarks(0.5, 0.5));
    if (!face) throw new Error('expected a FaceFrame');
    expect(face.yaw).toBeCloseTo(0, 10);
    expect(face.pitch).toBeCloseTo(0, 10);
  });

  it('nose toward the PLAYER-RIGHT ear gives POSITIVE yaw', () => {
    // Player's right = small raw x (unmirrored photo): the player-right ear
    // is the anatomical right ear at x = 0.4. Nose drifts toward it.
    const face = headPoseFromPose(headLandmarks(0.45, 0.5));
    if (!face) throw new Error('expected a FaceFrame');
    // offset in mirrored space = 0.05, radius = NOSE_RADIUS_RATIO * 0.2.
    expect(face.yaw).toBeCloseTo(Math.asin(0.05 / (NOSE_RADIUS_RATIO * 0.2)), 10);
    expect(face.yaw).toBeGreaterThan(0);
    expect(face.pitch).toBeCloseTo(0, 10);
  });

  it('nose toward the player-LEFT ear gives negative yaw', () => {
    const face = headPoseFromPose(headLandmarks(0.55, 0.5));
    if (!face) throw new Error('expected a FaceFrame');
    expect(face.yaw).toBeLessThan(0);
  });

  it('nose ABOVE the ear line (looking up, y grows down) gives POSITIVE pitch', () => {
    const face = headPoseFromPose(headLandmarks(0.5, 0.45));
    if (!face) throw new Error('expected a FaceFrame');
    expect(face.pitch).toBeCloseTo(Math.asin(0.05 / (NOSE_RADIUS_RATIO * 0.2)), 10);
    expect(face.pitch).toBeGreaterThan(0);
    expect(face.yaw).toBeCloseTo(0, 10);
  });

  it('nose below the ear line gives negative pitch', () => {
    const face = headPoseFromPose(headLandmarks(0.5, 0.55));
    if (!face) throw new Error('expected a FaceFrame');
    expect(face.pitch).toBeLessThan(0);
  });

  it('position is the MIRRORED nose point with the raw z', () => {
    const face = headPoseFromPose(headLandmarks(0.45, 0.4));
    if (!face) throw new Error('expected a FaceFrame');
    expect(face.position.x).toBeCloseTo(0.55, 10); // 1 - 0.45
    expect(face.position.y).toBeCloseTo(0.4, 10);
    expect(face.position.z).toBeCloseTo(-0.3, 10);
  });

  it('an extreme offset clamps through asin instead of going NaN', () => {
    // Nose far toward small raw x = far toward the player's RIGHT: yaw
    // saturates at +pi/2 (clamped), never NaN.
    const face = headPoseFromPose(headLandmarks(0.1, 0.5));
    if (!face) throw new Error('expected a FaceFrame');
    expect(face.yaw).toBeCloseTo(Math.PI / 2, 10);
    expect(Number.isFinite(face.yaw)).toBe(true);
  });

  it('confidence is the mean nose+ear visibility, 1 when absent', () => {
    expect(headPoseFromPose(headLandmarks(0.5, 0.5))?.confidence).toBe(1);
    expect(headPoseFromPose(headLandmarks(0.5, 0.5, 0.4))?.confidence).toBeCloseTo(
      0.4,
      10,
    );
  });

  it('returns null for collapsed ears (degenerate) and missing landmarks', () => {
    const collapsed = rawLandmarks({
      [POSE_LM.NOSE]: { x: 0.5, y: 0.4, z: 0 },
      [POSE_LM.LEFT_EAR]: { x: 0.5, y: 0.5, z: 0 },
      [POSE_LM.RIGHT_EAR]: { x: 0.5 + HEAD_EAR_MIN_DIST / 2, y: 0.5, z: 0 },
    });
    expect(headPoseFromPose(collapsed)).toBeNull();
    expect(headPoseFromPose([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// lerpPoseFrames: worker-path per-frame interpolation
// ---------------------------------------------------------------------------

function sampleAt(t: number, x: number): PoseFrame {
  const arm = (dx: number) => ({
    shoulder: { x: x + dx, y: 0.3, z: 0 },
    elbow: { x: x + dx, y: 0.5, z: 0 },
    wrist: { x: x + dx, y: 0.6, z: 0 },
    hip: { x: x + dx, y: 0.75, z: 0 },
  });
  return {
    t,
    left: arm(-0.1),
    right: arm(0.1),
    world: { left: arm(-0.1), right: arm(0.1) },
    confidence: 0.9,
    wristVisibility: { left: 0.8, right: 0.85 },
  };
}

describe('lerpPoseFrames', () => {
  const a = sampleAt(1000, 0.4);
  const b = sampleAt(1040, 0.6);

  it('interpolates joints linearly at the midpoint and marks the frame', () => {
    const mid = lerpPoseFrames(a, b, 1020);
    expect(mid.interpolated).toBe(true);
    expect(mid.t).toBe(1020);
    expect(mid.left.wrist.x).toBeCloseTo(0.4, 10); // (0.3 + 0.5) / 2
    expect(mid.right.wrist.x).toBeCloseTo(0.6, 10);
    expect(mid.world?.left.elbow.x).toBeCloseTo(0.4, 10);
    // Non-joint metadata rides the newer sample.
    expect(mid.confidence).toBe(0.9);
    expect(mid.wristVisibility).toEqual({ left: 0.8, right: 0.85 });
  });

  it('extrapolates past the newer sample, capped at POSE_EXTRAPOLATION_CAP_MS', () => {
    const cap = b.t + POSE_EXTRAPOLATION_CAP_MS;
    const atCap = lerpPoseFrames(a, b, cap);
    expect(atCap.t).toBe(cap);
    // u = 3 at the cap (80 ms past a 40 ms gap): 0.3 + 3 * 0.2 = 0.9.
    expect(atCap.left.wrist.x).toBeCloseTo(0.9, 10);
    const beyond = lerpPoseFrames(a, b, cap + 500);
    expect(beyond.t).toBe(cap); // frozen at the cap, not launched further
    expect(beyond.left.wrist.x).toBeCloseTo(0.9, 10);
  });

  it('clamps targets before the older sample to the older sample', () => {
    const before = lerpPoseFrames(a, b, 900);
    expect(before.t).toBe(1000);
    expect(before.left.wrist.x).toBeCloseTo(0.3, 10);
  });

  it('returns the newer sample for non-ordered inputs', () => {
    const out = lerpPoseFrames(b, a, 1020);
    expect(out).toBe(a);
  });

  it('drops world when either sample lacks it', () => {
    const noWorld: PoseFrame = { ...a, world: null };
    expect(lerpPoseFrames(noWorld, b, 1020).world).toBeNull();
  });
});

describe('POSE_MODEL_URLS', () => {
  it('ships LITE as default alongside the selectable FULL asset', () => {
    expect(POSE_MODEL_URLS.lite).toContain('pose_landmarker_lite');
    expect(POSE_MODEL_URLS.full).toBe(
      'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    );
  });
});

describe('elbowAngle', () => {
  const elbow: Vec3 = { x: 0, y: 0, z: 0 };

  it('is ~pi for a straight arm', () => {
    const shoulder: Vec3 = { x: 0, y: -0.3, z: 0 };
    const wrist: Vec3 = { x: 0, y: 0.25, z: 0 };
    expect(elbowAngle(shoulder, elbow, wrist)).toBeCloseTo(Math.PI, 6);
  });

  it('is ~pi/2 for a right-angle guard', () => {
    const shoulder: Vec3 = { x: 0, y: -0.3, z: 0 };
    const wrist: Vec3 = { x: 0, y: 0, z: -0.25 };
    expect(elbowAngle(shoulder, elbow, wrist)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('is invariant to segment lengths', () => {
    const a = elbowAngle({ x: 0, y: -1, z: 0 }, elbow, { x: 0.5, y: 0.5, z: 0 });
    const b = elbowAngle({ x: 0, y: -0.2, z: 0 }, elbow, { x: 0.1, y: 0.1, z: 0 });
    expect(a).toBeCloseTo(b, 6);
  });

  it('guards degenerate joints (collapsed onto the elbow)', () => {
    expect(elbowAngle(elbow, elbow, { x: 1, y: 0, z: 0 })).toBe(0);
    expect(elbowAngle({ x: 1, y: 0, z: 0 }, elbow, elbow)).toBe(0);
  });
});

describe('elbowAngularVelocity', () => {
  it('is positive when the angle opens (extension) and scales with dt', () => {
    // 90 degrees -> straight in 150 ms: (pi - pi/2) / 0.15 ~ 10.47 rad/s.
    const v = elbowAngularVelocity(Math.PI / 2, Math.PI, 0.15);
    expect(v).toBeCloseTo((Math.PI / 2) / 0.15, 6);
    expect(v).toBeGreaterThan(0);
  });

  it('is negative when the arm re-flexes', () => {
    expect(elbowAngularVelocity(Math.PI, Math.PI / 2, 0.1)).toBeLessThan(0);
  });

  it('yields 0 for non-positive dt', () => {
    expect(elbowAngularVelocity(1, 2, 0)).toBe(0);
    expect(elbowAngularVelocity(1, 2, -0.05)).toBe(0);
  });
});
