/**
 * Fixture specs for every move in Section 7 plus the negative suite from
 * Section 13. Each spec is a pair of keyframe tracks sampled at 30 fps by
 * fixtures/lib.ts. All timing notes below are milliseconds.
 *
 * Layout conventions (normalized player space, y grows downward):
 *   rest hands   y ~ 0.72      guard        y ~ 0.58
 *   chest        y ~ 0.56      hips         y ~ 0.84
 *   guard depth  z ~ -0.05     extended     z ~ -0.30 (toward camera)
 */

import type { FixtureSpec, HandKeyframe, HandSide } from './lib';
import { gaussian, generateRecording, hashLabel, kf, mulberry32 } from './lib';
import type { LandmarkRecording } from '../src/tracking/types';

const REST_X: Record<HandSide, number> = { left: 0.39, right: 0.61 };
const REST_Y = 0.72;
const REST_Z = -0.02;

/** Low-motion resting track for the hand not involved in a one-hand move. */
function idleTrack(side: HandSide, durationMs: number): HandKeyframe[] {
  const x = REST_X[side];
  const sway = side === 'right' ? 0.006 : -0.006;
  return [
    kf(0, 'rest', x, REST_Y, REST_Z),
    kf(durationMs / 2, 'rest', x + sway, REST_Y - 0.006, REST_Z - 0.002),
    kf(durationMs, 'rest', x, REST_Y, REST_Z),
  ];
}

/**
 * A single jab: fist raised to guard, fast thrust toward the camera
 * (z decreasing plus some x/y travel), brief extension, then retract.
 * Extension stays under the 350 ms fire-stream hold threshold.
 */
function jabTrack(side: HandSide, durationMs: number): HandKeyframe[] {
  const m = side === 'right' ? 1 : -1;
  const gx = 0.5 + 0.13 * m;
  const ex = 0.5 + 0.18 * m;
  return [
    kf(0, 'rest', REST_X[side], REST_Y, REST_Z),
    kf(300, 'fist', gx, 0.58, -0.05),
    kf(500, 'fist', gx, 0.58, -0.05),
    kf(640, 'fist', ex, 0.5, -0.3, { ease: 'easeOut' }),
    kf(720, 'fist', ex, 0.5, -0.3),
    kf(1050, 'fist', gx, 0.58, -0.05),
    kf(durationMs, 'rest', REST_X[side], REST_Y, REST_Z),
  ];
}

function jabSpec(side: HandSide): FixtureSpec {
  const durationMs = 1800;
  const other: HandSide = side === 'right' ? 'left' : 'right';
  const spec: FixtureSpec = {
    label: `jab-${side}`,
    durationMs,
    left: [],
    right: [],
  };
  spec[side] = jabTrack(side, durationMs);
  spec[other] = idleTrack(other, durationMs);
  return spec;
}

/** Jab, then fist held extended well past 350 ms with a slow steer, retract. */
function fireStreamSpec(): FixtureSpec {
  const durationMs = 2400;
  return {
    label: 'fire-stream',
    durationMs,
    right: [
      kf(0, 'rest', REST_X.right, REST_Y, REST_Z),
      kf(300, 'fist', 0.63, 0.58, -0.05),
      kf(500, 'fist', 0.63, 0.58, -0.05),
      kf(640, 'fist', 0.68, 0.5, -0.3, { ease: 'easeOut' }),
      kf(1500, 'fist', 0.72, 0.49, -0.29, { ease: 'linear' }), // held + steering
      kf(1850, 'fist', 0.63, 0.58, -0.05),
      kf(durationMs, 'rest', REST_X.right, REST_Y, REST_Z),
    ],
    left: idleTrack('left', durationMs),
  };
}

/** Three alternating jabs, punch peaks at 640 / 1090 / 1540 (900 ms window). */
function crossComboSpec(): FixtureSpec {
  const durationMs = 2200;
  return {
    label: 'cross-combo',
    durationMs,
    right: [
      kf(0, 'rest', REST_X.right, REST_Y, REST_Z),
      kf(300, 'fist', 0.63, 0.58, -0.05),
      kf(500, 'fist', 0.63, 0.58, -0.05),
      kf(640, 'fist', 0.68, 0.5, -0.3, { ease: 'easeOut' }),
      kf(700, 'fist', 0.68, 0.5, -0.3),
      kf(950, 'fist', 0.63, 0.58, -0.05),
      kf(1400, 'fist', 0.63, 0.58, -0.05),
      kf(1540, 'fist', 0.68, 0.5, -0.3, { ease: 'easeOut' }),
      kf(1600, 'fist', 0.68, 0.5, -0.3),
      kf(1850, 'fist', 0.63, 0.58, -0.05),
      kf(durationMs, 'rest', REST_X.right, REST_Y, REST_Z),
    ],
    left: [
      kf(0, 'rest', REST_X.left, REST_Y, REST_Z),
      kf(300, 'fist', 0.37, 0.58, -0.05),
      kf(950, 'fist', 0.37, 0.58, -0.05),
      kf(1090, 'fist', 0.32, 0.5, -0.3, { ease: 'easeOut' }),
      kf(1150, 'fist', 0.32, 0.5, -0.3),
      kf(1400, 'fist', 0.37, 0.58, -0.05),
      kf(durationMs, 'rest', REST_X.left, REST_Y, REST_Z),
    ],
  };
}

/** Open palm raised, fast thrust toward the camera, quick retract. */
function palmWaveSpec(): FixtureSpec {
  const durationMs = 1800;
  return {
    label: 'palm-wave',
    durationMs,
    right: [
      kf(0, 'rest', REST_X.right, REST_Y, REST_Z),
      kf(350, 'palm', 0.62, 0.54, -0.05),
      kf(550, 'palm', 0.62, 0.54, -0.05),
      kf(690, 'palm', 0.64, 0.48, -0.28, { ease: 'easeOut' }),
      kf(760, 'palm', 0.64, 0.48, -0.28),
      kf(1100, 'palm', 0.62, 0.54, -0.05),
      kf(durationMs, 'rest', REST_X.right, REST_Y, REST_Z),
    ],
    left: idleTrack('left', durationMs),
  };
}

/** Palm thrust, then held extended ~960 ms with a slow lateral sweep. */
function flameFanSpec(): FixtureSpec {
  const durationMs = 2600;
  return {
    label: 'flame-fan',
    durationMs,
    right: [
      kf(0, 'rest', REST_X.right, REST_Y, REST_Z),
      kf(350, 'palm', 0.62, 0.54, -0.05),
      kf(550, 'palm', 0.62, 0.54, -0.05),
      kf(690, 'palm', 0.64, 0.48, -0.28, { ease: 'easeOut' }),
      kf(1600, 'palm', 0.74, 0.5, -0.27, { ease: 'linear' }), // held + sweep
      kf(1950, 'palm', 0.62, 0.54, -0.05),
      kf(durationMs, 'rest', REST_X.right, REST_Y, REST_Z),
    ],
    left: idleTrack('left', durationMs),
  };
}

/** Both fists together at chest for 500 ms, then a joint thrust. */
function twinCannonSpec(): FixtureSpec {
  const durationMs = 2600;
  const side = (m: number): HandKeyframe[] => [
    kf(0, 'rest', 0.5 + 0.11 * m, REST_Y, REST_Z),
    kf(400, 'fist', 0.5 + 0.04 * m, 0.56, -0.07),
    kf(900, 'fist', 0.5 + 0.04 * m, 0.56, -0.07), // chest hold, wrists 0.08 apart
    kf(1040, 'fist', 0.5 + 0.06 * m, 0.5, -0.3, { ease: 'easeOut' }),
    kf(1150, 'fist', 0.5 + 0.06 * m, 0.5, -0.3),
    kf(1500, 'fist', 0.5 + 0.08 * m, 0.58, -0.07),
    kf(durationMs, 'rest', 0.5 + 0.11 * m, REST_Y, REST_Z),
  ];
  return {
    label: 'twin-cannon',
    durationMs,
    left: side(-1),
    right: side(1),
  };
}

/** Both palms held low, then a fast upward sweep (y drops sharply). */
function risingFlameSpec(): FixtureSpec {
  const durationMs = 2200;
  const side = (m: number): HandKeyframe[] => [
    kf(0, 'rest', 0.5 + 0.11 * m, REST_Y, REST_Z),
    kf(400, 'palm', 0.5 + 0.1 * m, 0.78, -0.05),
    kf(750, 'palm', 0.5 + 0.1 * m, 0.78, -0.05),
    kf(1010, 'palm', 0.5 + 0.14 * m, 0.34, -0.1, { ease: 'easeOut' }),
    kf(1250, 'palm', 0.5 + 0.14 * m, 0.34, -0.1),
    kf(1800, 'palm', 0.5 + 0.1 * m, 0.7, -0.04),
    kf(durationMs, 'rest', 0.5 + 0.11 * m, REST_Y, REST_Z),
  ];
  return {
    label: 'rising-flame',
    durationMs,
    left: side(-1),
    right: side(1),
  };
}

/** Grip held roughly static ~550 ms, then a fast lateral swing. */
function fireWhipSpec(): FixtureSpec {
  const durationMs = 2400;
  return {
    label: 'fire-whip',
    durationMs,
    right: [
      kf(0, 'rest', REST_X.right, REST_Y, REST_Z),
      kf(400, 'grip', 0.66, 0.46, -0.08),
      kf(950, 'grip', 0.665, 0.455, -0.08), // raised hold, near static
      kf(1130, 'grip', 0.92, 0.44, -0.12, { ease: 'easeOut' }), // the swing
      kf(1350, 'grip', 0.94, 0.46, -0.1), // follow-through
      kf(1900, 'grip', 0.7, 0.5, -0.06),
      kf(durationMs, 'rest', REST_X.right, REST_Y, REST_Z),
    ],
    left: idleTrack('left', durationMs),
  };
}

/** Both fists parked at hip height for 1.3 s, then released upward. */
function breathChargeSpec(): FixtureSpec {
  const durationMs = 2400;
  const side = (m: number): HandKeyframe[] => [
    kf(0, 'rest', 0.5 + 0.11 * m, REST_Y, REST_Z),
    kf(400, 'fist', 0.5 + 0.12 * m, 0.84, -0.02),
    kf(1700, 'fist', 0.5 + 0.122 * m, 0.842, -0.02), // long hip hold
    kf(2100, 'fist', 0.5 + 0.1 * m, 0.62, -0.04),
    kf(durationMs, 'fist', 0.5 + 0.1 * m, 0.62, -0.04),
  ];
  return {
    label: 'breath-charge',
    durationMs,
    left: side(-1),
    right: side(1),
  };
}

// ---------------------------------------------------------------------------
// Negative fixtures
// ---------------------------------------------------------------------------

/** Hands parked at rest, noise only. Nothing should ever trigger on this. */
function idleRestSpec(): FixtureSpec {
  const durationMs = 3000;
  const track = (side: HandSide): HandKeyframe[] => {
    const x = REST_X[side];
    return [
      kf(0, 'rest', x, REST_Y, REST_Z),
      kf(1500, 'rest', x + 0.008, REST_Y - 0.006, REST_Z),
      kf(durationMs, 'rest', x - 0.005, REST_Y + 0.004, REST_Z),
    ];
  };
  return { label: 'idle-rest', durationMs, left: track('left'), right: track('right') };
}

/** Moderate conversational gesticulation with relaxed open-ish hands. */
function talkingHandsSpec(): FixtureSpec {
  const durationMs = 4000;
  return {
    label: 'talking-hands',
    durationMs,
    right: [
      kf(0, 'rest', 0.6, 0.66, -0.03),
      kf(500, 'rest', 0.66, 0.58, -0.06),
      kf(900, 'palm', 0.7, 0.52, -0.09),
      kf(1400, 'rest', 0.63, 0.6, -0.04),
      kf(1900, 'rest', 0.58, 0.64, -0.02),
      kf(2400, 'palm', 0.65, 0.55, -0.08),
      kf(3000, 'rest', 0.61, 0.63, -0.03),
      kf(3500, 'rest', 0.64, 0.6, -0.05),
      kf(durationMs, 'rest', 0.6, 0.66, -0.03),
    ],
    left: [
      kf(0, 'rest', 0.4, 0.68, -0.03),
      kf(600, 'rest', 0.35, 0.6, -0.05),
      kf(1100, 'palm', 0.31, 0.55, -0.08),
      kf(1700, 'rest', 0.38, 0.62, -0.03),
      kf(2200, 'rest', 0.42, 0.66, -0.02),
      kf(2800, 'palm', 0.36, 0.56, -0.07),
      kf(3300, 'rest', 0.4, 0.64, -0.04),
      kf(durationMs, 'rest', 0.4, 0.68, -0.03),
    ],
  };
}

/** Slow forward reach: same travel as a jab but over 1.2 s, no speed spike. */
function slowReachSpec(): FixtureSpec {
  const durationMs = 3200;
  return {
    label: 'slow-reach',
    durationMs,
    right: [
      kf(0, 'rest', REST_X.right, REST_Y, REST_Z),
      kf(600, 'rest', 0.62, 0.62, -0.04),
      kf(1800, 'rest', 0.66, 0.52, -0.28, { ease: 'linear' }),
      kf(2200, 'rest', 0.66, 0.52, -0.28),
      kf(durationMs, 'rest', REST_X.right, REST_Y, REST_Z, { ease: 'linear' }),
    ],
    left: idleTrack('left', durationMs),
  };
}

/**
 * Right hand drifts off the right edge, confidence collapses, the hand is
 * gone for about a second, then it re-enters and recovers. Left stays put.
 */
function handEnterLeaveSpec(): FixtureSpec {
  const durationMs = 3600;
  return {
    label: 'hand-enter-leave',
    durationMs,
    right: [
      kf(0, 'rest', 0.62, 0.6, -0.03),
      kf(600, 'rest', 0.8, 0.62, -0.02, { conf: 0.9 }),
      kf(900, 'rest', 1.0, 0.66, -0.01, { conf: 0.35 }),
      kf(1050, null, 1.08, 0.68, 0),
      kf(2000, null, 1.08, 0.68, 0),
      kf(2150, 'rest', 1.0, 0.64, -0.01, { conf: 0.35 }),
      kf(2500, 'rest', 0.8, 0.6, -0.03, { conf: 0.9 }),
      kf(3000, 'rest', 0.62, 0.6, -0.03),
      kf(durationMs, 'rest', 0.62, 0.6, -0.03),
    ],
    left: idleTrack('left', durationMs),
  };
}

/** Many tiny random keyframes around rest: nervous fidgeting, no intent. */
function fidgetSpec(): FixtureSpec {
  const durationMs = 3500;
  const stepMs = 250;
  const rng = mulberry32(hashLabel('fidget:keyframes'));
  const track = (side: HandSide): HandKeyframe[] => {
    const x = REST_X[side];
    const frames: HandKeyframe[] = [];
    for (let t = 0; t <= durationMs; t += stepMs) {
      frames.push(
        kf(
          t,
          'rest',
          x + gaussian(rng) * 0.01,
          REST_Y + gaussian(rng) * 0.01,
          REST_Z + gaussian(rng) * 0.005,
        ),
      );
    }
    return frames;
  };
  return { label: 'fidget', durationMs, left: track('left'), right: track('right') };
}

// ---------------------------------------------------------------------------
// The full inventory
// ---------------------------------------------------------------------------

export const FIXTURE_SPECS: FixtureSpec[] = [
  // Positive: one per move in Section 7.
  jabSpec('left'),
  jabSpec('right'),
  fireStreamSpec(),
  crossComboSpec(),
  palmWaveSpec(),
  flameFanSpec(),
  twinCannonSpec(),
  risingFlameSpec(),
  fireWhipSpec(),
  breathChargeSpec(),
  // Negative: Section 13 false-positive suite.
  idleRestSpec(),
  talkingHandsSpec(),
  slowReachSpec(),
  handEnterLeaveSpec(),
  fidgetSpec(),
];

export function buildAllRecordings(): LandmarkRecording[] {
  return FIXTURE_SPECS.map(generateRecording);
}
