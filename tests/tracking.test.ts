import { describe, expect, it } from 'vitest';
import {
  mirrorLandmarks,
  normalizeHands,
  playerSlotForLabel,
  type RawHand,
  type RawLandmark,
} from '../src/tracking/handSource';
import { HAND_LANDMARK_COUNT } from '../src/tracking/types';

function makeLandmarks(x: number, y = 0.5, z = -0.05): RawLandmark[] {
  const out: RawLandmark[] = [];
  for (let i = 0; i < HAND_LANDMARK_COUNT; i++) {
    out.push({ x: x + i * 0.001, y: y + i * 0.001, z });
  }
  return out;
}

function makeHand(label: 'Left' | 'Right', x: number, score = 0.95): RawHand {
  return { landmarks: makeLandmarks(x), label, score };
}

// NOTE (R3 Phase 2): the matrixToCameraYawPitch / matrixToPlayerYawPitch /
// faceCenter suites moved out with the deleted faceSource.ts; the head-pose
// sign contract is now tested against headPoseFromPose in poseSource.test.ts.

describe('mirrorLandmarks', () => {
  it('maps x to 1 - x and preserves y and z sign conventions', () => {
    const raw: RawLandmark[] = [{ x: 0.2, y: 0.7, z: -0.08 }];
    const mirrored = mirrorLandmarks(raw);
    expect(mirrored[0]?.x).toBeCloseTo(0.8);
    expect(mirrored[0]?.y).toBeCloseTo(0.7); // y stays downward-positive
    expect(mirrored[0]?.z).toBeCloseTo(-0.08); // z stays negative toward camera
  });

  it('is an involution on x (mirroring twice restores the input)', () => {
    const raw: RawLandmark[] = [{ x: 0.31, y: 0.5, z: 0.01 }];
    const twice = mirrorLandmarks(mirrorLandmarks(raw));
    expect(twice[0]?.x).toBeCloseTo(0.31);
  });

  it('does not mutate the input array', () => {
    const raw: RawLandmark[] = [{ x: 0.2, y: 0.5, z: 0 }];
    mirrorLandmarks(raw);
    expect(raw[0]?.x).toBe(0.2);
  });
});

describe('handedness normalization', () => {
  it("maps MediaPipe 'Right' (player's actual left hand) into the left slot", () => {
    expect(playerSlotForLabel('Right')).toBe('left');
    expect(playerSlotForLabel('Left')).toBe('right');
  });

  it("player raising the hand on their own left side populates frame 'left'", () => {
    // Player's actual left hand appears on the RIGHT of the unmirrored frame
    // (large image x) and MediaPipe labels it 'Right' because the model
    // assumes selfie-mirrored input.
    const playerLeftHand = makeHand('Right', 0.7);
    const { left, right } = normalizeHands([playerLeftHand]);
    expect(left).not.toBeNull();
    expect(right).toBeNull();
    // After mirroring, the player's left hand sits on the left of the
    // mirrored player view (small x), matching what they see in a mirror.
    expect(left?.landmarks[0]?.x).toBeCloseTo(1 - 0.7);
    expect(left?.confidence).toBeCloseTo(0.95);
  });

  it('normalizes both hands of a selfie-view feed to the correct slots', () => {
    const playerLeft = makeHand('Right', 0.7);
    const playerRight = makeHand('Left', 0.3);
    const { left, right } = normalizeHands([playerLeft, playerRight]);
    expect(left?.landmarks[0]?.x).toBeCloseTo(0.3);
    expect(right?.landmarks[0]?.x).toBeCloseTo(0.7);
  });

  it('resolves duplicate labels by score, spilling the loser to the free slot', () => {
    const strong = makeHand('Left', 0.3, 0.9);
    const weak = makeHand('Left', 0.7, 0.6);
    const { left, right } = normalizeHands([weak, strong]);
    // Both claim the right slot; the stronger keeps it.
    expect(right?.confidence).toBeCloseTo(0.9);
    expect(left?.confidence).toBeCloseTo(0.6);
  });

  it('drops hands with too few landmarks and handles empty input', () => {
    const partial: RawHand = {
      landmarks: [{ x: 0.5, y: 0.5, z: 0 }],
      label: 'Left',
      score: 0.99,
    };
    expect(normalizeHands([partial])).toEqual({ left: null, right: null });
    expect(normalizeHands([])).toEqual({ left: null, right: null });
  });
});

