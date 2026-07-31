/**
 * Hip-relative low bands (R3 Phase 3, src/gestures/moves.ts): when body pose
 * is FRESH the Breath Charge "at hips" band and the Rising Flame "low" band
 * anchor to the player's real hip line (hip center y minus a small margin);
 * pose absent keeps the absolute BREATH_HIP_Y / RISING_LOW_Y constants, the
 * exact classic behavior every legacy fixture runs on. Both paths are
 * exercised here with hand-built frames.
 */

import { describe, expect, it } from 'vitest';
import {
  BREATH_HIP_MARGIN,
  BREATH_HIP_Y,
  MoveEngine,
  RISING_LOW_MARGIN,
  RISING_LOW_Y,
  type MoveEvent,
} from '../src/gestures/moves';
import { placePose } from '../fixtures/lib';
import type {
  HandFrame,
  LandmarkFrame,
  PoseArm,
  PoseFrame,
  Vec3,
} from '../src/tracking/types';

const DT_MS = 33;

const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

function handAt(
  pose: 'fist' | 'palm',
  side: 'left' | 'right',
  wrist: Vec3,
): HandFrame {
  return { landmarks: placePose(pose, wrist, side), confidence: 0.95 };
}

/** Static body pose with the hip line at hipY (screen space, y down). */
function poseAt(t: number, hipY: number): PoseFrame {
  const arm = (m: number): PoseArm => ({
    shoulder: v(0.5 + 0.14 * m, hipY - 0.35),
    elbow: v(0.5 + 0.17 * m, hipY - 0.18),
    wrist: v(0.5 + 0.2 * m, hipY - 0.02),
    hip: v(0.5 + 0.08 * m, hipY),
  });
  return { t, left: arm(-1), right: arm(1), world: null, confidence: 1 };
}

/** Run a per-frame wrist-y schedule through a fresh engine. */
function run(
  pose: 'fist' | 'palm',
  wristYAt: (i: number) => number,
  frames: number,
  hipY: number | null,
): MoveEvent[] {
  const engine = new MoveEngine();
  const events: MoveEvent[] = [];
  for (let i = 0; i < frames; i++) {
    const t = i * DT_MS;
    const y = wristYAt(i);
    const frame: LandmarkFrame = {
      t,
      left: handAt(pose, 'left', v(0.35, y, 0)),
      right: handAt(pose, 'right', v(0.65, y, 0)),
      face: null,
      ...(hipY !== null ? { pose: poseAt(t, hipY) } : {}),
    };
    events.push(...engine.update(frame));
  }
  return events;
}

const still = (y: number) => (): number => y;

// ---------------------------------------------------------------------------
// Breath Charge band
// ---------------------------------------------------------------------------

describe('Breath Charge hip band', () => {
  it('pose fresh: fists just under the REAL hip line charge even high on screen', () => {
    // Hips at 0.55 (a close-framed camera): the dynamic band is
    // 0.55 - margin = 0.50, so fists at 0.60 count as "at hips" although
    // the absolute constant (0.7) would refuse them.
    expect(0.6).toBeLessThan(BREATH_HIP_Y);
    expect(0.6).toBeGreaterThan(0.55 - BREATH_HIP_MARGIN);
    const events = run('fist', still(0.6), 50, 0.55);
    expect(events.map((e) => e.move)).toEqual(['breath-charge']);
  });

  it('pose fresh: a LOW hip line tightens the band below the old constant', () => {
    // Hips at 0.9: the dynamic band is 0.85, so fists at 0.75 (which the
    // absolute constant would accept) are NOT at the hips.
    expect(0.75).toBeGreaterThan(BREATH_HIP_Y);
    const events = run('fist', still(0.75), 60, 0.9);
    expect(events).toEqual([]);
  });

  it('pose absent: the absolute BREATH_HIP_Y fallback is unchanged', () => {
    expect(run('fist', still(0.75), 50, null).map((e) => e.move)).toEqual([
      'breath-charge',
    ]);
    expect(run('fist', still(0.6), 50, null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rising Flame band
// ---------------------------------------------------------------------------

/** Static low hold, then a fast upward sweep (~1.5 u/s). */
const holdThenSweep =
  (y0: number) =>
  (i: number): number =>
    i < 12 ? y0 : Math.max(0.2, y0 - 0.05 * (i - 11));

describe('Rising Flame low band', () => {
  it('pose fresh: palms just under the REAL hip line arm the rise', () => {
    // Hips at 0.55: dynamic low band 0.45, so palms at 0.6 are "low"
    // although the absolute constant (0.65) would refuse them.
    expect(0.6).toBeLessThan(RISING_LOW_Y);
    expect(0.6).toBeGreaterThan(0.55 - RISING_LOW_MARGIN);
    const events = run('palm', holdThenSweep(0.6), 24, 0.55);
    expect(events.map((e) => e.move)).toEqual(['rising-flame']);
  });

  it('pose absent: palms at 0.6 are not low; the absolute fallback holds', () => {
    expect(run('palm', holdThenSweep(0.6), 24, null)).toEqual([]);
    // The classic low position still works without pose.
    const classic = run('palm', holdThenSweep(0.7), 24, null);
    expect(classic.map((e) => e.move)).toEqual(['rising-flame']);
  });
});
