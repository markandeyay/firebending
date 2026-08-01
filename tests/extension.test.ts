/**
 * Arm extension + phase machine (src/gestures/extension.ts). The core
 * claims under test:
 *   - the machine fires on a 3-sample punch and a densely-sampled punch
 *     IDENTICALLY (framerate independence: positions + time windows only);
 *   - a slow reach transitions but never fires;
 *   - the per-arm cooldown debounces; the full RETRACTED traversal is
 *     required (seeded-extended arms cannot fire);
 *   - the confidence pause FREEZES (never resets) and excludes paused time
 *     from every window;
 *   - the reach learner only learns inside the plausible forward band.
 */

import { describe, expect, it } from 'vitest';
import {
  ArmPhaseMachine,
  EXT_EXTENDED_MIN,
  EXT_REARM_MAX,
  EXT_RETRACTED_MAX,
  JAB_COOLDOWN_MS,
  MAX_REACH_LEARN_MAX_SW,
  MAX_REACH_LEARN_MIN_SW,
  MAX_REACH_PRIOR_SW,
  MAX_THRUST_MS,
  ReachLearner,
  armExtension,
} from '../src/gestures/extension';

interface Step {
  t: number;
  ext: number;
  conf?: boolean;
}

interface RunResult {
  fired: number[];
  slow: number[];
  promoted: number[];
  promotedCompletedAt: number[];
  machine: ArmPhaseMachine;
}

/** Drive a step list through a fresh machine, collecting event times. */
function run(steps: Step[]): RunResult {
  const machine = new ArmPhaseMachine();
  const res: RunResult = { fired: [], slow: [], promoted: [], promotedCompletedAt: [], machine };
  for (const s of steps) {
    const u = machine.update(s.ext, s.t, s.conf ?? true);
    if (u.fired) res.fired.push(s.t);
    if (u.slow) res.slow.push(s.t);
    if (u.holdPromoted) {
      res.promoted.push(s.t);
      res.promotedCompletedAt.push(u.completedAt);
    }
  }
  return res;
}

/** Punch profile: guard until 500 ms, linear thrust 500..700, hold after. */
function punchExt(tMs: number): number {
  if (tMs < 500) return 0.2;
  if (tMs < 700) return 0.2 + ((tMs - 500) / 200) * 0.75;
  return 0.95;
}

function sampled(profile: (t: number) => number, durationMs: number, dtMs: number): Step[] {
  const steps: Step[] = [];
  for (let t = 0; t <= durationMs; t += dtMs) steps.push({ t, ext: profile(t) });
  return steps;
}

describe('armExtension', () => {
  it('normalizes reach by shoulder width and maxReach', () => {
    // 0.272 screen units of reach over a 0.32-wide body at the 0.85 prior
    // is exactly a full punch.
    const ext = armExtension({ x: 0.34, y: 0.35 }, { x: 0.34, y: 0.622 }, 0.32, 0.85);
    expect(ext).toBeCloseTo(1, 3);
  });

  it('guards degenerate input', () => {
    expect(armExtension({ x: 0, y: 0 }, { x: 1, y: 1 }, 0, 0.85)).toBe(0);
    expect(armExtension({ x: 0, y: 0 }, { x: 1, y: 1 }, 0.3, 0)).toBe(0);
  });
});

describe('phase machine: framerate independence', () => {
  it('fires on a 3-sample punch', () => {
    const res = run([
      { t: 0, ext: 0.2 },
      { t: 100, ext: 0.55 },
      { t: 200, ext: 0.9 },
    ]);
    expect(res.fired).toEqual([200]);
  });

  it('fires exactly once on the same punch at 10 fps and at 30 fps', () => {
    const coarse = run(sampled(punchExt, 1000, 100));
    const dense = run(sampled(punchExt, 1000, 1000 / 30));
    expect(coarse.fired).toHaveLength(1);
    expect(dense.fired).toHaveLength(1);
    // Both fire within one frame interval of the physical completion.
    const coarseT = coarse.fired[0];
    const denseT = dense.fired[0];
    if (coarseT === undefined || denseT === undefined) throw new Error('no fire');
    expect(Math.abs(coarseT - denseT)).toBeLessThanOrEqual(100);
  });
});

describe('phase machine: transitions and gating', () => {
  it('a slow reach reaches EXTENDED but never fires or promotes', () => {
    // 2 s creep from guard to full extension, then a long dwell: the slow
    // entry must not fire and must not arm the stream promotion either.
    const creep = (t: number): number => (t < 2000 ? 0.2 + (t / 2000) * 0.75 : 0.95);
    const res = run(sampled(creep, 3000, 100));
    expect(res.fired).toEqual([]);
    expect(res.slow).toHaveLength(1);
    expect(res.promoted).toEqual([]);
    expect(res.machine.phase).toBe('EXTENDED');
  });

  it('sanity: the slow/fast boundary is the exported window', () => {
    // Values retuned by the 2026-07-31 phase-eval pass (tools/phaseEval.ts)
    // against the real drill recording; see the constants' doc comments.
    expect(MAX_THRUST_MS).toBe(650);
    expect(EXT_RETRACTED_MAX).toBeCloseTo(0.4, 10);
    expect(EXT_EXTENDED_MIN).toBeCloseTo(0.65, 10);
    expect(EXT_REARM_MAX).toBeCloseTo(0.5, 10);
  });

  it('debounces: a second fast traversal inside the cooldown does not fire', () => {
    const res = run([
      { t: 0, ext: 0.2 },
      { t: 100, ext: 0.5 },
      { t: 200, ext: 0.9 }, // fires; cooldown until 450
      { t: 250, ext: 0.3 }, // re-arm
      { t: 300, ext: 0.6 },
      { t: 350, ext: 0.9 }, // fast again, but inside the cooldown
      { t: 400, ext: 0.3 },
      { t: 500, ext: 0.6 },
      { t: 600, ext: 0.9 }, // past the cooldown: fires
    ]);
    expect(res.fired).toEqual([200, 600]);
    expect(JAB_COOLDOWN_MS).toBe(250);
  });

  it('an aborted half punch re-arms instead of stalling (the one backward transition)', () => {
    const res = run([
      { t: 0, ext: 0.2 },
      { t: 100, ext: 0.55 }, // EXTENDING
      { t: 200, ext: 0.3 }, // abort back to RETRACTED
      { t: 300, ext: 0.55 },
      { t: 400, ext: 0.9 }, // fast from the SECOND departure (100 ms)
    ]);
    expect(res.fired).toEqual([400]);
    const last = res.machine.lastTransition;
    if (!last) throw new Error('no transition');
    expect(last.tookMs).toBe(100);
  });

  it('an arm first seen EXTENDED must visit RETRACTED before it can fire', () => {
    // Hanging idle arms sit far above the extended threshold permanently;
    // seeding must not count as a completed traversal, and the seeded dwell
    // must not promote a stream either.
    const res = run([
      { t: 0, ext: 1.5 }, // seeded EXTENDED, no transition
      { t: 200, ext: 1.5 },
      { t: 600, ext: 1.5 }, // long dwell: no promotion
      { t: 700, ext: 0.3 }, // first RETRACTED visit
      { t: 800, ext: 0.6 },
      { t: 900, ext: 0.9 }, // now a real traversal
    ]);
    expect(res.promoted).toEqual([]);
    expect(res.fired).toEqual([900]);
  });

  it('promotes a fast entry to the stream-hold signal after the dwell', () => {
    const res = run(sampled(punchExt, 1200, 100));
    expect(res.fired).toHaveLength(1);
    expect(res.promoted).toHaveLength(1);
    // Entered EXTENDED at 700; the hold crossed at exactly 700 + 350.
    expect(res.promotedCompletedAt[0]).toBe(1050);
  });
});

describe('phase machine: confidence pause', () => {
  it('freezes mid-thrust and resumes with paused time excluded', () => {
    const machine = new ArmPhaseMachine();
    machine.update(0.2, 0, true);
    machine.update(0.5, 100, true); // EXTENDING, departed at 100
    // Tracking drops for 2 s. Values are garbage on purpose: they must be
    // ignored entirely, state held.
    for (let t = 200; t <= 2200; t += 100) {
      const u = machine.update(5.0, t, false);
      expect(u.fired).toBe(false);
      expect(u.enteredExtended).toBe(false);
    }
    expect(machine.phase).toBe('EXTENDING'); // FROZEN, not reset
    expect(machine.paused).toBe(true);
    // Recovery: the thrust completes 100 ms of REAL time after departure,
    // so it is still fast even though 2 s of wall time passed.
    const u = machine.update(0.9, 2300, true);
    expect(machine.paused).toBe(false);
    expect(u.fired).toBe(true);
  });

  it('holds state through an indefinite outage (freeze, never reset)', () => {
    const machine = new ArmPhaseMachine();
    machine.update(0.9, 0, true); // seeded EXTENDED
    machine.update(0.3, 100, true); // RETRACTED
    for (let t = 200; t <= 10200; t += 500) machine.update(0.9, t, false);
    expect(machine.phase).toBe('RETRACTED');
    // Resumes exactly where the player left off.
    machine.update(0.6, 10300, true);
    const u = machine.update(0.9, 10400, true);
    expect(u.fired).toBe(true);
  });
});

describe('reach learner', () => {
  it('learns a running max only inside the plausible forward band', () => {
    const l = new ReachLearner();
    expect(l.maxReach).toBeCloseTo(MAX_REACH_PRIOR_SW, 10);
    l.learn(0.95);
    expect(l.maxReach).toBeCloseTo(0.95, 10);
    l.learn(MAX_REACH_LEARN_MAX_SW + 0.5); // hanging-arm territory: ignored
    expect(l.maxReach).toBeCloseTo(0.95, 10);
    l.learn(MAX_REACH_LEARN_MIN_SW - 0.2); // collapsed junk: ignored
    expect(l.maxReach).toBeCloseTo(0.95, 10);
  });

  it('decays slowly toward the seed and never below it', () => {
    const l = new ReachLearner();
    l.learn(1.1);
    l.decay(120); // two minutes
    expect(l.maxReach).toBeLessThan(1.1);
    expect(l.maxReach).toBeGreaterThan(MAX_REACH_PRIOR_SW);
    l.decay(1e6); // effectively forever
    expect(l.maxReach).toBeCloseTo(MAX_REACH_PRIOR_SW, 3);
  });

  it('falls back to the prior when the stored seed is implausible', () => {
    expect(new ReachLearner(2.4).maxReach).toBeCloseTo(MAX_REACH_PRIOR_SW, 10);
    expect(new ReachLearner(Number.NaN).maxReach).toBeCloseTo(MAX_REACH_PRIOR_SW, 10);
    expect(new ReachLearner(0.9).maxReach).toBeCloseTo(0.9, 10);
  });
});
