/**
 * Pure pose-source math (src/tracking/poseSource.ts): player-space
 * mirroring for screen and world joints, elbow angle at known geometries,
 * and angular velocity from consecutive samples. No MediaPipe, no camera.
 */

import { describe, expect, it } from 'vitest';
import {
  elbowAngle,
  elbowAngularVelocity,
  extractPoseFrame,
  type RawPoseLandmark,
} from '../src/tracking/poseSource';
import { POSE_LM } from '../src/tracking/types';
import type { Vec3 } from '../src/tracking/types';

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
