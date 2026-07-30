/**
 * T021 + T022: the 9-move state machine against the synthetic fixture suite.
 *
 * True positives: every positive fixture produces exactly its move.
 * False positives: every negative fixture produces zero events.
 * Plus cross-move confusion, Breath economics, cooldowns, empowerment, and
 * trigger latency (< 120 ms of frame time from trigger-condition completion).
 *
 * Cross Combo modeling: the third alternating jab emits move 'cross-combo'
 * INSTEAD of a third 'jab-blast' (the upgrade replaces the hit), so the
 * cross-combo fixture yields [jab-blast R, jab-blast L, cross-combo R].
 *
 * Custom sequences are built with the fixtures/lib.ts generator (seeded,
 * fully deterministic). No camera anywhere near this file.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ReplaySource } from '../src/tracking/replaySource';
import type { LandmarkRecording } from '../src/tracking/types';
import { generateRecording, kf } from '../fixtures/lib';
import type { FixtureSpec, HandKeyframe } from '../fixtures/lib';
import { FIXTURE_SPECS } from '../fixtures/specs';
import { MoveEngine } from '../src/gestures/moves';
import type { MoveEngineConfig, MoveEvent } from '../src/gestures/moves';

const SYNTHETIC_DIR = new URL('../fixtures/synthetic/', import.meta.url);

const POSITIVE_LABELS = [
  'jab-left',
  'jab-right',
  'fire-stream',
  'cross-combo',
  'palm-wave',
  'flame-fan',
  'twin-cannon',
  'rising-flame',
  'fire-whip',
  'breath-charge',
] as const;

const NEGATIVE_LABELS = [
  'idle-rest',
  'talking-hands',
  'slow-reach',
  'hand-enter-leave',
  'fidget',
] as const;

const fixtures = new Map<string, LandmarkRecording>();

/** Load a stock fixture from disk, regenerating it if the JSON is missing. */
function loadFixture(label: string): LandmarkRecording {
  const url = new URL(`${label}.json`, SYNTHETIC_DIR);
  if (!existsSync(url)) {
    const spec = FIXTURE_SPECS.find((s) => s.label === label);
    if (!spec) throw new Error(`no spec for fixture ${label}`);
    mkdirSync(SYNTHETIC_DIR, { recursive: true });
    writeFileSync(url, JSON.stringify(generateRecording(spec)));
  }
  return JSON.parse(readFileSync(url, 'utf8')) as LandmarkRecording;
}

function fixture(label: string): LandmarkRecording {
  const rec = fixtures.get(label);
  if (!rec) throw new Error(`fixture ${label} not loaded`);
  return rec;
}

beforeAll(() => {
  for (const label of [...POSITIVE_LABELS, ...NEGATIVE_LABELS]) {
    fixtures.set(label, loadFixture(label));
  }
});

/** Drive a recording through a fresh engine via the replay harness. */
function runEngine(rec: LandmarkRecording, config?: MoveEngineConfig): MoveEvent[] {
  const engine = new MoveEngine(config);
  const events: MoveEvent[] = [];
  const src = new ReplaySource(rec);
  src.onFrame((f) => {
    events.push(...engine.update(f));
  });
  src.drain();
  return events;
}

/** Only the events that begin a move (discrete triggers and sustain starts). */
function triggers(events: MoveEvent[]): MoveEvent[] {
  return events.filter((e) => e.kind === 'trigger' || e.kind === 'sustain-start');
}

function only<T>(items: T[], what: string): T {
  const first = items[0];
  if (items.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one ${what}, got ${items.length}`);
  }
  return first;
}

/** Assert a clean sustained lifecycle: one start, ticks, one end, one move. */
function expectSustainShape(events: MoveEvent[], move: string, minTicks: number): void {
  expect(events.length).toBeGreaterThan(minTicks + 1);
  for (const e of events) expect(e.move).toBe(move);
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) throw new Error('no events');
  expect(first.kind).toBe('sustain-start');
  expect(last.kind).toBe('sustain-end');
  const ticks = events.filter((e) => e.kind === 'sustain-tick');
  expect(ticks.length).toBeGreaterThanOrEqual(minTicks);
  expect(events.filter((e) => e.kind === 'sustain-start')).toHaveLength(1);
  expect(events.filter((e) => e.kind === 'sustain-end')).toHaveLength(1);
}

// ---------------------------------------------------------------------------
// Custom fixture specs (seeded through fixtures/lib, deterministic)
// ---------------------------------------------------------------------------

const REST_X = { left: 0.39, right: 0.61 } as const;
const REST_Y = 0.72;
const REST_Z = -0.02;

function idleTrack(side: 'left' | 'right', durationMs: number): HandKeyframe[] {
  const x = REST_X[side];
  return [
    kf(0, 'rest', x, REST_Y, REST_Z),
    kf(durationMs / 2, 'rest', x + 0.005, REST_Y - 0.005, REST_Z),
    kf(durationMs, 'rest', x, REST_Y, REST_Z),
  ];
}

/** Fist thrust held extended long enough to drain all Breath at 18/sec. */
function longStreamSpec(): FixtureSpec {
  const durationMs = 8000;
  return {
    label: 'custom-long-stream',
    durationMs,
    right: [
      kf(0, 'rest', REST_X.right, REST_Y, REST_Z),
      kf(300, 'fist', 0.63, 0.58, -0.05),
      kf(500, 'fist', 0.63, 0.58, -0.05),
      kf(640, 'fist', 0.68, 0.5, -0.3, { ease: 'easeOut' }),
      kf(7000, 'fist', 0.74, 0.49, -0.29, { ease: 'linear' }),
      kf(7350, 'fist', 0.63, 0.58, -0.05),
      kf(durationMs, 'rest', REST_X.right, REST_Y, REST_Z),
    ],
    left: idleTrack('left', durationMs),
  };
}

/** Two right jabs so fast that the second lands inside the 0.25s cooldown. */
function doubleJabTightSpec(): FixtureSpec {
  const durationMs = 2000;
  return {
    label: 'custom-double-jab-tight',
    durationMs,
    right: [
      kf(0, 'rest', REST_X.right, REST_Y, REST_Z),
      kf(250, 'fist', 0.63, 0.58, -0.05),
      kf(500, 'fist', 0.63, 0.58, -0.05),
      kf(600, 'fist', 0.68, 0.5, -0.3, { ease: 'easeOut' }),
      kf(660, 'fist', 0.68, 0.5, -0.3),
      kf(780, 'fist', 0.63, 0.58, -0.05),
      kf(800, 'fist', 0.63, 0.58, -0.05),
      kf(880, 'fist', 0.68, 0.5, -0.3, { ease: 'easeOut' }),
      kf(900, 'fist', 0.68, 0.5, -0.3),
      kf(1020, 'fist', 0.63, 0.58, -0.05),
      kf(1500, 'fist', 0.63, 0.58, -0.05),
      kf(durationMs, 'rest', REST_X.right, REST_Y, REST_Z),
    ],
    left: idleTrack('left', durationMs),
  };
}

/** Same two jabs but spaced beyond the cooldown: both must fire. */
function doubleJabSpacedSpec(): FixtureSpec {
  const durationMs = 2200;
  return {
    label: 'custom-double-jab-spaced',
    durationMs,
    right: [
      kf(0, 'rest', REST_X.right, REST_Y, REST_Z),
      kf(250, 'fist', 0.63, 0.58, -0.05),
      kf(500, 'fist', 0.63, 0.58, -0.05),
      kf(600, 'fist', 0.68, 0.5, -0.3, { ease: 'easeOut' }),
      kf(660, 'fist', 0.68, 0.5, -0.3),
      kf(780, 'fist', 0.63, 0.58, -0.05),
      kf(1000, 'fist', 0.63, 0.58, -0.05),
      kf(1080, 'fist', 0.68, 0.5, -0.3, { ease: 'easeOut' }),
      kf(1100, 'fist', 0.68, 0.5, -0.3),
      kf(1220, 'fist', 0.63, 0.58, -0.05),
      kf(1700, 'fist', 0.63, 0.58, -0.05),
      kf(durationMs, 'rest', REST_X.right, REST_Y, REST_Z),
    ],
    left: idleTrack('left', durationMs),
  };
}

/** Two full twin-cannon motions 1.5s apart: the second hits the 5s cooldown. */
function doubleTwinSpec(): FixtureSpec {
  const durationMs = 3600;
  const side = (m: number): HandKeyframe[] => [
    kf(0, 'rest', 0.5 + 0.11 * m, REST_Y, REST_Z),
    kf(400, 'fist', 0.5 + 0.04 * m, 0.56, -0.07),
    kf(900, 'fist', 0.5 + 0.04 * m, 0.56, -0.07),
    kf(1040, 'fist', 0.5 + 0.06 * m, 0.5, -0.3, { ease: 'easeOut' }),
    kf(1150, 'fist', 0.5 + 0.06 * m, 0.5, -0.3),
    kf(1500, 'fist', 0.5 + 0.08 * m, 0.58, -0.07),
    kf(1800, 'fist', 0.5 + 0.04 * m, 0.56, -0.07),
    kf(2400, 'fist', 0.5 + 0.04 * m, 0.56, -0.07),
    kf(2540, 'fist', 0.5 + 0.06 * m, 0.5, -0.3, { ease: 'easeOut' }),
    kf(2650, 'fist', 0.5 + 0.06 * m, 0.5, -0.3),
    kf(3000, 'fist', 0.5 + 0.08 * m, 0.58, -0.07),
    kf(durationMs, 'rest', 0.5 + 0.11 * m, REST_Y, REST_Z),
  ];
  return { label: 'custom-double-twin', durationMs, left: side(-1), right: side(1) };
}

/** Breath charge at the hips, then a right jab delayMs after reaching guard. */
function chargeThenJabSpec(label: string, delayMs: number): FixtureSpec {
  const g = 2000 + delayMs; // guard wait ends, thrust begins
  const durationMs = g + 1100;
  return {
    label,
    durationMs,
    right: [
      kf(0, 'rest', REST_X.right, REST_Y, REST_Z),
      kf(400, 'fist', 0.62, 0.84, -0.02),
      kf(1700, 'fist', 0.622, 0.842, -0.02),
      kf(2000, 'fist', 0.63, 0.58, -0.05),
      kf(g, 'fist', 0.63, 0.58, -0.05),
      kf(g + 140, 'fist', 0.68, 0.5, -0.3, { ease: 'easeOut' }),
      kf(g + 220, 'fist', 0.68, 0.5, -0.3),
      kf(g + 550, 'fist', 0.63, 0.58, -0.05),
      kf(durationMs, 'rest', REST_X.right, REST_Y, REST_Z),
    ],
    left: [
      kf(0, 'rest', REST_X.left, REST_Y, REST_Z),
      kf(400, 'fist', 0.38, 0.84, -0.02),
      kf(1700, 'fist', 0.382, 0.842, -0.02),
      kf(2300, 'rest', REST_X.left, REST_Y, REST_Z),
      kf(durationMs, 'rest', REST_X.left, REST_Y, REST_Z),
    ],
  };
}

// ---------------------------------------------------------------------------
// True positives
// ---------------------------------------------------------------------------

describe('true positives: each fixture fires its move', () => {
  it('jab-left fires exactly one left jab-blast', () => {
    const events = runEngine(fixture('jab-left'));
    const e = only(events, 'event');
    expect(e.move).toBe('jab-blast');
    expect(e.hand).toBe('left');
    expect(e.kind).toBe('trigger');
  });

  it('jab-right fires exactly one right jab-blast with a forward aim', () => {
    const events = runEngine(fixture('jab-right'));
    const e = only(events, 'event');
    expect(e.move).toBe('jab-blast');
    expect(e.hand).toBe('right');
    // Aim is screen-space hand velocity: a punch at the camera is dominant -z.
    expect(e.aim.z).toBeLessThan(-0.7);
    expect(Math.hypot(e.aim.x, e.aim.y, e.aim.z)).toBeCloseTo(1, 5);
    // Origin is the punching wrist.
    expect(e.origin.x).toBeGreaterThan(0.5);
    expect(e.origin.x).toBeLessThan(0.85);
    expect(e.origin.y).toBeGreaterThan(0.35);
    expect(e.origin.y).toBeLessThan(0.7);
  });

  it('fire-stream runs a full sustain lifecycle with a steerable jet', () => {
    const events = runEngine(fixture('fire-stream'));
    expectSustainShape(events, 'fire-stream', 10);
    for (const e of events) {
      if (e.kind !== 'sustain-end') expect(e.aim.z).toBeLessThan(-0.5);
      expect(e.hand).toBe('right');
    }
  });

  it('cross-combo fires jab, jab, then the upgraded third hit', () => {
    const events = runEngine(fixture('cross-combo'));
    expect(events.map((e) => [e.move, e.hand])).toEqual([
      ['jab-blast', 'right'],
      ['jab-blast', 'left'],
      ['cross-combo', 'right'],
    ]);
    const combo = events[2];
    if (!combo) throw new Error('missing combo event');
    expect(combo.kind).toBe('trigger');
    expect(combo.aim.z).toBeLessThan(-0.7);
  });

  it('palm-wave fires exactly one right palm-wave', () => {
    const events = runEngine(fixture('palm-wave'));
    const e = only(events, 'event');
    expect(e.move).toBe('palm-wave');
    expect(e.hand).toBe('right');
    expect(e.aim.z).toBeLessThan(-0.7);
  });

  it('flame-fan runs a full sustain lifecycle', () => {
    const events = runEngine(fixture('flame-fan'));
    expectSustainShape(events, 'flame-fan', 8);
  });

  it('twin-cannon fires exactly one two-hand event', () => {
    const events = runEngine(fixture('twin-cannon'));
    const e = only(events, 'event');
    expect(e.move).toBe('twin-cannon');
    expect(e.hand).toBe('both');
    expect(e.aim.z).toBeLessThan(-0.7);
    expect(e.origin.x).toBeGreaterThan(0.4);
    expect(e.origin.x).toBeLessThan(0.6);
  });

  it('rising-flame fires exactly one two-hand event aimed upward', () => {
    const events = runEngine(fixture('rising-flame'));
    const e = only(events, 'event');
    expect(e.move).toBe('rising-flame');
    expect(e.hand).toBe('both');
    // Screen y grows down, so an upward sweep aims negative y.
    expect(e.aim.y).toBeLessThan(-0.8);
  });

  it('fire-whip fires exactly one whip along the swing direction', () => {
    const events = runEngine(fixture('fire-whip'));
    const e = only(events, 'event');
    expect(e.move).toBe('fire-whip');
    expect(e.hand).toBe('right');
    // The fixture swings to the player's right.
    expect(e.aim.x).toBeGreaterThan(0.7);
  });

  it('breath-charge fires exactly one charge and nothing else', () => {
    const events = runEngine(fixture('breath-charge'));
    const e = only(events, 'event');
    expect(e.move).toBe('breath-charge');
    expect(e.hand).toBe('both');
    expect(e.empowered).toBe(false);
  });

  it('moves are not empowered without a prior breath-charge', () => {
    const e = only(runEngine(fixture('jab-right')), 'event');
    expect(e.empowered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

describe('trigger latency (Section 13: under 120 ms of frame time)', () => {
  it('every positive trigger fires within 120 ms of condition completion', () => {
    for (const label of POSITIVE_LABELS) {
      const started = triggers(runEngine(fixture(label)));
      expect(started.length, label).toBeGreaterThan(0);
      for (const e of started) {
        expect(e.triggerLatencyMs, `${label}: ${e.move}`).toBeGreaterThanOrEqual(0);
        expect(e.triggerLatencyMs, `${label}: ${e.move}`).toBeLessThanOrEqual(120);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// False positives (as important as true positives)
// ---------------------------------------------------------------------------

describe('false-positive suite: negative fixtures emit ZERO events', () => {
  for (const label of NEGATIVE_LABELS) {
    it(`${label} produces no move events`, () => {
      const events = runEngine(fixture(label));
      expect(events).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-move confusion
// ---------------------------------------------------------------------------

describe('cross-move confusion', () => {
  it('fire-stream does not also emit palm moves or a jab', () => {
    const moves = new Set(runEngine(fixture('fire-stream')).map((e) => e.move));
    expect(moves).toEqual(new Set(['fire-stream']));
  });

  it('palm-wave does not emit jab-blast or flame-fan', () => {
    const moves = new Set(runEngine(fixture('palm-wave')).map((e) => e.move));
    expect(moves).toEqual(new Set(['palm-wave']));
  });

  it('flame-fan does not emit palm-wave', () => {
    const moves = new Set(runEngine(fixture('flame-fan')).map((e) => e.move));
    expect(moves).toEqual(new Set(['flame-fan']));
  });

  it('twin-cannon does not decay into two separate jab-blasts', () => {
    const events = runEngine(fixture('twin-cannon'));
    expect(events.filter((e) => e.move === 'jab-blast')).toHaveLength(0);
    expect(events.filter((e) => e.move === 'twin-cannon')).toHaveLength(1);
  });

  it('rising-flame does not emit palm-wave or flame-fan', () => {
    const moves = new Set(runEngine(fixture('rising-flame')).map((e) => e.move));
    expect(moves).toEqual(new Set(['rising-flame']));
  });

  it('fire-whip does not emit jab-blast despite the fist-like grip', () => {
    const moves = new Set(runEngine(fixture('fire-whip')).map((e) => e.move));
    expect(moves).toEqual(new Set(['fire-whip']));
  });

  it('breath-charge alone emits breath-charge and nothing else', () => {
    const moves = runEngine(fixture('breath-charge')).map((e) => e.move);
    expect(moves).toEqual(['breath-charge']);
  });
});

// ---------------------------------------------------------------------------
// Breath economics
// ---------------------------------------------------------------------------

describe('breath economics', () => {
  it('a sustained stream drains 18/sec, auto-ends at 0, then regens 12/sec', () => {
    const rec = generateRecording(longStreamSpec());
    const engine = new MoveEngine();
    const events: MoveEvent[] = [];
    let breathAt3s = -1;
    for (const frame of rec.frames) {
      events.push(...engine.update(frame));
      if (breathAt3s < 0 && frame.t >= 3000) breathAt3s = engine.breath;
    }

    // Stream starts ~930 ms in; by t=3000 roughly 2.07s of drain at 18/sec.
    expect(breathAt3s).toBeGreaterThan(55);
    expect(breathAt3s).toBeLessThan(72);

    // The stream must end on its own, from Breath exhaustion, while the fist
    // is still held extended (the fixture holds until t=7000).
    expectSustainShape(events, 'fire-stream', 100);
    const end = events[events.length - 1];
    if (!end) throw new Error('no end event');
    expect(end.kind).toBe('sustain-end');
    expect(end.t).toBeGreaterThan(6100);
    expect(end.t).toBeLessThan(6900);

    // Regen 12/sec after the stream died (~1.4s of regen by the last frame).
    expect(engine.breath).toBeGreaterThan(10);
    expect(engine.breath).toBeLessThan(27);
  });

  it('twin-cannon refuses to fire with insufficient Breath', () => {
    // Breath starts at 10 and regens 12/sec; at the thrust (~1.1s) it is
    // still far below the 40 cost. The blocked thrust must not leak jabs.
    const events = runEngine(fixture('twin-cannon'), { initialBreath: 10 });
    expect(events).toEqual([]);
  });

  it('twin-cannon spends its 40 Breath when it does fire', () => {
    const rec = fixture('twin-cannon');
    const engine = new MoveEngine();
    const events: MoveEvent[] = [];
    for (const frame of rec.frames) events.push(...engine.update(frame));
    expect(events.filter((e) => e.move === 'twin-cannon')).toHaveLength(1);
    // 100 - 40 plus some regen after the shot, never back to full by the end.
    expect(engine.breath).toBeGreaterThan(55);
    expect(engine.breath).toBeLessThan(95);
  });
});

// ---------------------------------------------------------------------------
// Cooldowns
// ---------------------------------------------------------------------------

describe('cooldowns', () => {
  it('suppresses a second jab inside the 0.25s per-hand cooldown', () => {
    const events = runEngine(generateRecording(doubleJabTightSpec()));
    expect(events.filter((e) => e.move === 'jab-blast')).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('fires both jabs when they are spaced past the cooldown', () => {
    const events = runEngine(generateRecording(doubleJabSpacedSpec()));
    const jabs = events.filter((e) => e.move === 'jab-blast');
    expect(jabs).toHaveLength(2);
    for (const e of jabs) expect(e.hand).toBe('right');
    // Same hand twice: never a cross-combo.
    expect(events.filter((e) => e.move === 'cross-combo')).toHaveLength(0);
  });

  it('suppresses a second twin-cannon inside the 5s cooldown, with no jab leak', () => {
    const events = runEngine(generateRecording(doubleTwinSpec()));
    expect(events.filter((e) => e.move === 'twin-cannon')).toHaveLength(1);
    expect(events.filter((e) => e.move === 'jab-blast')).toHaveLength(0);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Empowerment (Breath Charge)
// ---------------------------------------------------------------------------

describe('breath-charge empowerment', () => {
  it('empowers the next move within 3 seconds', () => {
    const events = runEngine(
      generateRecording(chargeThenJabSpec('custom-charge-jab-soon', 300))
    );
    expect(events.map((e) => e.move)).toEqual(['breath-charge', 'jab-blast']);
    const jab = events[1];
    if (!jab) throw new Error('missing jab');
    expect(jab.empowered).toBe(true);
  });

  it('does not empower a move after the 3 second window', () => {
    const events = runEngine(
      generateRecording(chargeThenJabSpec('custom-charge-jab-late', 2600))
    );
    expect(events.map((e) => e.move)).toEqual(['breath-charge', 'jab-blast']);
    const jab = events[1];
    if (!jab) throw new Error('missing jab');
    expect(jab.empowered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Debug surface
// ---------------------------------------------------------------------------

describe('debug getters', () => {
  it('exposes breath, pose scores, and the active sustain', () => {
    const rec = fixture('fire-stream');
    const engine = new MoveEngine();
    let sawSustain = false;
    for (const frame of rec.frames) {
      engine.update(frame);
      if (engine.activeSustain === 'fire-stream') sawSustain = true;
    }
    expect(sawSustain).toBe(true);
    expect(engine.activeSustain).toBeNull(); // ended by the fixture's retract
    expect(engine.breath).toBeGreaterThan(0);
    expect(engine.breath).toBeLessThanOrEqual(100);
    const scores = engine.currentPoseScores;
    expect(scores.right).not.toBeNull();
    if (scores.right) {
      expect(scores.right.fist).toBeGreaterThanOrEqual(0);
      expect(scores.right.fist).toBeLessThanOrEqual(1);
    }
  });
});
