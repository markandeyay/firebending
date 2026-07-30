import { describe, expect, it } from 'vitest';
import {
  mirrorLandmarks,
  normalizeHands,
  playerSlotForLabel,
  type RawHand,
  type RawLandmark,
} from '../src/tracking/handSource';
import {
  faceCenter,
  matrixToCameraYawPitch,
  matrixToPlayerYawPitch,
} from '../src/tracking/faceSource';
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

/** Column-major 4x4 rotation about +y by angle a (radians). */
function rotY(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  // prettier-ignore
  return [
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1,
  ];
}

/** Column-major 4x4 rotation about +x by angle b (radians). */
function rotX(b: number): number[] {
  const c = Math.cos(b);
  const s = Math.sin(b);
  // prettier-ignore
  return [
    1, 0, 0, 0,
    0, c, s, 0,
    0, -s, c, 0,
    0, 0, 0, 1,
  ];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DEG15 = (15 * Math.PI) / 180;
const DEG10 = (10 * Math.PI) / 180;

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

describe('matrix to yaw/pitch extraction', () => {
  it('identity matrix yields zero yaw and pitch', () => {
    const cam = matrixToCameraYawPitch(IDENTITY);
    expect(cam.yaw).toBeCloseTo(0);
    expect(cam.pitch).toBeCloseTo(0);
    const player = matrixToPlayerYawPitch(IDENTITY);
    expect(player.yaw).toBeCloseTo(0);
    expect(player.pitch).toBeCloseTo(0);
  });

  it('recovers a known 15 degree camera-space yaw', () => {
    const cam = matrixToCameraYawPitch(rotY(DEG15));
    expect(cam.yaw).toBeCloseTo(DEG15, 5); // ~0.2618 rad
    expect(cam.pitch).toBeCloseTo(0, 5);
  });

  it('player turning 15 degrees to their own right gives positive player yaw', () => {
    // Player-right = nose toward image-left on the unmirrored frame,
    // i.e. a NEGATIVE camera-space rotation about +y.
    const player = matrixToPlayerYawPitch(rotY(-DEG15));
    expect(player.yaw).toBeCloseTo(DEG15, 5); // ~+0.26 rad
    expect(player.pitch).toBeCloseTo(0, 5);
  });

  it('camera +y yaw (nose toward image-right, player left) gives negative player yaw', () => {
    const player = matrixToPlayerYawPitch(rotY(DEG15));
    expect(player.yaw).toBeCloseTo(-DEG15, 5);
  });

  it('player looking up gives positive player pitch', () => {
    // Camera-space +x rotation pitches the nose down, so looking up is a
    // negative camera pitch.
    const cam = matrixToCameraYawPitch(rotX(DEG10));
    expect(cam.pitch).toBeCloseTo(DEG10, 5);
    const player = matrixToPlayerYawPitch(rotX(-DEG10));
    expect(player.pitch).toBeCloseTo(DEG10, 5);
    expect(player.yaw).toBeCloseTo(0, 5);
  });
});

describe('faceCenter', () => {
  it('mirrors the centroid into player space', () => {
    const landmarks: RawLandmark[] = [
      { x: 0.6, y: 0.4, z: -0.02 },
      { x: 0.8, y: 0.6, z: -0.04 },
    ];
    const c = faceCenter(landmarks);
    expect(c.x).toBeCloseTo(1 - 0.7);
    expect(c.y).toBeCloseTo(0.5);
    expect(c.z).toBeCloseTo(-0.03);
  });

  it('returns screen center for empty input', () => {
    expect(faceCenter([])).toEqual({ x: 0.5, y: 0.5, z: 0 });
  });
});
