/**
 * Full-body signals (src/tracking/body.ts) against synthetic standing,
 * seated and rotated poses, plus the knee/ankle extraction and interpolation
 * added to poseSource.ts in R3 Phase 3. Pure math, no DOM, no MediaPipe.
 */

import { describe, expect, it } from 'vitest';
import {
  COM_HIP_WEIGHT,
  COM_SHOULDER_WEIGHT,
  KNEE_STRAIGHT_RAD,
  STANDING_KNEE_WEIGHT,
  STANDING_RATIO_WEIGHT,
  hipLine,
  kneeBendRad,
  shoulderLine,
  stanceWidth,
  standingScore,
  torsoRotationRad,
  verticalCenterOfMass,
} from '../src/tracking/body';
import {
  extractPoseFrame,
  lerpPoseFrames,
  LEG_VISIBILITY_FLOOR,
  type RawPoseLandmark,
} from '../src/tracking/poseSource';
import { POSE_LM } from '../src/tracking/types';
import type { PoseFrame, PoseLeg, Vec3 } from '../src/tracking/types';

// ---------------------------------------------------------------------------
// Synthetic poses (player screen space: x grows right, y grows DOWN)
// ---------------------------------------------------------------------------

const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

interface PoseOpts {
  shoulderY?: number;
  hipY?: number;
  shoulderHalf?: number;
  hipHalf?: number;
  legs?: { left: PoseLeg; right: PoseLeg };
  world?: PoseFrame['world'];
}

function makePose(opts: PoseOpts = {}): PoseFrame {
  const sy = opts.shoulderY ?? 0.28;
  const hy = opts.hipY ?? 0.65;
  const sh = opts.shoulderHalf ?? 0.14;
  const hh = opts.hipHalf ?? 0.08;
  const arm = (m: number) => ({
    shoulder: v(0.5 + sh * m, sy),
    elbow: v(0.5 + (sh + 0.04) * m, (sy + hy) / 2),
    wrist: v(0.5 + (sh + 0.08) * m, hy),
    hip: v(0.5 + hh * m, hy),
  });
  return {
    t: 0,
    left: arm(-1),
    right: arm(1),
    world: opts.world ?? null,
    confidence: 1,
    ...(opts.legs ? { legs: opts.legs } : {}),
  };
}

/** Standing: torso span 1.3x shoulder width, straight visible knees. */
function standingPose(): PoseFrame {
  return makePose({
    shoulderY: 0.28,
    hipY: 0.65,
    shoulderHalf: 0.14,
    legs: {
      left: { knee: v(0.43, 0.82), ankle: v(0.43, 0.97) },
      right: { knee: v(0.57, 0.82), ankle: v(0.57, 0.97) },
    },
  });
}

/** Seated: foreshortened torso (span ~0.59x width), sharply bent knees. */
function seatedPose(): PoseFrame {
  return makePose({
    shoulderY: 0.35,
    hipY: 0.55,
    shoulderHalf: 0.17,
    hipHalf: 0.06,
    legs: {
      left: { knee: v(0.44, 0.72), ankle: v(0.32, 0.74) },
      right: { knee: v(0.56, 0.72), ankle: v(0.68, 0.74) },
    },
  });
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

describe('shoulderLine / hipLine', () => {
  it('reports center, width and zero tilt for level joints', () => {
    const p = makePose({ shoulderY: 0.3, shoulderHalf: 0.14, hipY: 0.6, hipHalf: 0.08 });
    const s = shoulderLine(p);
    expect(s.center.x).toBeCloseTo(0.5, 10);
    expect(s.center.y).toBeCloseTo(0.3, 10);
    expect(s.width).toBeCloseTo(0.28, 10);
    expect(s.tiltRad).toBeCloseTo(0, 10);
    const h = hipLine(p);
    expect(h.center.y).toBeCloseTo(0.6, 10);
    expect(h.width).toBeCloseTo(0.16, 10);
  });

  it('tilt is positive when the player right side sits lower (y down)', () => {
    const p = makePose();
    p.right.shoulder = v(0.64, 0.34);
    p.left.shoulder = v(0.36, 0.3);
    const s = shoulderLine(p);
    expect(s.tiltRad).toBeCloseTo(Math.atan2(0.04, 0.28), 10);
    expect(s.tiltRad).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Torso rotation
// ---------------------------------------------------------------------------

describe('torsoRotationRad', () => {
  it('is ~0 facing the camera and positive turning right (world path)', () => {
    const frontal = makePose({
      world: {
        left: {
          shoulder: v(-0.18, -0.25, 0),
          elbow: v(-0.2, 0, 0),
          wrist: v(-0.2, 0.2, 0),
          hip: v(-0.1, 0.25, 0),
        },
        right: {
          shoulder: v(0.18, -0.25, 0),
          elbow: v(0.2, 0, 0),
          wrist: v(0.2, 0.2, 0),
          hip: v(0.1, 0.25, 0),
        },
      },
    });
    expect(torsoRotationRad(frontal)).toBeCloseTo(0, 10);

    // Turned toward the player's own right: the right shoulder swings
    // toward the camera (z more negative), the left away.
    const turned = makePose({ world: frontal.world });
    if (!turned.world) throw new Error('world expected');
    turned.world.left.shoulder = v(-0.18, -0.25, 0.1);
    turned.world.right.shoulder = v(0.18, -0.25, -0.1);
    expect(torsoRotationRad(turned)).toBeCloseTo(Math.atan2(0.2, 0.36), 10);
    expect(torsoRotationRad(turned)).toBeGreaterThan(0);
  });

  it('falls back to screen-landmark z when world joints are absent', () => {
    const p = makePose();
    p.left.shoulder = v(0.36, 0.28, 0.05);
    p.right.shoulder = v(0.64, 0.28, -0.05);
    expect(torsoRotationRad(p)).toBeCloseTo(Math.atan2(0.1, 0.28), 10);
  });
});

// ---------------------------------------------------------------------------
// Stance width
// ---------------------------------------------------------------------------

describe('stanceWidth', () => {
  it('uses the ankle spread over the shoulder width when ankles exist', () => {
    const p = standingPose();
    expect(stanceWidth(p)).toBeCloseTo(0.14 / 0.28, 10);
  });

  it('falls back to knees, then hips', () => {
    const knees = makePose({
      legs: {
        left: { knee: v(0.4, 0.8) },
        right: { knee: v(0.6, 0.8) },
      },
    });
    expect(stanceWidth(knees)).toBeCloseTo(0.2 / 0.28, 10);

    const hipsOnly = makePose({ hipHalf: 0.08, shoulderHalf: 0.14 });
    expect(stanceWidth(hipsOnly)).toBeCloseTo(0.16 / 0.28, 10);
  });

  it('is 0 for a degenerate shoulder width', () => {
    const p = makePose({ shoulderHalf: 0 });
    expect(stanceWidth(p)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Knee bend
// ---------------------------------------------------------------------------

describe('kneeBendRad', () => {
  it('reads near pi for a straight standing leg', () => {
    const angle = kneeBendRad(standingPose(), 'left');
    if (angle === null) throw new Error('expected an angle');
    expect(angle).toBeGreaterThan(KNEE_STRAIGHT_RAD);
    expect(angle).toBeLessThanOrEqual(Math.PI);
  });

  it('reads near pi/2 for a seated leg', () => {
    const angle = kneeBendRad(seatedPose(), 'right');
    if (angle === null) throw new Error('expected an angle');
    expect(angle).toBeGreaterThan(1.2);
    expect(angle).toBeLessThan(1.9);
  });

  it('is null when the knee or ankle is not visible', () => {
    expect(kneeBendRad(makePose(), 'left')).toBeNull();
    const kneeOnly = makePose({
      legs: { left: { knee: v(0.43, 0.82) }, right: {} },
    });
    expect(kneeBendRad(kneeOnly, 'left')).toBeNull();
    expect(kneeBendRad(kneeOnly, 'right')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Vertical center of mass
// ---------------------------------------------------------------------------

describe('verticalCenterOfMass', () => {
  it('is the documented hip-heavy blend of the line centers', () => {
    const p = makePose({ shoulderY: 0.3, hipY: 0.6 });
    expect(verticalCenterOfMass(p)).toBeCloseTo(
      COM_SHOULDER_WEIGHT * 0.3 + COM_HIP_WEIGHT * 0.6,
      10,
    );
  });

  it('moves less under a bow (shoulders only) than a real duck (both)', () => {
    const base = makePose({ shoulderY: 0.3, hipY: 0.6 });
    const bow = makePose({ shoulderY: 0.42, hipY: 0.6 });
    const duck = makePose({ shoulderY: 0.42, hipY: 0.72 });
    const bowDrop = verticalCenterOfMass(bow) - verticalCenterOfMass(base);
    const duckDrop = verticalCenterOfMass(duck) - verticalCenterOfMass(base);
    expect(bowDrop).toBeGreaterThan(0);
    expect(duckDrop).toBeGreaterThan(bowDrop * 2);
  });
});

// ---------------------------------------------------------------------------
// Standing score
// ---------------------------------------------------------------------------

describe('standingScore', () => {
  it('is ~1 for a standing pose with straight visible knees', () => {
    expect(standingScore(standingPose())).toBeGreaterThan(0.95);
  });

  it('is ~0 for a seated pose with bent knees', () => {
    expect(standingScore(seatedPose())).toBeLessThan(0.1);
  });

  it('legs hidden: judged by the torso ratio with a neutral knee term', () => {
    const standingNoLegs = makePose({ shoulderY: 0.28, hipY: 0.65, shoulderHalf: 0.14 });
    expect(standingScore(standingNoLegs)).toBeCloseTo(
      STANDING_RATIO_WEIGHT * 1 + STANDING_KNEE_WEIGHT * 0.5,
      5,
    );
    const seatedNoLegs = makePose({
      shoulderY: 0.35,
      hipY: 0.55,
      shoulderHalf: 0.17,
    });
    expect(standingScore(seatedNoLegs)).toBeCloseTo(STANDING_KNEE_WEIGHT * 0.5, 5);
  });

  it('is 0 for a degenerate (profile) shoulder width', () => {
    expect(standingScore(makePose({ shoulderHalf: 0 }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Leg extraction and interpolation (poseSource.ts additions)
// ---------------------------------------------------------------------------

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

describe('extractPoseFrame legs', () => {
  it('mirrors visible knees and ankles into the optional legs field', () => {
    const lms = rawLandmarks({
      [POSE_LM.LEFT_KNEE]: { x: 0.6, y: 0.8, z: 0, visibility: 0.9 },
      [POSE_LM.RIGHT_KNEE]: { x: 0.4, y: 0.8, z: 0, visibility: 0.9 },
      [POSE_LM.LEFT_ANKLE]: { x: 0.6, y: 0.95, z: 0, visibility: 0.9 },
      [POSE_LM.RIGHT_ANKLE]: { x: 0.4, y: 0.95, z: 0, visibility: 0.9 },
    });
    const frame = extractPoseFrame(lms, null, 0);
    if (!frame || !frame.legs) throw new Error('expected legs');
    // Anatomical LEFT knee at image x 0.6 mirrors to player-left x 0.4.
    expect(frame.legs.left.knee?.x).toBeCloseTo(0.4, 10);
    expect(frame.legs.left.ankle?.y).toBeCloseTo(0.95, 10);
    expect(frame.legs.right.knee?.x).toBeCloseTo(0.6, 10);
  });

  it('drops leg points below the visibility floor; all hidden means no legs', () => {
    const partial = rawLandmarks({
      [POSE_LM.LEFT_KNEE]: { x: 0.6, y: 0.8, z: 0, visibility: 0.9 },
      [POSE_LM.RIGHT_KNEE]: {
        x: 0.4,
        y: 0.8,
        z: 0,
        visibility: LEG_VISIBILITY_FLOOR - 0.1,
      },
      [POSE_LM.LEFT_ANKLE]: { x: 0.6, y: 0.95, z: 0, visibility: 0.1 },
      [POSE_LM.RIGHT_ANKLE]: { x: 0.4, y: 0.95, z: 0, visibility: 0.1 },
    });
    const frame = extractPoseFrame(partial, null, 0);
    if (!frame || !frame.legs) throw new Error('expected legs');
    expect(frame.legs.left.knee).toBeDefined();
    expect(frame.legs.right.knee).toBeUndefined();
    expect(frame.legs.left.ankle).toBeUndefined();

    const hidden = rawLandmarks({});
    for (const i of [
      POSE_LM.LEFT_KNEE,
      POSE_LM.RIGHT_KNEE,
      POSE_LM.LEFT_ANKLE,
      POSE_LM.RIGHT_ANKLE,
    ]) {
      const lm = hidden[i];
      if (lm) lm.visibility = 0.1;
    }
    expect(extractPoseFrame(hidden, null, 0)?.legs).toBeUndefined();
  });
});

describe('lerpPoseFrames legs', () => {
  it('interpolates matching leg points and passes lone new points through', () => {
    const a = makePose({
      legs: { left: { knee: v(0.4, 0.8) }, right: {} },
    });
    a.t = 0;
    const b = makePose({
      legs: {
        left: { knee: v(0.5, 0.9) },
        right: { knee: v(0.6, 0.8) },
      },
    });
    b.t = 100;
    const mid = lerpPoseFrames(a, b, 50);
    expect(mid.legs?.left.knee?.x).toBeCloseTo(0.45, 10);
    expect(mid.legs?.left.knee?.y).toBeCloseTo(0.85, 10);
    // The right knee only exists on the newer sample: passed through as-is.
    expect(mid.legs?.right.knee?.x).toBeCloseTo(0.6, 10);
    expect(mid.interpolated).toBe(true);
  });

  it('keeps legs absent when the newer sample has none', () => {
    const a = makePose({ legs: { left: { knee: v(0.4, 0.8) }, right: {} } });
    a.t = 0;
    const b = makePose();
    b.t = 100;
    expect(lerpPoseFrames(a, b, 50).legs).toBeUndefined();
  });
});
