/**
 * Three-signal punch fusion (src/gestures/moves.ts): elbow-extension
 * angular velocity (PRIMARY, from body pose) fused with the wrist-speed and
 * bbox-growth secondaries.
 *
 * FIRE RULE under test:
 *   pose FRESH  -> primary AND at least one secondary
 *   pose absent -> BOTH secondaries (the documented fallback that keeps the
 *                  synthetic fixture suite meaningful)
 *
 * Frames are hand-built (fixtures/lib placePose for hands, parametric arms
 * for pose) and fully deterministic. No camera, no MediaPipe.
 */

import { describe, expect, it } from 'vitest';
import {
  ELBOW_VANISH_VEL,
  HAND_VANISH_WINDOW_MS,
  MoveEngine,
  POSE_FRESH_MS,
} from '../src/gestures/moves';
import type { MoveEvent } from '../src/gestures/moves';
import { placePose } from '../fixtures/lib';
import type {
  HandFrame,
  LandmarkFrame,
  PoseArm,
  PoseFrame,
} from '../src/tracking/types';

const DT_MS = 33; // ~30 fps
const GUARD_ANGLE = Math.PI / 2;

function fistAt(x: number, y: number, scale: number): HandFrame {
  return {
    landmarks: placePose('fist', { x, y, z: -0.05 }, 'right', scale),
    confidence: 0.95,
  };
}

/** World-space arm with a given elbow angle (radians) in the y-z plane. */
function worldArm(angle: number): PoseArm {
  return {
    shoulder: { x: 0, y: -0.3, z: 0 },
    elbow: { x: 0, y: 0, z: 0 },
    wrist: { x: 0, y: 0.25 * -Math.cos(angle), z: -0.25 * Math.sin(angle) },
    hip: { x: 0, y: 0.5, z: 0 },
  };
}

/** Screen-space arm (only used for aim; static is fine for these tests). */
function screenArm(side: 'left' | 'right'): PoseArm {
  const m = side === 'left' ? -1 : 1;
  return {
    shoulder: { x: 0.5 + 0.12 * m, y: 0.35, z: 0 },
    elbow: { x: 0.5 + 0.16 * m, y: 0.5, z: 0 },
    wrist: { x: 0.5 + 0.2 * m, y: 0.55, z: 0 },
    hip: { x: 0.5 + 0.08 * m, y: 0.72, z: 0 },
  };
}

/** A pose SAMPLE at time t with both elbows at the given angle. */
function poseSample(t: number, angle: number): PoseFrame {
  const arm = worldArm(angle);
  return {
    t,
    left: screenArm('left'),
    right: screenArm('right'),
    world: { left: arm, right: arm },
    confidence: 1,
  };
}

interface TimelineOpts {
  /** Elbow angle per POSE SAMPLE index, or null for a poseless run. */
  elbowAngleAt: ((sampleIndex: number, tMs: number) => number) | null;
  /** Wrist x offset per frame index (screen units). */
  wristXAt: (frame: number) => number;
  /** Hand scale per frame index (drives bbox growth). */
  scaleAt: (frame: number) => number;
  frames: number;
  /** Attach this fixed stale pose to every frame instead of live samples. */
  stalePose?: PoseFrame;
}

/**
 * Run a timeline through a fresh engine: hand present every frame, pose
 * sampled every 2nd frame (sample-and-held on the odd frames), 33 ms steps.
 */
function run(opts: TimelineOpts): { events: MoveEvent[]; engine: MoveEngine } {
  const engine = new MoveEngine();
  const events: MoveEvent[] = [];
  let heldPose: PoseFrame | null = opts.stalePose ?? null;
  for (let i = 0; i < opts.frames; i++) {
    const t = i * DT_MS;
    if (opts.elbowAngleAt && i % 2 === 0) {
      heldPose = poseSample(t, opts.elbowAngleAt(i / 2, t));
    }
    const frame: LandmarkFrame = {
      t,
      left: null,
      right: fistAt(0.55 + opts.wristXAt(i), 0.58, opts.scaleAt(i)),
      face: null,
      pose: heldPose,
    };
    events.push(...engine.update(frame));
  }
  return { events, engine };
}

// Motion shapes shared by the scenarios. Frames 0..9 still; 10..15 fast
// lateral wrist travel (~1.5 u/s, crossing the 0.9 spike-speed threshold);
// 16..23 still again.
const still = (): number => 0;
const fastWrist = (i: number): number =>
  i < 10 ? 0 : i < 16 ? 0.05 * (i - 9) : 0.05 * 6;
const constScale = (): number => 0.16;
/** ~8%/frame apparent growth during the punch, shrink during the retract. */
const growShrinkScale = (i: number): number => {
  if (i < 10) return 0.16;
  if (i < 16) return 0.16 * Math.pow(1.08, i - 9);
  return 0.16 * Math.pow(1.08, 6) * Math.pow(0.92, i - 15);
};

/** Elbow ramp: guard, fast extension over the punch, fast re-flex after. */
const punchElbow = (_s: number, tMs: number): number => {
  if (tMs < 10 * DT_MS) return GUARD_ANGLE;
  if (tMs < 16 * DT_MS) return GUARD_ANGLE + 0.35 * (tMs / DT_MS - 9) * 0.5;
  const peak = GUARD_ANGLE + 0.35 * 3;
  return Math.max(GUARD_ANGLE, peak - 0.35 * (tMs / DT_MS - 15) * 0.5);
};

describe('punch fusion with FRESH pose', () => {
  it('primary + speed secondary fires a jab (growth stays flat)', () => {
    const { events, engine } = run({
      elbowAngleAt: punchElbow,
      wristXAt: fastWrist,
      scaleAt: constScale,
      frames: 24,
    });
    const jabs = events.filter((e) => e.move === 'jab-blast');
    expect(jabs).toHaveLength(1);
    const jab = jabs[0];
    if (!jab) throw new Error('no jab');
    expect(jab.hand).toBe('right');
    expect(jab.kind).toBe('trigger');
    // Normalized aim (forearm/velocity blend).
    expect(
      Math.hypot(jab.aim.x, jab.aim.y, jab.aim.z),
    ).toBeCloseTo(1, 5);
    expect(events).toHaveLength(1);
    // The fusion state reflects freshness for the HUD.
    expect(engine.fusionState.right.elbowFresh).toBe(true);
    expect(engine.fusionState.right.elbowThreshold).toBeCloseTo(3.6, 10);
  });

  it('secondaries alone do NOT fire when pose is fresh (elbow flat)', () => {
    // Speed AND growth both cross, but the elbow never extends: with pose
    // fresh the primary is required, so a hand-only artifact cannot fire.
    const { events } = run({
      elbowAngleAt: () => GUARD_ANGLE,
      wristXAt: fastWrist,
      scaleAt: growShrinkScale,
      frames: 24,
    });
    expect(events).toEqual([]);
  });

  it('the primary alone does NOT fire (hand quiet)', () => {
    const { events } = run({
      elbowAngleAt: punchElbow,
      wristXAt: still,
      scaleAt: constScale,
      frames: 24,
    });
    expect(events).toEqual([]);
  });
});

describe('interpolated pose frames (worker path)', () => {
  /**
   * Drive the engine with REAL pose samples every 2nd frame and an
   * INTERPOLATED frame (pose.interpolated = true, t advancing with the
   * frame clock) on the others, the exact shape the worker path emits.
   */
  function runWithInterpolation(opts: {
    sampleAngleAt: (sampleIndex: number, tMs: number) => number;
    interpAngleAt: (frame: number, tMs: number) => number;
    wristXAt: (frame: number) => number;
    scaleAt: (frame: number) => number;
    frames: number;
  }): MoveEvent[] {
    const engine = new MoveEngine();
    const events: MoveEvent[] = [];
    let heldSample: PoseFrame | null = null;
    for (let i = 0; i < opts.frames; i++) {
      const t = i * DT_MS;
      let pose: PoseFrame | null;
      if (i % 2 === 0) {
        heldSample = poseSample(t, opts.sampleAngleAt(i / 2, t));
        pose = heldSample;
      } else {
        // Synthetic in-between frame: whatever angle the interpolator would
        // produce, marked interpolated, timestamp = frame time.
        pose = {
          ...poseSample(t, opts.interpAngleAt(i, t)),
          interpolated: true,
        };
      }
      const frame: LandmarkFrame = {
        t,
        left: null,
        right: fistAt(0.55 + opts.wristXAt(i), 0.58, opts.scaleAt(i)),
        face: null,
        pose,
      };
      events.push(...engine.update(frame));
    }
    return events;
  }

  it('elbow tracker SKIPS interpolated frames: wild lerped angles with flat real samples never fire', () => {
    // Real samples stay at the guard angle (no extension: the fusion
    // primary must refuse). Interpolated frames swing to a straight arm,
    // which WOULD register a huge angular velocity if the tracker consumed
    // them. Speed secondary crosses throughout the punch window.
    const events = runWithInterpolation({
      sampleAngleAt: () => GUARD_ANGLE,
      interpAngleAt: () => Math.PI,
      wristXAt: fastWrist,
      scaleAt: constScale,
      frames: 24,
    });
    expect(events).toEqual([]);
  });

  it('real samples still drive the fusion through interleaved interpolated frames', () => {
    // The same punch as the fresh-pose happy path, but every odd frame is
    // an interpolated pose (angles lerped between the surrounding real
    // samples). The jab must fire exactly once off the REAL samples.
    const events = runWithInterpolation({
      sampleAngleAt: (_s, tMs) => punchElbow(_s, tMs),
      interpAngleAt: (_f, tMs) => punchElbow(0, tMs),
      wristXAt: fastWrist,
      scaleAt: constScale,
      frames: 24,
    });
    const jabs = events.filter((e) => e.move === 'jab-blast');
    expect(jabs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Vanished-hand elbow-only thrusts (2026-07-31 drill review): the tracker
// loses the hand during fast thrusts, so a hand tracked within
// HAND_VANISH_WINDOW_MS that is currently null may fire on the elbow
// PRIMARY alone at the data-derived ELBOW_VANISH_VEL floor. Aim comes from
// the forearm, origin from the pose wrist; retract resolution is the elbow
// re-flex, extend resolution is the hold timer.
// ---------------------------------------------------------------------------

describe('vanished-hand elbow-only thrusts', () => {
  /** Elbow ramp rates in rad per POSE SAMPLE (samples every 2 frames, 66 ms). */
  const FAST_STEP = 0.35; // ~5.3 rad/s: above the 4.29 vanish floor
  const RAISE_STEP = 0.257; // ~3.9 rad/s: the whip arm-re-raise regime

  interface VanishOpts {
    presentAt: (frame: number) => boolean;
    angleAt: (sampleIndex: number) => number;
    frames: number;
  }

  function runVanish(opts: VanishOpts): { events: MoveEvent[]; engine: MoveEngine } {
    const engine = new MoveEngine();
    const events: MoveEvent[] = [];
    let heldPose: PoseFrame | null = null;
    for (let i = 0; i < opts.frames; i++) {
      const t = i * DT_MS;
      if (i % 2 === 0) heldPose = poseSample(t, opts.angleAt(i / 2));
      const frame: LandmarkFrame = {
        t,
        left: null,
        right: opts.presentAt(i) ? fistAt(0.55, 0.58, 0.16) : null,
        face: null,
        pose: heldPose,
      };
      events.push(...engine.update(frame));
    }
    return { events, engine };
  }

  /** Guard hold, fast extension over samples 5..7, fast re-flex after 8. */
  const punchThenReflex = (s: number): number => {
    if (s < 5) return GUARD_ANGLE;
    if (s <= 8) return GUARD_ANGLE + FAST_STEP * (s - 5 + 1);
    return Math.max(GUARD_ANGLE, GUARD_ANGLE + FAST_STEP * 4 - FAST_STEP * (s - 8));
  };

  it('sanity: the fast ramp crosses the vanish floor, the raise ramp does not', () => {
    expect(FAST_STEP / 0.066).toBeGreaterThan(ELBOW_VANISH_VEL);
    expect(RAISE_STEP / 0.066).toBeLessThan(ELBOW_VANISH_VEL);
    expect(RAISE_STEP / 0.066).toBeGreaterThan(3.6); // above the plain elbow gate
  });

  it('hand vanishes mid-punch: elbow spike + re-flex fires exactly one jab from the pose wrist', () => {
    const { events } = runVanish({
      presentAt: (i) => i < 10, // tracked through the wind-up, lost at the punch
      angleAt: punchThenReflex,
      frames: 24,
    });
    const jabs = events.filter((e) => e.move === 'jab-blast');
    expect(jabs).toHaveLength(1);
    expect(events).toHaveLength(1);
    const jab = jabs[0];
    if (!jab) throw new Error('no jab');
    expect(jab.kind).toBe('trigger');
    expect(jab.hand).toBe('right');
    // Origin is the POSE wrist (screenArm right), not a hand landmark.
    expect(jab.origin.x).toBeCloseTo(0.7, 5);
    expect(jab.origin.y).toBeCloseTo(0.55, 5);
    // Aim is the normalized forearm direction.
    expect(Math.hypot(jab.aim.x, jab.aim.y, jab.aim.z)).toBeCloseTo(1, 5);
  });

  it('does not double-fire when the hand reappears with a reacquisition spike', () => {
    const { events } = runVanish({
      // Lost during the punch, reacquired right after the re-flex.
      presentAt: (i) => i < 10 || i >= 18,
      angleAt: punchThenReflex,
      frames: 30,
    });
    expect(events.filter((e) => e.move === 'jab-blast')).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('the whip arm-re-raise regime (~3.9 rad/s) stays silent: the data-derived floor rejects it', () => {
    const raise = (s: number): number =>
      s < 5 ? GUARD_ANGLE : GUARD_ANGLE + RAISE_STEP * Math.min(4, s - 4);
    const { events } = runVanish({
      presentAt: (i) => i < 10,
      angleAt: raise,
      frames: 24,
    });
    expect(events).toEqual([]);
  });

  it('a hand gone longer than HAND_VANISH_WINDOW_MS cannot fire', () => {
    // Hand tracked only for the first 3 frames; the elbow spike starts at
    // sample 8 (t = 528 ms), far beyond the vanish window.
    const lateSpike = (s: number): number => {
      if (s < 8) return GUARD_ANGLE;
      if (s <= 11) return GUARD_ANGLE + FAST_STEP * (s - 8 + 1);
      return Math.max(GUARD_ANGLE, GUARD_ANGLE + FAST_STEP * 4 - FAST_STEP * (s - 11));
    };
    const { events } = runVanish({
      presentAt: (i) => i < 3,
      angleAt: lateSpike,
      frames: 30,
    });
    expect(16 * DT_MS - 2 * DT_MS).toBeGreaterThan(HAND_VANISH_WINDOW_MS); // sanity
    expect(events).toEqual([]);
  });

  it('elbow staying extended resolves to a fire-stream sustain, ended by the re-flex', () => {
    // Extend over samples 5..8, HOLD the extended angle (no re-flex) well
    // past EXTEND_HOLD_MS, then fold back fast.
    const extendHoldReflex = (s: number): number => {
      if (s < 5) return GUARD_ANGLE;
      if (s <= 8) return GUARD_ANGLE + FAST_STEP * (s - 5 + 1);
      if (s <= 20) return GUARD_ANGLE + FAST_STEP * 4; // held extended
      return Math.max(GUARD_ANGLE, GUARD_ANGLE + FAST_STEP * 4 - FAST_STEP * (s - 20));
    };
    const { events } = runVanish({
      presentAt: (i) => i < 10,
      angleAt: extendHoldReflex,
      frames: 50,
    });
    for (const e of events) expect(e.move).toBe('fire-stream');
    const first = events[0];
    const last = events[events.length - 1];
    if (!first || !last) throw new Error('no sustain events');
    expect(first.kind).toBe('sustain-start');
    expect(last.kind).toBe('sustain-end');
    expect(events.filter((e) => e.kind === 'sustain-tick').length).toBeGreaterThan(3);
  });
});

describe('punch fusion with pose ABSENT (fallback rule)', () => {
  it('both secondaries fire a jab', () => {
    const { events } = run({
      elbowAngleAt: null,
      wristXAt: fastWrist,
      scaleAt: growShrinkScale,
      frames: 24,
    });
    const jabs = events.filter((e) => e.move === 'jab-blast');
    expect(jabs).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('one secondary alone does not fire (speed without growth)', () => {
    const { events } = run({
      elbowAngleAt: null,
      wristXAt: fastWrist,
      scaleAt: constScale,
      frames: 24,
    });
    expect(events).toEqual([]);
  });

  it('a STALE pose sample runs the fallback rule, not the fusion rule', () => {
    // The attached pose was sampled at t=0 and never refreshed; by the punch
    // frames it is far older than POSE_FRESH_MS, so the elbow (flat) must
    // not veto a fallback two-secondary jab.
    const stale = poseSample(0, GUARD_ANGLE);
    const { events } = run({
      elbowAngleAt: null,
      stalePose: stale,
      wristXAt: fastWrist,
      scaleAt: growShrinkScale,
      frames: 24,
    });
    expect(16 * DT_MS).toBeGreaterThan(POSE_FRESH_MS); // sanity: truly stale
    const jabs = events.filter((e) => e.move === 'jab-blast');
    expect(jabs).toHaveLength(1);
  });
});
