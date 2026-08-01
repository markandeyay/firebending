/**
 * PhaseMoveEngine end to end: synthetic pose trajectories through all 7
 * moves plus the negatives, and the headline claim of the rebuild:
 * FRAMERATE INDEPENDENCE. Every positive trajectory is sampled at 10 and
 * 30 fps and must produce the same event signature, because detection is
 * positions + sanity windows, never derivatives (the player's machine
 * captures at ~14 fps; velocity thresholds failed five rounds there).
 *
 * Hands are absent in most trajectories on purpose: the recorded drills
 * show the hand tracker losing the hand during fast motion, so the engine
 * must detect everything except the finger gates from body pose alone.
 */

import { describe, expect, it } from 'vitest';
import {
  GUARD_L,
  GUARD_R,
  HANG_L,
  HANG_R,
  HIPS_L,
  HIPS_R,
  OVERHEAD_L,
  OVERHEAD_R,
  PUNCH_R,
  TWIN_L,
  TWIN_PUNCH_L,
  TWIN_PUNCH_R,
  TWIN_R,
  WHIP_HOLD_R,
  WHIP_OUT_R,
  keyframeTraj,
  runPhaseEngine,
  sampleFrames,
  signature,
  type Trajectory,
} from './phaseHelpers';
import { PhaseMoveEngine } from '../src/gestures/phaseEngine';

// ---------------------------------------------------------------------------
// Trajectories
// ---------------------------------------------------------------------------

/** One right-hand jab: guard, fast thrust (200 ms), brief hold, retract. */
const jabTraj: Trajectory = keyframeTraj([
  { t: 0, left: GUARD_L, right: GUARD_R },
  { t: 500, left: GUARD_L, right: GUARD_R },
  { t: 700, left: GUARD_L, right: PUNCH_R },
  { t: 800, left: GUARD_L, right: PUNCH_R },
  { t: 1000, left: GUARD_L, right: GUARD_R },
  { t: 1600, left: GUARD_L, right: GUARD_R },
]);

/** Fast thrust then a long extended hold: jab upgrade into a stream. */
const streamTraj: Trajectory = keyframeTraj([
  { t: 0, left: GUARD_L, right: GUARD_R },
  { t: 500, left: GUARD_L, right: GUARD_R },
  { t: 700, left: GUARD_L, right: PUNCH_R },
  { t: 1500, left: GUARD_L, right: PUNCH_R },
  { t: 1700, left: GUARD_L, right: GUARD_R },
  { t: 2200, left: GUARD_L, right: GUARD_R },
]);

/** Three alternating jabs (R, L, R) inside the combo window. */
const comboTraj: Trajectory = keyframeTraj([
  { t: 0, left: GUARD_L, right: GUARD_R },
  { t: 500, left: GUARD_L, right: GUARD_R },
  { t: 700, left: GUARD_L, right: PUNCH_R },
  { t: 800, left: GUARD_L, right: PUNCH_R },
  { t: 1000, left: GUARD_L, right: GUARD_R },
  { t: 1200, left: { x: 0.4, y: 0.58 }, right: GUARD_R },
  { t: 1300, left: { x: 0.4, y: 0.58 }, right: GUARD_R },
  { t: 1500, left: GUARD_L, right: GUARD_R },
  { t: 1700, left: GUARD_L, right: PUNCH_R },
  { t: 1800, left: GUARD_L, right: PUNCH_R },
  { t: 2000, left: GUARD_L, right: GUARD_R },
  { t: 2600, left: GUARD_L, right: GUARD_R },
]);

/** Twin cannon: wrists together at the sternum, then a joint thrust. */
const twinTraj: Trajectory = keyframeTraj([
  { t: 0, left: TWIN_L, right: TWIN_R },
  { t: 400, left: TWIN_L, right: TWIN_R },
  { t: 500, left: TWIN_PUNCH_L, right: TWIN_PUNCH_R },
  { t: 800, left: TWIN_PUNCH_L, right: TWIN_PUNCH_R },
  { t: 1000, left: TWIN_L, right: TWIN_R },
  { t: 1500, left: TWIN_L, right: TWIN_R },
]);

/** Rising flame: both wrists sweep from the hips to above the shoulders. */
const risingTraj: Trajectory = keyframeTraj([
  { t: 0, left: HIPS_L, right: HIPS_R },
  { t: 300, left: HIPS_L, right: HIPS_R },
  { t: 700, left: OVERHEAD_L, right: OVERHEAD_R },
  { t: 1200, left: OVERHEAD_L, right: OVERHEAD_R },
]);

/** Breath charge: fists parked at the hips for well over a second. */
const chargeTraj: Trajectory = keyframeTraj([
  { t: 0, left: HIPS_L, right: HIPS_R, leftHand: 'fist', rightHand: 'fist' },
  { t: 2000, left: HIPS_L, right: HIPS_R, leftHand: 'fist', rightHand: 'fist' },
]);

/** Fire whip: raised grip held static in the inner band, then a lateral
 *  swing crossing into the outer band. */
const whipTraj: Trajectory = keyframeTraj([
  { t: 0, left: GUARD_L, right: WHIP_HOLD_R, rightHand: 'grip' },
  { t: 900, left: GUARD_L, right: WHIP_HOLD_R, rightHand: 'grip' },
  { t: 1100, left: GUARD_L, right: WHIP_OUT_R, rightHand: 'grip' },
  { t: 1400, left: GUARD_L, right: WHIP_OUT_R, rightHand: 'grip' },
]);

// ---------------------------------------------------------------------------
// Positives
// ---------------------------------------------------------------------------

describe('jab-blast', () => {
  it('fires exactly one right jab from a pose-only punch', () => {
    const { events, engine } = runPhaseEngine(sampleFrames(jabTraj, 1600, 10));
    expect(signature(events)).toEqual(['jab-blast:trigger:right']);
    const jab = events[0];
    if (!jab) throw new Error('no jab');
    expect(jab.hand).toBe('right');
    // Aim: normalized, positional, forward component toward the enemy.
    expect(Math.hypot(jab.aim.x, jab.aim.y, jab.aim.z)).toBeCloseTo(1, 5);
    expect(jab.aim.z).toBeLessThan(0);
    // Origin is the POSE wrist (screen space) at release.
    expect(jab.origin.x).toBeCloseTo(0.61, 5);
    expect(jab.origin.y).toBeCloseTo(0.5, 5);
    expect(engine.debugState.lastMove).toBe('jab-blast');
  });

  it('punching the same position twice produces the identical aim vector', () => {
    const twice: Trajectory = keyframeTraj([
      { t: 0, left: GUARD_L, right: GUARD_R },
      { t: 500, left: GUARD_L, right: GUARD_R },
      { t: 700, left: GUARD_L, right: PUNCH_R },
      { t: 800, left: GUARD_L, right: PUNCH_R },
      { t: 1000, left: GUARD_L, right: GUARD_R },
      { t: 1500, left: GUARD_L, right: GUARD_R },
      { t: 1700, left: GUARD_L, right: PUNCH_R },
      { t: 1800, left: GUARD_L, right: PUNCH_R },
      { t: 2000, left: GUARD_L, right: GUARD_R },
      { t: 2600, left: GUARD_L, right: GUARD_R },
    ]);
    const { events } = runPhaseEngine(sampleFrames(twice, 2600, 10));
    const jabs = events.filter((e) => e.move === 'jab-blast');
    expect(jabs).toHaveLength(2);
    const a = jabs[0];
    const b = jabs[1];
    if (!a || !b) throw new Error('missing jabs');
    expect(b.aim).toEqual(a.aim); // deterministic: position in, aim out
  });
});

describe('fire-stream', () => {
  it('a held fast thrust upgrades to a sustained stream and ends on retract', () => {
    const { events } = runPhaseEngine(sampleFrames(streamTraj, 2200, 10));
    expect(signature(events)).toEqual([
      'jab-blast:trigger:right',
      'fire-stream:sustain-start:right',
      'fire-stream:sustain-end:right',
    ]);
    const ticks = events.filter((e) => e.kind === 'sustain-tick');
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    // Ticks steer positionally: every tick aim is normalized.
    for (const e of ticks) {
      expect(Math.hypot(e.aim.x, e.aim.y, e.aim.z)).toBeCloseTo(1, 5);
    }
  });

  it('drains Breath while sustained', () => {
    const { events, engine } = runPhaseEngine(sampleFrames(streamTraj, 2200, 10));
    expect(events.some((e) => e.kind === 'sustain-start')).toBe(true);
    expect(engine.breath).toBeLessThan(100);
  });
});

describe('cross-combo', () => {
  it('the third alternating jab upgrades to cross-combo', () => {
    const { events } = runPhaseEngine(sampleFrames(comboTraj, 2600, 10));
    expect(signature(events)).toEqual([
      'jab-blast:trigger:right',
      'jab-blast:trigger:left',
      'cross-combo:trigger:right',
    ]);
  });
});

describe('twin-cannon', () => {
  it('fires on the paired joint thrust out of the together chamber', () => {
    const { events } = runPhaseEngine(sampleFrames(twinTraj, 1500, 10));
    expect(signature(events)).toEqual(['twin-cannon:trigger:both']);
    // The joint thrust must never fall through as jabs.
    expect(events.some((e) => e.move === 'jab-blast')).toBe(false);
  });
});

describe('rising-flame', () => {
  it('fires on the paired hip-to-overhead transit, with no jab leakage', () => {
    const { events } = runPhaseEngine(sampleFrames(risingTraj, 1200, 10));
    expect(signature(events)).toEqual(['rising-flame:trigger:both']);
  });
});

describe('breath-charge', () => {
  it('fires once for a chambered hip hold, then empowers the next move', () => {
    const chargeThenJab: Trajectory = keyframeTraj([
      { t: 0, left: HIPS_L, right: HIPS_R, leftHand: 'fist', rightHand: 'fist' },
      { t: 1600, left: HIPS_L, right: HIPS_R, leftHand: null, rightHand: null },
      { t: 1800, left: GUARD_L, right: GUARD_R },
      { t: 2100, left: GUARD_L, right: GUARD_R },
      { t: 2300, left: GUARD_L, right: PUNCH_R },
      { t: 2400, left: GUARD_L, right: PUNCH_R },
      { t: 2600, left: GUARD_L, right: GUARD_R },
      { t: 3200, left: GUARD_L, right: GUARD_R },
    ]);
    const { events } = runPhaseEngine(sampleFrames(chargeThenJab, 3200, 10));
    expect(signature(events)).toEqual([
      'breath-charge:trigger:both',
      'jab-blast:trigger:right',
    ]);
    const jab = events.find((e) => e.move === 'jab-blast');
    if (!jab) throw new Error('no jab');
    expect(jab.empowered).toBe(true);
  });

  it('freezes the dwell during a confidence outage and resumes (never resets)', () => {
    const base = chargeTraj;
    const dipped: Trajectory = (tMs) => {
      const s = base(tMs);
      if (tMs >= 600 && tMs < 900) return { ...s, confidence: 0.4 };
      return s;
    };
    const clean = runPhaseEngine(sampleFrames(base, 2000, 10));
    const dip = runPhaseEngine(sampleFrames(dipped, 2000, 10));
    const cleanCharge = clean.events.find((e) => e.move === 'breath-charge');
    const dipCharge = dip.events.find((e) => e.move === 'breath-charge');
    if (!cleanCharge || !dipCharge) throw new Error('charge missing');
    // Still exactly one charge, delayed by exactly the frozen span.
    expect(dip.events.filter((e) => e.move === 'breath-charge')).toHaveLength(1);
    expect(dipCharge.t).toBe(cleanCharge.t + 300);
  });
});

describe('fire-whip', () => {
  it('grip hold then inner-to-outer lateral crossing fires the whip', () => {
    const { events } = runPhaseEngine(sampleFrames(whipTraj, 1400, 10));
    expect(signature(events)).toEqual(['fire-whip:trigger:right']);
    // The swing must not leak into the thrust family.
    expect(events.some((e) => e.move === 'jab-blast')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Negatives
// ---------------------------------------------------------------------------

describe('negatives', () => {
  it('idle sway with relaxed hands at the hips stays silent', () => {
    const sway: Trajectory = (tMs) => ({
      left: { x: HIPS_L.x + 0.008 * Math.sin(tMs / 300), y: HIPS_L.y },
      right: { x: HIPS_R.x + 0.008 * Math.cos(tMs / 300), y: HIPS_R.y },
      leftHand: 'rest',
      rightHand: 'rest',
    });
    const { events } = runPhaseEngine(sampleFrames(sway, 3000, 10));
    expect(events).toEqual([]);
  });

  it('a slow reach transitions but never fires (and never streams)', () => {
    const slow: Trajectory = keyframeTraj([
      { t: 0, left: GUARD_L, right: GUARD_R },
      { t: 500, left: GUARD_L, right: GUARD_R },
      { t: 2000, left: GUARD_L, right: PUNCH_R },
      { t: 2600, left: GUARD_L, right: PUNCH_R },
      { t: 3200, left: GUARD_L, right: GUARD_R },
    ]);
    const { events } = runPhaseEngine(sampleFrames(slow, 3200, 10));
    expect(events).toEqual([]);
  });

  it('hands resting at guard stay silent', () => {
    const still: Trajectory = () => ({ left: GUARD_L, right: GUARD_R });
    const { events } = runPhaseEngine(sampleFrames(still, 2000, 10));
    expect(events).toEqual([]);
  });

  it('dropping the arms from guard to the sides never fires (settle gate)', () => {
    // The drill-measured hanging-arm false positive: the drop crosses the
    // extended threshold within the thrust window, but by release time the
    // wrist is deep in the HIP zone past the overdrive cap.
    const drop: Trajectory = keyframeTraj([
      { t: 0, left: GUARD_L, right: GUARD_R },
      { t: 400, left: GUARD_L, right: GUARD_R },
      { t: 700, left: HANG_L, right: HANG_R },
      { t: 2000, left: HANG_L, right: HANG_R },
    ]);
    for (const fps of [10, 30]) {
      const { events } = runPhaseEngine(sampleFrames(drop, 2000, fps));
      expect(events).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Framerate independence
// ---------------------------------------------------------------------------

describe('framerate independence', () => {
  const cases: Array<{ name: string; traj: Trajectory; durationMs: number }> = [
    { name: 'jab', traj: jabTraj, durationMs: 1600 },
    { name: 'stream', traj: streamTraj, durationMs: 2200 },
    { name: 'combo', traj: comboTraj, durationMs: 2600 },
    { name: 'twin', traj: twinTraj, durationMs: 1500 },
    { name: 'rising', traj: risingTraj, durationMs: 1200 },
    { name: 'charge', traj: chargeTraj, durationMs: 2000 },
    { name: 'whip', traj: whipTraj, durationMs: 1400 },
  ];

  for (const c of cases) {
    it(`${c.name}: same trajectory at 10 and 30 fps fires the same events`, () => {
      const at10 = runPhaseEngine(sampleFrames(c.traj, c.durationMs, 10));
      const at30 = runPhaseEngine(sampleFrames(c.traj, c.durationMs, 30));
      expect(signature(at30.events)).toEqual(signature(at10.events));
      expect(signature(at10.events).length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Debug surface and drop-in API
// ---------------------------------------------------------------------------

describe('drop-in surface', () => {
  it('exposes breath / spend / activeSustain / debugState like the legacy engine', () => {
    const { engine } = runPhaseEngine(sampleFrames(jabTraj, 1600, 10));
    expect(engine.breath).toBeGreaterThan(0);
    engine.spend(10);
    const before = engine.breath;
    engine.spend(-5); // junk ignored
    expect(engine.breath).toBe(before);
    expect(engine.activeSustain).toBeNull();

    const d = engine.debugState;
    expect(d.right.state).toBe('RETRACTED'); // back at guard
    expect(d.right.zone).toBe('CHEST');
    expect(d.right.paused).toBe(false);
    expect(typeof d.right.extension).toBe('number');
    expect(d.right.lastTransition).not.toBeNull();
    expect(d.lastMove).toBe('jab-blast');
    expect(d.lastAim).not.toBeNull();

    const reach = engine.learnedReach;
    expect(reach.left).toBeGreaterThan(0);
    expect(reach.right).toBeGreaterThan(0);
  });

  it('accepts the legacy constructor shape (velocityScale ignored, profile seeds reach)', () => {
    const { engine } = runPhaseEngine(sampleFrames(jabTraj, 1600, 10), {
      velocityScale: 1.7,
      profile: {
        version: 2,
        peakPunchSpeed: 2,
        peakPunchBboxGrowth: 3,
        peakPalmSpeed: 1.6,
        peakPalmBboxGrowth: 3,
        peakElbowVel: 8,
        neutralElbowVel: 0.3,
        neutralSpeed: 0.1,
        neutralBboxGrowth: 0.15,
        capturedAt: 'test',
        maxReachLeftSw: 0.9,
        maxReachRightSw: 1.0,
      },
    });
    expect(engine.learnedReach.left).toBeCloseTo(0.9, 10);
    expect(engine.learnedReach.right).toBeCloseTo(1.0, 10);
  });

  it('previewAim reproduces the emitted aim on the release frame (debug ray)', () => {
    // The arena's debug aim ray draws previewAim; it must equal the aim the
    // emit path produces from the same positions, or the ray would lie.
    const engine = new PhaseMoveEngine();
    const out = { x: 0, y: 0, z: 0 };
    for (const frame of sampleFrames(jabTraj, 1600, 10)) {
      const jab = engine.update(frame).find((e) => e.move === 'jab-blast');
      if (jab) {
        engine.previewAim('right', out);
        expect(out.x).toBeCloseTo(jab.aim.x, 10);
        expect(out.y).toBeCloseTo(jab.aim.y, 10);
        expect(out.z).toBeCloseTo(jab.aim.z, 10);
        return;
      }
    }
    throw new Error('no jab fired');
  });

  it('previewAim falls straight ahead before the body frame is ready', () => {
    const engine = new PhaseMoveEngine();
    const out = { x: 9, y: 9, z: 9 };
    engine.previewAim('left', out);
    expect(out).toEqual({ x: 0, y: 0, z: -1 });
  });
});
