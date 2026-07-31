/**
 * Pure ROI-crop math (src/tracking/roiCrop.ts): crop box sizing, clamping
 * and edge shrink, the finger-ward follow shift, CropSmoother deadbands and
 * snap-out, exact crop<->full mapping round trips, the pose-side handedness
 * mapping, and the per-frame path selection. No MediaPipe, no camera.
 */

import { describe, expect, it } from 'vitest';
import {
  CROP_CENTER_DEADBAND,
  CROP_FORWARD_SHIFT,
  CROP_SIDE_MAX,
  CROP_SIDE_MIN,
  CROP_SIDE_SCALE,
  CROP_SIZE_DEADBAND,
  CropSmoother,
  clampBoxToFrame,
  cropBoxForWrist,
  cropHandToPlayer,
  frameSlotForPoseSide,
  mapCropToFull,
  mapFullToCrop,
  playerToRaw,
  pointInBox,
  selectHandPath,
  type CropBox,
} from '../src/tracking/roiCrop';
import { extractPoseFrame, type RawPoseLandmark } from '../src/tracking/poseSource';
import { POSE_LM } from '../src/tracking/types';
import type { Vec3 } from '../src/tracking/types';

const ASPECT_4_3 = 4 / 3;

function center(box: CropBox): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

// ---------------------------------------------------------------------------
// cropBoxForWrist
// ---------------------------------------------------------------------------

describe('cropBoxForWrist', () => {
  it('sizes the box from the forearm and keeps it square in pixels', () => {
    // Forearm 0.1 -> side 0.24 (within [0.14, 0.5]).
    const box = cropBoxForWrist({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 }, ASPECT_4_3);
    expect(box.w).toBeCloseTo(0.1 * CROP_SIDE_SCALE, 10);
    // Square in pixels: h = w * aspect, so w * frameW === h * frameH.
    expect(box.h).toBeCloseTo(box.w * ASPECT_4_3, 10);
  });

  it('clamps the side to the minimum for a tiny forearm', () => {
    const box = cropBoxForWrist({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.51 }, 1);
    expect(box.w).toBeCloseTo(CROP_SIDE_MIN, 10);
  });

  it('clamps the side to the maximum for a huge forearm', () => {
    const box = cropBoxForWrist({ x: 0.5, y: 0.9 }, { x: 0.5, y: 0.5 }, 1);
    expect(box.w).toBeCloseTo(CROP_SIDE_MAX, 10);
  });

  it('shifts the center toward the fingers along elbow->wrist', () => {
    // Elbow below the wrist: elbow->wrist points UP (-y), so the center
    // sits 0.15 * side above the wrist.
    const side = 0.1 * CROP_SIDE_SCALE;
    const box = cropBoxForWrist({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 }, ASPECT_4_3);
    const c = center(box);
    expect(c.x).toBeCloseTo(0.5, 10);
    expect(c.y).toBeCloseTo(0.5 - CROP_FORWARD_SHIFT * side, 10);
  });

  it('applies no shift when the forearm is degenerate', () => {
    const box = cropBoxForWrist({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 1);
    const c = center(box);
    expect(c.x).toBeCloseTo(0.5, 10);
    expect(c.y).toBeCloseTo(0.5, 10);
    expect(box.w).toBeCloseTo(CROP_SIDE_MIN, 10);
  });

  it('shifts inside the frame at an edge without changing size', () => {
    // Wrist near the left edge, fingers pointing further left.
    const box = cropBoxForWrist({ x: 0.02, y: 0.5 }, { x: 0.12, y: 0.5 }, ASPECT_4_3);
    expect(box.x).toBe(0);
    expect(box.w).toBeCloseTo(0.1 * CROP_SIDE_SCALE, 10);
    expect(box.h).toBeCloseTo(0.1 * CROP_SIDE_SCALE * ASPECT_4_3, 10);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.h).toBeLessThanOrEqual(1);
  });

  it('shrinks uniformly only when the frame cannot hold the box', () => {
    // Very wide frame (aspect 3): side 0.5 would give h = 1.5 > 1, so the
    // box must shrink by 1/1.5 in BOTH dimensions to stay pixel-square.
    const box = cropBoxForWrist({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.1 }, 3);
    expect(box.h).toBeCloseTo(1, 10);
    expect(box.w).toBeCloseTo(1 / 3, 10);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(1);
    expect(box.y).toBeCloseTo(0, 10);
  });

  it('always lands fully inside the frame for random inputs', () => {
    let seed = 1234;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 200; i++) {
      const wrist = { x: rand(), y: rand() };
      const elbow = { x: rand(), y: rand() };
      const aspect = 0.5 + rand() * 2.5;
      const box = cropBoxForWrist(wrist, elbow, aspect);
      expect(box.x).toBeGreaterThanOrEqual(-1e-12);
      expect(box.y).toBeGreaterThanOrEqual(-1e-12);
      expect(box.x + box.w).toBeLessThanOrEqual(1 + 1e-12);
      expect(box.y + box.h).toBeLessThanOrEqual(1 + 1e-12);
      expect(box.w).toBeGreaterThan(0);
      expect(box.h).toBeGreaterThan(0);
    }
  });
});

describe('clampBoxToFrame', () => {
  it('leaves an interior box untouched', () => {
    const box = clampBoxToFrame({ x: 0.2, y: 0.3, w: 0.4, h: 0.4 });
    expect(box).toEqual({ x: 0.2, y: 0.3, w: 0.4, h: 0.4 });
  });

  it('shifts an overhanging box without resizing it', () => {
    const box = clampBoxToFrame({ x: 0.9, y: -0.1, w: 0.3, h: 0.3 });
    expect(box.w).toBeCloseTo(0.3, 10);
    expect(box.h).toBeCloseTo(0.3, 10);
    expect(box.x).toBeCloseTo(0.7, 10);
    expect(box.y).toBeCloseTo(0, 10);
  });
});

// ---------------------------------------------------------------------------
// CropSmoother
// ---------------------------------------------------------------------------

/** A unit-aspect target box helper: center (cx, cy), side s. */
function boxAt(cx: number, cy: number, s: number): CropBox {
  return { x: cx - s / 2, y: cy - s / 2, w: s, h: s };
}

describe('CropSmoother', () => {
  it('adopts the target exactly on the first update', () => {
    const sm = new CropSmoother();
    const target = boxAt(0.5, 0.5, 0.2);
    expect(sm.update(target, { x: 0.5, y: 0.5 }, 0)).toEqual(target);
  });

  it('ignores center moves inside the deadband', () => {
    const sm = new CropSmoother();
    const t1 = boxAt(0.5, 0.5, 0.2);
    sm.update(t1, { x: 0.5, y: 0.5 }, 0);
    // Move 0.003 < 4% of side (0.008): must not budge.
    const nearly = boxAt(0.503, 0.5, 0.2);
    const out = sm.update(nearly, { x: 0.5, y: 0.5 }, 120);
    expect(out).toEqual(t1);
    expect(0.003).toBeLessThan(CROP_CENTER_DEADBAND * 0.2);
  });

  it('converges exponentially toward a center outside the deadband', () => {
    const sm = new CropSmoother();
    sm.update(boxAt(0.5, 0.5, 0.2), { x: 0.5, y: 0.5 }, 0);
    // dt = tau, so alpha = 1 - 1/e.
    const out = sm.update(boxAt(0.6, 0.5, 0.2), { x: 0.55, y: 0.5 }, 120);
    const alpha = 1 - Math.exp(-1);
    expect(center(out).x).toBeCloseTo(0.5 + 0.1 * alpha, 10);
    expect(center(out).y).toBeCloseTo(0.5, 10);
    expect(out.w).toBeCloseTo(0.2, 10);
  });

  it('ignores size changes inside the deadband', () => {
    const sm = new CropSmoother();
    const t1 = boxAt(0.5, 0.5, 0.2);
    sm.update(t1, { x: 0.5, y: 0.5 }, 0);
    // 5% size change < 8% deadband: no breathing.
    const out = sm.update(boxAt(0.5, 0.5, 0.21), { x: 0.5, y: 0.5 }, 120);
    expect(out).toEqual(t1);
    expect(0.05).toBeLessThan(CROP_SIZE_DEADBAND);
  });

  it('converges toward a size outside the deadband', () => {
    const sm = new CropSmoother();
    sm.update(boxAt(0.5, 0.5, 0.2), { x: 0.5, y: 0.5 }, 0);
    const out = sm.update(boxAt(0.5, 0.5, 0.24), { x: 0.5, y: 0.5 }, 120);
    const alpha = 1 - Math.exp(-1);
    expect(out.w).toBeCloseTo(0.2 + 0.04 * alpha, 10);
    expect(out.h).toBeCloseTo(out.w, 10);
  });

  it('snaps to the target when the wrist exits the current box', () => {
    const sm = new CropSmoother();
    sm.update(boxAt(0.5, 0.5, 0.2), { x: 0.5, y: 0.5 }, 0);
    // Wrist at 0.9 is far outside [0.4, 0.6]: snap, no easing.
    const target = boxAt(0.85, 0.5, 0.2);
    const out = sm.update(target, { x: 0.9, y: 0.5 }, 16);
    expect(out).toEqual(target);
  });

  it('re-adopts the target after reset', () => {
    const sm = new CropSmoother();
    sm.update(boxAt(0.5, 0.5, 0.2), { x: 0.5, y: 0.5 }, 0);
    sm.reset();
    expect(sm.current).toBeNull();
    const target = boxAt(0.3, 0.3, 0.3);
    expect(sm.update(target, { x: 0.3, y: 0.3 }, 500)).toEqual(target);
  });
});

describe('pointInBox', () => {
  it('includes edges and excludes the outside', () => {
    const box: CropBox = { x: 0.2, y: 0.2, w: 0.2, h: 0.2 };
    expect(pointInBox({ x: 0.2, y: 0.2 }, box)).toBe(true);
    expect(pointInBox({ x: 0.4, y: 0.4 }, box)).toBe(true);
    expect(pointInBox({ x: 0.3, y: 0.3 }, box)).toBe(true);
    expect(pointInBox({ x: 0.41, y: 0.3 }, box)).toBe(false);
    expect(pointInBox({ x: 0.3, y: 0.19 }, box)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Coordinate mapping
// ---------------------------------------------------------------------------

describe('mapCropToFull / mapFullToCrop', () => {
  it('maps a known point and passes z through unscaled', () => {
    const box: CropBox = { x: 0.5, y: 0.25, w: 0.25, h: 0.5 };
    const full = mapCropToFull({ x: 0.5, y: 0.5, z: -0.3 }, box);
    expect(full.x).toBeCloseTo(0.625, 10);
    expect(full.y).toBeCloseTo(0.5, 10);
    expect(full.z).toBe(-0.3);
  });

  it('round-trips exactly for random boxes and points', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 100; i++) {
      const box: CropBox = {
        x: rand() * 0.6,
        y: rand() * 0.6,
        w: 0.1 + rand() * 0.4,
        h: 0.1 + rand() * 0.4,
      };
      const p: Vec3 = { x: rand(), y: rand(), z: rand() * 2 - 1 };
      const there = mapCropToFull(p, box);
      const back = mapFullToCrop(there, box);
      expect(back.x).toBeCloseTo(p.x, 12);
      expect(back.y).toBeCloseTo(p.y, 12);
      expect(back.z).toBe(p.z);
      // And the other direction.
      const there2 = mapFullToCrop(p, box);
      const back2 = mapCropToFull(there2, box);
      expect(back2.x).toBeCloseTo(p.x, 12);
      expect(back2.y).toBeCloseTo(p.y, 12);
    }
  });
});

describe('playerToRaw', () => {
  it('unmirrors x and keeps y and z', () => {
    expect(playerToRaw({ x: 0.3, y: 0.4, z: -0.1 })).toEqual({ x: 0.7, y: 0.4, z: -0.1 });
  });

  it('is its own inverse', () => {
    const p = { x: 0.12, y: 0.9, z: 0.05 };
    expect(playerToRaw(playerToRaw(p))).toEqual(p);
  });
});

// ---------------------------------------------------------------------------
// Handedness mapping
// ---------------------------------------------------------------------------

describe('handedness on the crop path', () => {
  it('maps pose sides to frame slots by the documented table', () => {
    // Pose sides are anatomical and so are frame slots; the mirroring is
    // applied to coordinates, not labels, so the mapping is the identity.
    // (Contrast with the full-frame path, where MediaPipe label Right ->
    // frame.left; see handSource.ts playerSlotForLabel.)
    expect(frameSlotForPoseSide('left')).toBe('left');
    expect(frameSlotForPoseSide('right')).toBe('right');
  });

  it('cropHandToPlayer maps crop landmarks through full frame into player space', () => {
    // A player-space LEFT wrist at x = 0.3 sits at raw x = 0.7 (image
    // right half). A crop around it, with the hand at the crop center,
    // must land back at player x = 0.3.
    const rawWrist = playerToRaw({ x: 0.3, y: 0.5, z: 0 });
    expect(rawWrist.x).toBeCloseTo(0.7, 10);
    const box: CropBox = { x: rawWrist.x - 0.1, y: 0.4, w: 0.2, h: 0.2 };
    const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: -0.2 }));
    const hand = cropHandToPlayer(landmarks, undefined, 0.9, box);
    expect(hand.landmarks).toHaveLength(21);
    expect(hand.landmarks[0]?.x).toBeCloseTo(0.3, 10);
    expect(hand.landmarks[0]?.y).toBeCloseTo(0.5, 10);
    expect(hand.landmarks[0]?.z).toBe(-0.2);
    expect(hand.confidence).toBe(0.9);
    expect(hand.world).toBeUndefined();
  });

  it('mirrors world landmarks without any crop mapping', () => {
    const box: CropBox = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
    const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    const world = Array.from({ length: 21 }, () => ({ x: 0.03, y: -0.01, z: 0.02 }));
    const hand = cropHandToPlayer(landmarks, world, 1, box);
    // World is metric and hand-centered: only the standard x negation,
    // completely independent of the crop box.
    expect(hand.world?.[0]).toEqual({ x: -0.03, y: -0.01, z: 0.02 });
  });
});

// ---------------------------------------------------------------------------
// Path selection
// ---------------------------------------------------------------------------

describe('selectHandPath', () => {
  it('follows the truth table: crop only when pose is fresh AND wrist visible', () => {
    expect(selectHandPath(true, true)).toBe('crop');
    expect(selectHandPath(true, false)).toBe('full');
    expect(selectHandPath(false, true)).toBe('full');
    expect(selectHandPath(false, false)).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// Pose wrist visibility feed (extractPoseFrame -> selectHandPath input)
// ---------------------------------------------------------------------------

describe('PoseFrame.wristVisibility', () => {
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

  it('carries per-wrist visibility from the pose model', () => {
    const lms = rawLandmarks({
      [POSE_LM.LEFT_WRIST]: { x: 0.6, y: 0.5, z: 0, visibility: 0.9 },
      [POSE_LM.RIGHT_WRIST]: { x: 0.4, y: 0.5, z: 0, visibility: 0.2 },
    });
    const frame = extractPoseFrame(lms, null, 0);
    expect(frame?.wristVisibility?.left).toBeCloseTo(0.9, 10);
    expect(frame?.wristVisibility?.right).toBeCloseTo(0.2, 10);
  });

  it('defaults missing visibility scores to 1 (fully visible)', () => {
    const frame = extractPoseFrame(rawLandmarks({}), null, 0);
    expect(frame?.wristVisibility).toEqual({ left: 1, right: 1 });
  });
});
