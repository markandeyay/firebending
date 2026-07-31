/**
 * Framing gate (src/game/framingGate.ts): the failure discriminator against
 * synthetic poses for EVERY corrective id, the exact user text, the 2 s
 * continuous-hold gate, the mid-game FramingLossWatch, and the TrackingLoss
 * forceLost extension the arena maps a framing loss onto.
 */

import { describe, expect, it } from 'vitest';
import {
  FRAMING_HOLD_SEC,
  FRAMING_LOSS_SEC,
  FRAMING_TEXT,
  FramingGate,
  FramingLossWatch,
  evaluateFraming,
  estimateHeadTopY,
  type FramingFrame,
} from '../src/game/framingGate';
import { TrackingLoss, RESUME_COUNTDOWN_SEC } from '../src/game/trackingLoss';
import type { HandFrame, PoseFrame, PoseHead, Vec3 } from '../src/tracking/types';

// ---------------------------------------------------------------------------
// Synthetic frames
// ---------------------------------------------------------------------------

const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

const hand = (): HandFrame => ({ landmarks: [], confidence: 0.9 });

/** Head block: eyes at eyeY, ears 0.1 apart (head-top margin 0.09). */
function head(eyeY: number): PoseHead {
  return {
    nose: v(0.5, eyeY + 0.03),
    leftEye: v(0.47, eyeY),
    rightEye: v(0.53, eyeY),
    leftEar: v(0.45, eyeY + 0.02),
    rightEar: v(0.55, eyeY + 0.02),
  };
}

interface BodyOpts {
  shoulderY?: number;
  hipY?: number;
  shoulderHalf?: number;
  hipHalf?: number;
  eyeY?: number;
  confidence?: number;
  noHead?: boolean;
}

/** A well-framed standing player unless overridden. */
function bodyPose(opts: BodyOpts = {}): PoseFrame {
  const sy = opts.shoulderY ?? 0.3;
  const hy = opts.hipY ?? 0.68;
  const sh = opts.shoulderHalf ?? 0.15;
  const hh = opts.hipHalf ?? 0.09;
  const arm = (m: number) => ({
    shoulder: v(0.5 + sh * m, sy),
    elbow: v(0.5 + (sh + 0.03) * m, (sy + hy) / 2),
    wrist: v(0.5 + (sh + 0.06) * m, hy),
    hip: v(0.5 + hh * m, hy),
  });
  return {
    t: 0,
    left: arm(-1),
    right: arm(1),
    world: null,
    confidence: opts.confidence ?? 1,
    ...(opts.noHead ? {} : { head: head(opts.eyeY ?? 0.14) }),
  };
}

function frameOf(
  pose: PoseFrame | null,
  left: HandFrame | null = hand(),
  right: HandFrame | null = hand(),
): FramingFrame {
  return { left, right, pose };
}

// ---------------------------------------------------------------------------
// Head-top estimate
// ---------------------------------------------------------------------------

describe('estimateHeadTopY', () => {
  it('extrapolates above the eyes by the ear-distance margin', () => {
    // Ears 0.1 apart -> margin max(0.9 * 0.1, 0.06) = 0.09 above eye y 0.2.
    expect(estimateHeadTopY(bodyPose({ eyeY: 0.2 }))).toBeCloseTo(0.11, 10);
  });

  it('is null without head landmarks', () => {
    expect(estimateHeadTopY(bodyPose({ noHead: true }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Discriminator: one synthetic pose per corrective id
// ---------------------------------------------------------------------------

describe('evaluateFraming discriminator', () => {
  it('passes a well-framed standing player with both hands', () => {
    const ev = evaluateFraming(frameOf(bodyPose()));
    expect(ev.ok).toBe(true);
    expect(ev.failures).toEqual([]);
    expect(ev.regions).toEqual({
      head: true,
      shoulders: true,
      hips: true,
      hands: true,
      standing: true,
    });
  });

  it('step-back: shoulder width above 0.55 (subject too large)', () => {
    // Hips pushed low keeps the standing ratio healthy so ONLY size fails.
    const ev = evaluateFraming(
      frameOf(bodyPose({ shoulderHalf: 0.3, hipY: 0.95, hipHalf: 0.18 })),
    );
    expect(ev.ok).toBe(false);
    expect(ev.failures.map((f) => f.id)).toEqual(['step-back']);
    expect(ev.failures[0]?.text).toBe('Step back');
    expect(ev.regions.shoulders).toBe(false);
  });

  it('step-back also covers head AND hips clipped at moderate width', () => {
    const ev = evaluateFraming(
      frameOf(bodyPose({ eyeY: 0.04, hipY: 1.02, hipHalf: 0.09 })),
    );
    expect(ev.failures[0]?.id).toBe('step-back');
  });

  it('step-closer: shoulder width under 0.18 (subject too small)', () => {
    const ev = evaluateFraming(
      frameOf(bodyPose({ shoulderHalf: 0.06, hipHalf: 0.04 })),
    );
    expect(ev.failures.map((f) => f.id)).toEqual(['step-closer']);
    expect(ev.failures[0]?.text).toBe('Step closer');
  });

  it('raise-camera: head top clipped while the hips stay in frame', () => {
    // Eyes at y 0.05 -> estimated top -0.04, below the 0.03 edge floor.
    const ev = evaluateFraming(frameOf(bodyPose({ eyeY: 0.05 })));
    expect(ev.failures.map((f) => f.id)).toEqual(['raise-camera']);
    expect(ev.failures[0]?.text).toBe('Raise your camera');
    expect(ev.regions.head).toBe(false);
    expect(ev.regions.hips).toBe(true);
  });

  it('raise-camera also fires when head landmarks are missing entirely', () => {
    const ev = evaluateFraming(frameOf(bodyPose({ noHead: true })));
    expect(ev.failures[0]?.id).toBe('raise-camera');
  });

  it('lower-camera: hips clipped at the bottom while the head has room', () => {
    // Eyes at 0.25 -> top 0.16, comfortably below; hips at 1.02, clipped.
    const ev = evaluateFraming(frameOf(bodyPose({ eyeY: 0.25, hipY: 1.02 })));
    expect(ev.failures.map((f) => f.id)).toEqual(['lower-camera']);
    expect(ev.failures[0]?.text).toBe('Lower your camera');
    expect(ev.regions.hips).toBe(false);
  });

  it('stand-up: seated geometry (short torso, no legs) scores below 0.6', () => {
    const ev = evaluateFraming(
      frameOf(bodyPose({ shoulderY: 0.35, hipY: 0.55, shoulderHalf: 0.17, eyeY: 0.2 })),
    );
    expect(ev.failures.map((f) => f.id)).toEqual(['stand-up']);
    expect(ev.failures[0]?.text).toBe('Stand up');
    expect(ev.standing).toBeLessThan(0.6);
  });

  it('show-hands: a missing hand while the body framing is fine', () => {
    const ev = evaluateFraming(frameOf(bodyPose(), null, hand()));
    expect(ev.failures.map((f) => f.id)).toEqual(['show-hands']);
    expect(ev.failures[0]?.text).toBe('Show both hands');
    // A low-confidence hand counts as missing too.
    const dim = evaluateFraming(
      frameOf(bodyPose(), { landmarks: [], confidence: 0.3 }, hand()),
    );
    expect(dim.failures.map((f) => f.id)).toEqual(['show-hands']);
  });

  it('more-light: low pose confidence returns that failure alone', () => {
    const ev = evaluateFraming(frameOf(bodyPose({ confidence: 0.3 })));
    expect(ev.failures.map((f) => f.id)).toEqual(['more-light']);
    expect(ev.failures[0]?.text).toBe('More light on your hands');
    expect(evaluateFraming(frameOf(null)).failures[0]?.id).toBe('more-light');
  });

  it('priority: body-position failures outrank show-hands', () => {
    const ev = evaluateFraming(
      frameOf(
        bodyPose({ shoulderY: 0.35, hipY: 0.55, shoulderHalf: 0.17, eyeY: 0.2 }),
        null,
        null,
      ),
    );
    expect(ev.failures.map((f) => f.id)).toEqual(['stand-up', 'show-hands']);
    expect(ev.failures[0]?.id).toBe('stand-up');
  });

  it('every corrective id maps to its exact user text', () => {
    expect(FRAMING_TEXT).toEqual({
      'step-back': 'Step back',
      'step-closer': 'Step closer',
      'raise-camera': 'Raise your camera',
      'lower-camera': 'Lower your camera',
      'stand-up': 'Stand up',
      'show-hands': 'Show both hands',
      'more-light': 'More light on your hands',
    });
  });
});

// ---------------------------------------------------------------------------
// Gate hold
// ---------------------------------------------------------------------------

describe('FramingGate', () => {
  it('passes only after 2 s of continuous hold; a dip resets the timer', () => {
    const gate = new FramingGate();
    const good = frameOf(bodyPose());
    let state = gate.update(good, 0.5);
    expect(state.passed).toBe(false);
    expect(state.remainingSec).toBeCloseTo(FRAMING_HOLD_SEC - 0.5, 10);
    state = gate.update(good, 1.0);
    expect(state.passed).toBe(false);

    // A dip (hand lost) resets the hold completely.
    state = gate.update(frameOf(bodyPose(), null, hand()), 0.4);
    expect(state.passed).toBe(false);
    expect(state.remainingSec).toBe(FRAMING_HOLD_SEC);
    expect(state.top?.id).toBe('show-hands');

    state = gate.update(good, 1.0);
    state = gate.update(good, 1.0);
    expect(state.passed).toBe(true);
    expect(state.remainingSec).toBe(0);
    expect(state.top).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mid-game watch
// ---------------------------------------------------------------------------

describe('FramingLossWatch', () => {
  it('declares loss after 2 s of continuous bad framing, then demands the gate', () => {
    const watch = new FramingLossWatch();
    const bad = frameOf(bodyPose({ eyeY: 0.05 })); // head clipped
    const good = frameOf(bodyPose());

    expect(watch.update(bad, 1.0)).toBe(false);
    // A good frame resets the accumulation.
    expect(watch.update(good, 1.0)).toBe(false);
    expect(watch.update(bad, 1.0)).toBe(false);
    expect(watch.update(bad, 1.5)).toBe(true); // 2.5 s > FRAMING_LOSS_SEC
    expect(watch.gateState?.top?.id).toBe('raise-camera');

    // Recovery: the gate must hold FRAMING_HOLD_SEC before the watch clears.
    expect(watch.update(good, 1.0)).toBe(true);
    expect(watch.update(good, 1.5)).toBe(false);
    expect(watch.gateState).toBeNull();
    expect(FRAMING_LOSS_SEC).toBe(2.0);
  });

  it('ignores pose-absent frames (the hand-loss FSM covers those)', () => {
    const watch = new FramingLossWatch();
    for (let i = 0; i < 10; i++) {
      expect(watch.update(frameOf(null), 1.0)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// TrackingLoss forceLost (arena mapping)
// ---------------------------------------------------------------------------

describe('TrackingLoss forceLost', () => {
  it('drops playing into lost immediately and resumes through the countdown', () => {
    const loss = new TrackingLoss();
    expect(loss.update(true, 0.016, true, true)).toEqual(['lost']);
    expect(loss.paused).toBe(true);

    // Framing restored: both-hands true starts the normal countdown.
    expect(loss.update(true, 0.016)).toEqual(['countdown-start']);
    const events = loss.update(true, RESUME_COUNTDOWN_SEC);
    expect(events).toContain('resumed');
    expect(loss.paused).toBe(false);
  });

  it('does not disturb the classic no-force behavior', () => {
    const loss = new TrackingLoss();
    expect(loss.update(true, 0.5, true, false)).toEqual([]);
    expect(loss.state).toBe('playing');
  });
});
