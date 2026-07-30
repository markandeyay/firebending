import { describe, expect, it } from 'vitest';
import {
  cross,
  fistScore,
  gripScore,
  handScale,
  handSpeed,
  handsTogether,
  lm,
  normalize,
  palmScore,
  smoothstep,
  sub,
} from '../src/gestures/poses';
import type { Handedness } from '../src/gestures/poses';
import type { HandFrame, Vec3 } from '../src/tracking/types';
import { HAND_LANDMARK_COUNT, LM } from '../src/tracking/types';

/**
 * Inline hand-geometry builders (fixtures/ may be written concurrently by
 * another agent, so this file is self-contained).
 *
 * All builders lay out a RIGHT hand as offsets from the wrist at a nominal
 * hand scale of 0.1 (wrist to middle MCP distance), then optionally mirror
 * x for a left hand and multiply every offset by `k` for scale tests.
 * Player space: x right, y DOWN, z negative toward camera. Fingers point up
 * (negative y offsets). For a right hand facing the camera the thumb and
 * index sit on the -x side of the pinky (thumb toward the body midline).
 */

interface BuildOptions {
  handedness?: Handedness;
  /** Multiplies all offsets: 0.5 = hand twice as far from camera. */
  k?: number;
}

const FPS = 30;
const DT = 1 / FPS;

function buildHand(
  wrist: Vec3,
  offsets: Vec3[],
  { handedness = 'right', k = 1 }: BuildOptions = {}
): HandFrame {
  if (offsets.length !== HAND_LANDMARK_COUNT) {
    throw new Error(`expected 21 offsets, got ${offsets.length}`);
  }
  const mirror = handedness === 'left' ? -1 : 1;
  const landmarks = offsets.map((o) => ({
    x: wrist.x + o.x * mirror * k,
    y: wrist.y + o.y * k,
    z: wrist.z + o.z * k,
  }));
  return { landmarks, confidence: 0.95 };
}

/** MCP knuckle offsets shared by every pose (right hand). */
const MCP = {
  index: { x: -0.025, y: -0.095, z: 0 },
  middle: { x: 0, y: -0.1, z: 0 }, // exactly hand scale 0.1 from the wrist
  ring: { x: 0.02, y: -0.095, z: 0 },
  pinky: { x: 0.045, y: -0.085, z: 0 },
};

/** Straight finger: PIP/DIP/TIP march up from the MCP, tips lean together. */
function extendedFinger(mcp: Vec3, lean: number): [Vec3, Vec3, Vec3] {
  return [
    { x: mcp.x + lean * 0.33, y: mcp.y - 0.033, z: mcp.z },
    { x: mcp.x + lean * 0.66, y: mcp.y - 0.063, z: mcp.z },
    { x: mcp.x + lean, y: mcp.y - 0.09, z: mcp.z },
  ];
}

/** Curled finger: knuckle forward, tip folded back toward the palm heel. */
function curledFinger(mcp: Vec3): [Vec3, Vec3, Vec3] {
  return [
    { x: mcp.x, y: mcp.y - 0.015, z: mcp.z - 0.025 },
    { x: mcp.x * 0.85, y: mcp.y + 0.03, z: mcp.z - 0.035 },
    { x: mcp.x * 0.7, y: -0.05, z: -0.02 }, // tip near the palm, ratio ~0.6
  ];
}

/** Gently bent finger for the half-curl pose: tip ratio ~1.25. */
function halfCurledFinger(mcp: Vec3): [Vec3, Vec3, Vec3] {
  return [
    { x: mcp.x, y: mcp.y - 0.03, z: mcp.z - 0.01 },
    { x: mcp.x, y: mcp.y - 0.02, z: mcp.z - 0.035 },
    { x: mcp.x, y: mcp.y - 0.024, z: mcp.z - 0.045 },
  ];
}

function assembleOffsets(
  thumb: [Vec3, Vec3, Vec3, Vec3],
  fingers: Record<'index' | 'middle' | 'ring' | 'pinky', [Vec3, Vec3, Vec3]>
): Vec3[] {
  const wrist: Vec3 = { x: 0, y: 0, z: 0 };
  return [
    wrist,
    ...thumb,
    MCP.index,
    ...fingers.index,
    MCP.middle,
    ...fingers.middle,
    MCP.ring,
    ...fingers.ring,
    MCP.pinky,
    ...fingers.pinky,
  ];
}

/** Extended thumb off to the -x side (right hand). */
const THUMB_EXTENDED: [Vec3, Vec3, Vec3, Vec3] = [
  { x: -0.025, y: -0.03, z: 0 },
  { x: -0.05, y: -0.06, z: 0 },
  { x: -0.065, y: -0.085, z: 0 },
  { x: -0.08, y: -0.105, z: 0 },
];

/** Fist thumb: tucked sideways across the fingers, tip level with its MCP. */
const THUMB_FIST: [Vec3, Vec3, Vec3, Vec3] = [
  { x: -0.03, y: -0.03, z: 0 },
  { x: -0.045, y: -0.05, z: -0.01 },
  { x: -0.025, y: -0.052, z: -0.02 },
  { x: -0.005, y: -0.048, z: -0.025 },
];

/** Grip thumb: wrapped vertically, tip up beside the index PIP knuckle. */
const THUMB_GRIP: [Vec3, Vec3, Vec3, Vec3] = [
  { x: -0.03, y: -0.03, z: 0 },
  { x: -0.035, y: -0.06, z: -0.01 },
  { x: -0.03, y: -0.09, z: -0.02 },
  { x: -0.03, y: -0.115, z: -0.02 }, // near index PIP (-0.025, -0.11, -0.025)
];

/** Closed fist: all four fingertips folded to the palm, thumb tucked flat. */
function makeFist(wrist: Vec3, opts: BuildOptions = {}): HandFrame {
  return buildHand(
    wrist,
    assembleOffsets(THUMB_FIST, {
      index: curledFinger(MCP.index),
      middle: curledFinger(MCP.middle),
      ring: curledFinger(MCP.ring),
      pinky: curledFinger(MCP.pinky),
    }),
    opts
  );
}

/**
 * Open palm, fingers up and together. facingCamera=false rotates the hand
 * 180 degrees about the vertical axis (x offsets negate; z offsets are all
 * zero in this flat layout so they are unaffected), showing the back of
 * the hand.
 */
function makePalm(
  wrist: Vec3,
  facingCamera: boolean,
  opts: BuildOptions = {}
): HandFrame {
  const offsets = assembleOffsets(THUMB_EXTENDED, {
    index: extendedFinger(MCP.index, 0.005),
    middle: extendedFinger(MCP.middle, 0),
    ring: extendedFinger(MCP.ring, -0.002),
    pinky: extendedFinger(MCP.pinky, -0.01),
  });
  const flipped = facingCamera
    ? offsets
    : offsets.map((o) => ({ x: -o.x, y: o.y, z: o.z }));
  return buildHand(wrist, flipped, opts);
}

/** Whip grip: fist fingers, thumb wrapped vertically pointing up. */
function makeGrip(wrist: Vec3, opts: BuildOptions = {}): HandFrame {
  return buildHand(
    wrist,
    assembleOffsets(THUMB_GRIP, {
      index: curledFinger(MCP.index),
      middle: curledFinger(MCP.middle),
      ring: curledFinger(MCP.ring),
      pinky: curledFinger(MCP.pinky),
    }),
    opts
  );
}

/** Relaxed hand: fingers slightly bent (ratio ~1.35) and drifted apart. */
function makeRelaxed(wrist: Vec3, opts: BuildOptions = {}): HandFrame {
  const spread = (mcp: Vec3, sx: number): [Vec3, Vec3, Vec3] => [
    { x: mcp.x + sx * 0.3, y: mcp.y - 0.03, z: mcp.z - 0.005 },
    { x: mcp.x + sx * 0.6, y: mcp.y - 0.055, z: mcp.z - 0.015 },
    { x: mcp.x + sx, y: mcp.y - 0.04, z: mcp.z - 0.025 },
  ];
  return buildHand(
    wrist,
    assembleOffsets(THUMB_EXTENDED, {
      index: spread(MCP.index, -0.02),
      middle: spread(MCP.middle, -0.005),
      ring: spread(MCP.ring, 0.01),
      pinky: spread(MCP.pinky, 0.02),
    }),
    opts
  );
}

/** Half-curled hand: between fist and palm, tip ratio ~1.25. */
function makeHalfCurl(wrist: Vec3, opts: BuildOptions = {}): HandFrame {
  return buildHand(
    wrist,
    assembleOffsets(THUMB_EXTENDED, {
      index: halfCurledFinger(MCP.index),
      middle: halfCurledFinger(MCP.middle),
      ring: halfCurledFinger(MCP.ring),
      pinky: halfCurledFinger(MCP.pinky),
    }),
    opts
  );
}

/** Degenerate hand: every landmark at the origin. */
function makeZeroHand(): HandFrame {
  const landmarks = Array.from({ length: HAND_LANDMARK_COUNT }, () => ({
    x: 0,
    y: 0,
    z: 0,
  }));
  return { landmarks, confidence: 0 };
}

const WRIST_RAISED: Vec3 = { x: 0.5, y: 0.5, z: 0 };

// ---------------------------------------------------------------------------

describe('geometry builders', () => {
  it('produce 21 landmarks at the nominal hand scale', () => {
    const fist = makeFist(WRIST_RAISED);
    expect(fist.landmarks).toHaveLength(HAND_LANDMARK_COUNT);
    expect(handScale(fist)).toBeCloseTo(0.1, 5);
    expect(handScale(makePalm(WRIST_RAISED, true, { k: 2 }))).toBeCloseTo(0.2, 5);
  });
});

describe('fistScore', () => {
  it('scores a closed fist high', () => {
    expect(fistScore(makeFist(WRIST_RAISED))).toBeGreaterThan(0.8);
  });

  it('scores an open palm low', () => {
    expect(fistScore(makePalm(WRIST_RAISED, true))).toBeLessThan(0.3);
  });

  it('scores a relaxed hand below the enter threshold', () => {
    expect(fistScore(makeRelaxed(WRIST_RAISED))).toBeLessThan(0.6);
  });

  it('scores a half curl between palm and fist', () => {
    const half = fistScore(makeHalfCurl(WRIST_RAISED));
    expect(half).toBeGreaterThan(fistScore(makePalm(WRIST_RAISED, true)));
    expect(half).toBeLessThan(fistScore(makeFist(WRIST_RAISED)));
    expect(half).toBeGreaterThan(0.1);
    expect(half).toBeLessThan(0.9);
  });
});

describe('palmScore', () => {
  it('scores a right palm facing the camera high', () => {
    const hand = makePalm(WRIST_RAISED, true, { handedness: 'right' });
    expect(palmScore(hand, 'right')).toBeGreaterThan(0.8);
  });

  it('scores a left palm facing the camera high (mirrored winding)', () => {
    const hand = makePalm(WRIST_RAISED, true, { handedness: 'left' });
    expect(palmScore(hand, 'left')).toBeGreaterThan(0.8);
  });

  it('scores a fist low', () => {
    expect(palmScore(makeFist(WRIST_RAISED), 'right')).toBeLessThan(0.3);
  });

  it('scores the back of the hand low for both hands', () => {
    const right = makePalm(WRIST_RAISED, false, { handedness: 'right' });
    expect(palmScore(right, 'right')).toBeLessThan(0.5);
    const left = makePalm(WRIST_RAISED, false, { handedness: 'left' });
    expect(palmScore(left, 'left')).toBeLessThan(0.5);
  });

  it('flags a facing palm as back-of-hand if handedness is swapped', () => {
    // Guards the winding convention: the same geometry must flip its facing
    // factor when attributed to the other hand.
    const hand = makePalm(WRIST_RAISED, true, { handedness: 'right' });
    expect(palmScore(hand, 'left')).toBeLessThan(0.5);
  });
});

describe('gripScore', () => {
  it('scores a raised grip high', () => {
    expect(gripScore(makeGrip(WRIST_RAISED))).toBeGreaterThan(0.75);
  });

  it('scores a fist low (thumb not vertical)', () => {
    expect(gripScore(makeFist(WRIST_RAISED))).toBeLessThan(0.5);
  });

  it('scores a lowered grip low', () => {
    const lowered = makeGrip({ x: 0.5, y: 0.75, z: 0 });
    expect(gripScore(lowered)).toBeLessThan(0.5);
  });
});

describe('scale invariance', () => {
  it('keeps scores within 0.1 between half and double hand scale', () => {
    const cases: Array<[string, (k: number) => number]> = [
      ['fist', (k) => fistScore(makeFist(WRIST_RAISED, { k }))],
      ['palm', (k) => palmScore(makePalm(WRIST_RAISED, true, { k }), 'right')],
      ['grip', (k) => gripScore(makeGrip(WRIST_RAISED, { k }))],
      ['half', (k) => fistScore(makeHalfCurl(WRIST_RAISED, { k }))],
    ];
    for (const [label, score] of cases) {
      const near = score(2);
      const far = score(0.5);
      expect(Math.abs(near - far), label).toBeLessThan(0.1);
    }
  });
});

describe('handSpeed', () => {
  function fistAt(x: number, y: number, z: number): HandFrame {
    return makeFist({ x, y, z });
  }

  it('recovers speed and direction of lateral motion', () => {
    // 0.02 units per frame at 30 fps = 0.6 units/sec to the right.
    const frames = [0, 1, 2, 3, 4].map((i) => fistAt(0.4 + i * 0.02, 0.5, 0));
    const { speed, velocity, towardCamera } = handSpeed(frames, DT);
    expect(speed).toBeCloseTo(0.6, 5);
    expect(velocity.x).toBeCloseTo(0.6, 5);
    expect(velocity.y).toBeCloseTo(0, 5);
    expect(velocity.z).toBeCloseTo(0, 5);
    expect(towardCamera).toBe(0);
  });

  it('reports towardCamera when z decreases (punch at the camera)', () => {
    // z drops 0.03 per frame: velocity z = -0.9, toward camera 0.9.
    const frames = [0, 1, 2, 3].map((i) => fistAt(0.5, 0.5, -i * 0.03));
    const { velocity, towardCamera } = handSpeed(frames, DT);
    expect(velocity.z).toBeCloseTo(-0.9, 5);
    expect(towardCamera).toBeCloseTo(0.9, 5);
  });

  it('reports zero towardCamera when moving away', () => {
    const frames = [0, 1, 2, 3].map((i) => fistAt(0.5, 0.5, -0.09 + i * 0.03));
    const { towardCamera, velocity } = handSpeed(frames, DT);
    expect(velocity.z).toBeCloseTo(0.9, 5);
    expect(towardCamera).toBe(0);
  });

  it('returns zero motion for windows shorter than two frames', () => {
    expect(handSpeed([], DT).speed).toBe(0);
    expect(handSpeed([fistAt(0.5, 0.5, 0)], DT).speed).toBe(0);
  });

  it('returns finite zero motion for a non-positive dt', () => {
    const frames = [fistAt(0.4, 0.5, 0), fistAt(0.6, 0.5, 0)];
    expect(handSpeed(frames, 0).speed).toBe(0);
    expect(handSpeed(frames, -1).speed).toBe(0);
  });
});

describe('handsTogether', () => {
  it('is true just under the default threshold', () => {
    const l = makeFist({ x: 0.45, y: 0.5, z: 0 });
    const r = makeFist({ x: 0.55, y: 0.5, z: 0 });
    const { together, distance } = handsTogether(l, r);
    expect(together).toBe(true);
    expect(distance).toBeCloseTo(0.1, 5);
  });

  it('is false just over the default threshold', () => {
    const l = makeFist({ x: 0.43, y: 0.5, z: 0 });
    const r = makeFist({ x: 0.57, y: 0.5, z: 0 });
    const { together, distance } = handsTogether(l, r);
    expect(together).toBe(false);
    expect(distance).toBeCloseTo(0.14, 5);
  });

  it('honors a custom threshold', () => {
    const l = makeFist({ x: 0.43, y: 0.5, z: 0 });
    const r = makeFist({ x: 0.57, y: 0.5, z: 0 });
    expect(handsTogether(l, r, 0.2).together).toBe(true);
  });
});

describe('degenerate input robustness', () => {
  it('never returns NaN for an all-zero hand', () => {
    const zero = makeZeroHand();
    expect(Number.isFinite(fistScore(zero))).toBe(true);
    expect(Number.isFinite(palmScore(zero, 'right'))).toBe(true);
    expect(Number.isFinite(palmScore(zero, 'left'))).toBe(true);
    expect(Number.isFinite(gripScore(zero))).toBe(true);
    expect(fistScore(zero)).toBeGreaterThanOrEqual(0);
    expect(palmScore(zero, 'right')).toBe(0);
    expect(gripScore(zero)).toBe(0);
  });

  it('handles a motionless zero-hand window and coincident wrists', () => {
    const zero = makeZeroHand();
    const speed = handSpeed([zero, zero, zero], DT);
    expect(Number.isFinite(speed.speed)).toBe(true);
    expect(speed.speed).toBe(0);
    const { together, distance } = handsTogether(zero, zero);
    expect(together).toBe(true);
    expect(Number.isFinite(distance)).toBe(true);
  });

  it('lm throws on a missing landmark index', () => {
    const stub: HandFrame = { landmarks: [{ x: 0, y: 0, z: 0 }], confidence: 1 };
    expect(() => lm(stub, LM.MIDDLE_MCP)).toThrow(/missing hand landmark/);
  });
});

describe('vector helpers', () => {
  it('normalize guards the zero vector', () => {
    const n = normalize({ x: 0, y: 0, z: 0 });
    expect(n).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('cross follows the right-handed convention of player space', () => {
    // x-right cross y-down = +z (away from camera).
    const z = cross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(z).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('smoothstep clamps and interpolates', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 5);
  });

  it('sub is componentwise', () => {
    expect(sub({ x: 3, y: 2, z: 1 }, { x: 1, y: 1, z: 1 })).toEqual({
      x: 2,
      y: 1,
      z: 0,
    });
  });
});
