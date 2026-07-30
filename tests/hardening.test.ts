/**
 * T070 hardening tests, all headless:
 *   - DegradeLadder: window medians, 2-slow/4-fast hysteresis, rung order,
 *     hooks called exactly once per step, no oscillation on alternating load
 *   - TrackingLoss: 1.5 s both-hands loss, 0.9 s ember countdown, cancel on
 *     mid-countdown dropout, single tracked hand never pauses
 *   - SingleHandHint: 2 s hold to show, 3 s visible, re-arm on both hands
 *   - One-handed fallback: jab and fire-stream fire with the other hand
 *     absent for the whole recording (fixtures built via fixtures/lib)
 *   - isMobileLike edge cases and the startup fault classifier
 *   - Help panel copy stays free of em dashes (Section 2 rule 6)
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEGRADE_FAST_WINDOWS,
  DEGRADE_MAX_RUNG,
  DEGRADE_SLOW_WINDOWS,
  DEGRADE_WINDOW_FRAMES,
  DegradeLadder,
  type DegradeHooks,
} from '../src/game/degrade';
import {
  HINT_VISIBLE_SEC,
  RESUME_COUNTDOWN_SEC,
  SINGLE_HAND_HOLD_SEC,
  SingleHandHint,
  TRACKING_LOSS_SEC,
  TrackingLoss,
  type SingleHandHintEvent,
  type TrackingLossEvent,
} from '../src/game/trackingLoss';
import { faultKindFor, isMobileLike } from '../src/boot/route';
import { HELP_TIPS, HELP_TITLE } from '../src/ui/helpPanel';
import { generateRecording, kf } from '../fixtures/lib';
import type { FixtureSpec, HandKeyframe, HandSide } from '../fixtures/lib';
import { ReplaySource } from '../src/tracking/replaySource';
import { MoveEngine } from '../src/gestures/moves';
import type { MoveEvent } from '../src/gestures/moves';

// ---------------------------------------------------------------------------
// DegradeLadder
// ---------------------------------------------------------------------------

interface HookLog {
  hooks: DegradeHooks;
  particle: number[];
  pose: number[];
  face: number[];
  shadow: boolean[];
}

function makeHooks(): HookLog {
  const log: HookLog = {
    particle: [],
    pose: [],
    face: [],
    shadow: [],
    hooks: {
      setParticleScale: (s) => log.particle.push(s),
      setPoseIntervalMultiplier: (m) => log.pose.push(m),
      setFaceIntervalMultiplier: (m) => log.face.push(m),
      setShadowHalved: (h) => log.shadow.push(h),
    },
  };
  return log;
}

/** Feed one full measurement window of constant frame times. */
function window_(ladder: DegradeLadder, frameMs: number): void {
  for (let i = 0; i < DEGRADE_WINDOW_FRAMES; i++) ladder.update(frameMs);
}

const SLOW_MS = 18; // median > 16.9
const FAST_MS = 12; // median < 14
const NEUTRAL_MS = 15.5; // between the thresholds

describe('DegradeLadder', () => {
  it('does nothing before a window completes', () => {
    const log = makeHooks();
    const ladder = new DegradeLadder(log.hooks);
    for (let i = 0; i < DEGRADE_WINDOW_FRAMES - 1; i++) ladder.update(SLOW_MS);
    expect(ladder.rung).toBe(0);
    expect(ladder.lastWindowMedianMs).toBeNull();
  });

  it('steps down one rung after two consecutive slow windows, hook once', () => {
    const log = makeHooks();
    const ladder = new DegradeLadder(log.hooks);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    window_(ladder, SLOW_MS);
    expect(ladder.rung).toBe(0);
    expect(log.particle).toEqual([]);

    window_(ladder, SLOW_MS);
    expect(ladder.rung).toBe(1);
    expect(log.particle).toEqual([0.5]);
    expect(log.pose).toEqual([]);
    expect(log.face).toEqual([]);
    expect(log.shadow).toEqual([]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/^DEGRADE:/);
    info.mockRestore();
  });

  it('walks the rungs in spec order (pose before face) and clamps at the bottom', () => {
    const log = makeHooks();
    const ladder = new DegradeLadder(log.hooks);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    // Enough slow windows to reach the bottom, plus slack to prove clamping.
    for (let i = 0; i < DEGRADE_SLOW_WINDOWS * DEGRADE_MAX_RUNG + 4; i++) {
      window_(ladder, SLOW_MS);
    }

    expect(ladder.rung).toBe(DEGRADE_MAX_RUNG);
    expect(log.particle).toEqual([0.5]); // exactly once
    expect(log.pose).toEqual([2]); // exactly once, BEFORE face
    expect(log.face).toEqual([2]); // exactly once
    expect(log.shadow).toEqual([true]); // exactly once, then clamped
    vi.restoreAllMocks();
  });

  it('degrades pose before face (rung 2 touches only the pose hook)', () => {
    const log = makeHooks();
    const ladder = new DegradeLadder(log.hooks);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    for (let i = 0; i < DEGRADE_SLOW_WINDOWS * 2; i++) window_(ladder, SLOW_MS);
    expect(ladder.rung).toBe(2);
    expect(log.pose).toEqual([2]);
    expect(log.face).toEqual([]);
    vi.restoreAllMocks();
  });

  it('steps back up after four consecutive fast windows and restores hooks', () => {
    const log = makeHooks();
    const ladder = new DegradeLadder(log.hooks);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    for (let i = 0; i < DEGRADE_SLOW_WINDOWS; i++) window_(ladder, SLOW_MS);
    expect(ladder.rung).toBe(1);

    for (let i = 0; i < DEGRADE_FAST_WINDOWS - 1; i++) window_(ladder, FAST_MS);
    expect(ladder.rung).toBe(1); // not yet

    window_(ladder, FAST_MS);
    expect(ladder.rung).toBe(0);
    expect(log.particle).toEqual([0.5, 1]);
    vi.restoreAllMocks();
  });

  it('never oscillates on alternating slow/fast windows (hysteresis)', () => {
    const log = makeHooks();
    const ladder = new DegradeLadder(log.hooks);
    for (let i = 0; i < 20; i++) {
      window_(ladder, i % 2 === 0 ? SLOW_MS : FAST_MS);
    }
    expect(ladder.rung).toBe(0);
    expect(log.particle).toEqual([]);
    expect(log.pose).toEqual([]);
    expect(log.face).toEqual([]);
    expect(log.shadow).toEqual([]);
  });

  it('neutral windows break both streaks', () => {
    const log = makeHooks();
    const ladder = new DegradeLadder(log.hooks);
    window_(ladder, SLOW_MS);
    window_(ladder, NEUTRAL_MS);
    window_(ladder, SLOW_MS);
    expect(ladder.rung).toBe(0); // never two consecutive slow windows
  });

  it('uses the window median, not the mean', () => {
    const log = makeHooks();
    const ladder = new DegradeLadder(log.hooks);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    // A few catastrophic spikes must not drag a fast window into slow:
    // 110 fast frames + 10 straggler frames, median stays fast.
    for (let w = 0; w < DEGRADE_SLOW_WINDOWS; w++) {
      for (let i = 0; i < DEGRADE_WINDOW_FRAMES; i++) {
        ladder.update(i < 110 ? FAST_MS : 100);
      }
    }
    expect(ladder.lastWindowMedianMs).toBe(FAST_MS);
    expect(ladder.rung).toBe(0);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// TrackingLoss
// ---------------------------------------------------------------------------

/** Step the FSM with a fixed dt, collecting events. */
function stepLoss(
  fsm: TrackingLoss,
  both: boolean,
  steps: number,
  dt: number,
  any: boolean = both,
): TrackingLossEvent[] {
  const events: TrackingLossEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(...fsm.update(both, dt, any));
  return events;
}

describe('TrackingLoss', () => {
  it('stays playing while both hands are tracked', () => {
    const fsm = new TrackingLoss();
    expect(stepLoss(fsm, true, 100, 1 / 30)).toEqual([]);
    expect(fsm.state).toBe('playing');
    expect(fsm.paused).toBe(false);
  });

  it('enters lost only after more than 1.5 s of both hands untracked', () => {
    const fsm = new TrackingLoss();
    // dt 0.125 is exact in binary: 12 x 0.125 = exactly 1.5 s, not yet
    // (> is strict).
    expect(stepLoss(fsm, false, 12, 0.125)).toEqual([]);
    expect(fsm.state).toBe('playing');
    const events = fsm.update(false, 0.125);
    expect(events).toEqual(['lost']);
    expect(fsm.state).toBe('lost');
    expect(fsm.paused).toBe(true);
  });

  it('a brief dropout under the threshold never pauses', () => {
    const fsm = new TrackingLoss();
    stepLoss(fsm, false, 11, 0.125); // 1.375 s lost...
    stepLoss(fsm, true, 1, 0.125); // ...hands back, timer resets
    expect(stepLoss(fsm, false, 12, 0.125)).toEqual([]); // 1.5 s again, still ok
    expect(fsm.state).toBe('playing');
  });

  it('a single tracked hand never pauses the game', () => {
    const fsm = new TrackingLoss();
    // both=false but any=true for a long stretch: single-hand play.
    expect(stepLoss(fsm, false, 300, 0.1, true)).toEqual([]);
    expect(fsm.state).toBe('playing');
  });

  it('runs the 3-2-1 countdown over 0.9 s and resumes', () => {
    const fsm = new TrackingLoss();
    stepLoss(fsm, false, 16, 0.1); // into lost
    expect(fsm.state).toBe('lost');

    const start = fsm.update(true, 0.05);
    expect(start).toEqual(['countdown-start']);
    expect(fsm.state).toBe('resuming');
    expect(fsm.paused).toBe(true);
    expect(fsm.countdownStep).toBe(3);

    const events: TrackingLossEvent[] = [];
    let elapsed = 0;
    const dt = 0.05;
    while (fsm.state === 'resuming') {
      events.push(...fsm.update(true, dt));
      elapsed += dt;
      expect(elapsed).toBeLessThanOrEqual(RESUME_COUNTDOWN_SEC + dt);
    }
    expect(fsm.state).toBe('playing');
    expect(events.filter((e) => e === 'countdown-tick')).toHaveLength(2); // 3->2, 2->1
    expect(events[events.length - 1]).toBe('resumed');
    expect(elapsed).toBeCloseTo(RESUME_COUNTDOWN_SEC, 5);
  });

  it('cancels the countdown back to lost when a hand drops', () => {
    const fsm = new TrackingLoss();
    stepLoss(fsm, false, 16, 0.1);
    fsm.update(true, 0.05);
    expect(fsm.state).toBe('resuming');
    fsm.update(true, 0.3);
    const events = fsm.update(false, 0.05);
    expect(events).toEqual(['lost']);
    expect(fsm.state).toBe('lost');
    // A fresh re-gate restarts the countdown at 3 from zero.
    fsm.update(true, 0.05);
    expect(fsm.countdownStep).toBe(3);
  });

  it('exports the spec timings', () => {
    expect(TRACKING_LOSS_SEC).toBe(1.5);
    expect(RESUME_COUNTDOWN_SEC).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// SingleHandHint
// ---------------------------------------------------------------------------

function stepHint(
  hint: SingleHandHint,
  left: boolean,
  right: boolean,
  steps: number,
  dt: number,
): SingleHandHintEvent[] {
  const events: SingleHandHintEvent[] = [];
  for (let i = 0; i < steps; i++) events.push(...hint.update(left, right, dt));
  return events;
}

describe('SingleHandHint', () => {
  it('shows once after one hand is tracked for more than 2 s', () => {
    const hint = new SingleHandHint();
    // dt 0.125 is exact in binary: 16 x 0.125 = exactly 2 s, not yet.
    expect(stepHint(hint, false, true, 16, 0.125)).toEqual([]);
    const events = stepHint(hint, false, true, 1, 0.125);
    expect(events).toEqual(['show']);
    expect(hint.visible).toBe(true);
  });

  it('hides after 3 s and does not re-show during the same episode', () => {
    const hint = new SingleHandHint();
    stepHint(hint, true, false, 21, 0.1);
    expect(hint.visible).toBe(true);
    const events = stepHint(hint, true, false, 31, 0.1);
    expect(events).toEqual(['hide']);
    expect(hint.visible).toBe(false);
    // Still one-handed for a long time: no second show.
    expect(stepHint(hint, true, false, 200, 0.1)).toEqual([]);
  });

  it('re-arms only after both hands are seen together again', () => {
    const hint = new SingleHandHint();
    stepHint(hint, true, false, 21, 0.1); // show
    stepHint(hint, true, false, 31, 0.1); // hide
    // Zero hands does not re-arm (the loss overlay owns that case).
    stepHint(hint, false, false, 10, 0.1);
    expect(stepHint(hint, true, false, 25, 0.1)).toEqual([]);
    // Both hands re-arm the hint.
    stepHint(hint, true, true, 5, 0.1);
    const events = stepHint(hint, false, true, 21, 0.1);
    expect(events).toEqual(['show']);
  });

  it('never shows with both or neither hand tracked', () => {
    const hint = new SingleHandHint();
    expect(stepHint(hint, true, true, 100, 0.1)).toEqual([]);
    expect(stepHint(hint, false, false, 100, 0.1)).toEqual([]);
    expect(SINGLE_HAND_HOLD_SEC).toBe(2);
    expect(HINT_VISIBLE_SEC).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// One-handed fallback: fist-family moves with the other hand absent
// ---------------------------------------------------------------------------

const REST_X: Record<HandSide, number> = { left: 0.39, right: 0.61 };
const REST_Y = 0.72;
const REST_Z = -0.02;

/** A hand that never appears: pose null keeps interpolated confidence at 0. */
function absentTrack(side: HandSide, durationMs: number): HandKeyframe[] {
  return [
    kf(0, null, REST_X[side], REST_Y, REST_Z),
    kf(durationMs, null, REST_X[side], REST_Y, REST_Z),
  ];
}

/** Same motion profile as the stock jab fixture (fixtures/specs.ts). */
function oneHandJabTrack(side: HandSide, durationMs: number): HandKeyframe[] {
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

function oneHandedSpec(label: string, side: HandSide, track: HandKeyframe[], durationMs: number): FixtureSpec {
  const other: HandSide = side === 'right' ? 'left' : 'right';
  const spec: FixtureSpec = { label, durationMs, left: [], right: [] };
  spec[side] = track;
  spec[other] = absentTrack(other, durationMs);
  return spec;
}

function runEngine(spec: FixtureSpec): MoveEvent[] {
  const engine = new MoveEngine();
  const events: MoveEvent[] = [];
  const src = new ReplaySource(generateRecording(spec));
  src.onFrame((f) => {
    // Guard the fixture itself: the other hand must truly be absent.
    events.push(...engine.update(f));
  });
  src.drain();
  return events;
}

describe('one-handed fallback (fist family)', () => {
  it('jab-blast fires with only the right hand in frame', () => {
    const spec = oneHandedSpec('one-hand-jab-right', 'right', oneHandJabTrack('right', 1800), 1800);
    const rec = generateRecording(spec);
    expect(rec.frames.every((f) => f.left === null)).toBe(true);

    const events = runEngine(spec);
    const trig = events.filter((e) => e.kind === 'trigger' || e.kind === 'sustain-start');
    expect(trig).toHaveLength(1);
    expect(trig[0]?.move).toBe('jab-blast');
    expect(trig[0]?.hand).toBe('right');
  });

  it('jab-blast fires with only the left hand in frame', () => {
    const spec = oneHandedSpec('one-hand-jab-left', 'left', oneHandJabTrack('left', 1800), 1800);
    const events = runEngine(spec);
    const trig = events.filter((e) => e.kind === 'trigger' || e.kind === 'sustain-start');
    expect(trig).toHaveLength(1);
    expect(trig[0]?.move).toBe('jab-blast');
    expect(trig[0]?.hand).toBe('left');
  });

  it('fire-stream sustains one-handed', () => {
    const durationMs = 2400;
    const track: HandKeyframe[] = [
      kf(0, 'rest', REST_X.right, REST_Y, REST_Z),
      kf(300, 'fist', 0.63, 0.58, -0.05),
      kf(500, 'fist', 0.63, 0.58, -0.05),
      kf(640, 'fist', 0.68, 0.5, -0.3, { ease: 'easeOut' }),
      kf(1500, 'fist', 0.72, 0.49, -0.29, { ease: 'linear' }),
      kf(1850, 'fist', 0.63, 0.58, -0.05),
      kf(durationMs, 'rest', REST_X.right, REST_Y, REST_Z),
    ];
    const spec = oneHandedSpec('one-hand-stream', 'right', track, durationMs);
    const events = runEngine(spec);
    expect(events[0]?.move).toBe('fire-stream');
    expect(events[0]?.kind).toBe('sustain-start');
    expect(events[events.length - 1]?.kind).toBe('sustain-end');
    expect(events.filter((e) => e.kind === 'sustain-tick').length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// Mobile gate edge cases and fault classification
// ---------------------------------------------------------------------------

describe('isMobileLike edge cases (T070)', () => {
  it('lets a landscape tablet at 1024w with touch through', () => {
    expect(isMobileLike({ hasTouch: true, innerWidth: 1024 })).toBe(false);
  });

  it('lets a narrow desktop window without touch through', () => {
    expect(isMobileLike({ hasTouch: false, innerWidth: 640 })).toBe(false);
  });

  it('rejects a touch device just under the cutoff, allows at the cutoff', () => {
    expect(isMobileLike({ hasTouch: true, innerWidth: 899 })).toBe(true);
    expect(isMobileLike({ hasTouch: true, innerWidth: 900 })).toBe(false);
  });
});

describe('faultKindFor', () => {
  it('classifies getUserMedia rejections as camera faults', () => {
    expect(faultKindFor({ name: 'NotAllowedError' })).toBe('camera');
    expect(faultKindFor({ name: 'NotFoundError' })).toBe('camera');
    expect(faultKindFor({ name: 'NotReadableError' })).toBe('camera');
    expect(faultKindFor({ name: 'OverconstrainedError' })).toBe('camera');
  });

  it('classifies model/network failures as network faults', () => {
    expect(faultKindFor(new TypeError('Failed to fetch'))).toBe('network');
    expect(faultKindFor(new Error('model download failed'))).toBe('network');
    expect(faultKindFor('boom')).toBe('network');
    expect(faultKindFor(null)).toBe('network');
    expect(faultKindFor(undefined)).toBe('network');
  });
});

// ---------------------------------------------------------------------------
// Copy rules (Section 2 rule 6: no em dashes user-facing)
// ---------------------------------------------------------------------------

describe('help panel copy', () => {
  it('has tips and a title free of em dashes', () => {
    expect(HELP_TIPS.length).toBeGreaterThanOrEqual(4);
    for (const text of [...HELP_TIPS, HELP_TITLE]) {
      expect(text).not.toMatch(/—/);
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
