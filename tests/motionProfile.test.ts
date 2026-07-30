/**
 * Palm-span motion signals (src/gestures/motion.ts) and the per-player
 * MotionProfile / MotionThresholds derivation (src/gestures/profile.ts).
 *
 * The pivotal invariant: thresholdsFrom(DEFAULT_PROFILE) must reproduce the
 * previously tuned absolute constants exactly, so every replay fixture and
 * test stays deterministic with no stored profile.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spanOf, spanGrowthRate } from '../src/gestures/motion';
import {
  AIM_FRACTION,
  DEFAULT_PROFILE,
  JAB_TRIGGER_FRACTION,
  NEUTRAL_FLOOR_MULT,
  PROFILE_STORAGE_KEY,
  RETRACT_FRACTION,
  STATIC_FRACTION,
  SWEEP_FRACTION,
  clearProfile,
  loadProfile,
  saveProfile,
  thresholdsFrom,
  type MotionProfile,
} from '../src/gestures/profile';
import { placePose, vec } from '../fixtures/lib';
import type { HandFrame, Vec3 } from '../src/tracking/types';
import { HAND_LANDMARK_COUNT } from '../src/tracking/types';

const DT = 1 / 30;

function handAt(wrist: Vec3, scale: number): HandFrame {
  return { landmarks: placePose('fist', wrist, 'right', scale), confidence: 0.95 };
}

// ---------------------------------------------------------------------------
// spanOf / spanGrowthRate
// ---------------------------------------------------------------------------

describe('spanOf', () => {
  it('scales linearly with the hand size', () => {
    const small = spanOf(handAt(vec(0.5, 0.5, 0), 0.1));
    const large = spanOf(handAt(vec(0.5, 0.5, 0), 0.2));
    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeCloseTo(2, 5);
  });

  it('is translation invariant', () => {
    const a = spanOf(handAt(vec(0.2, 0.3, -0.1), 0.16));
    const b = spanOf(handAt(vec(0.8, 0.7, 0), 0.16));
    expect(a).toBeCloseTo(b, 6);
  });

  it('survives single-axis foreshortening via the max of length and width', () => {
    // Squash the palm LENGTH to 30% (pitch foreshortening): the knuckle
    // width survives and keeps the span at ~70% instead of collapsing to 30%.
    const base = handAt(vec(0.5, 0.5, 0), 0.16);
    const pitched: HandFrame = {
      landmarks: base.landmarks.map((p) => ({
        x: p.x,
        y: 0.5 + (p.y - 0.5) * 0.3,
        z: p.z,
      })),
      confidence: 0.95,
    };
    expect(spanOf(pitched)).toBeGreaterThan(spanOf(base) * 0.5);
  });

  it('returns 0 for a fully collapsed hand', () => {
    const collapsed: HandFrame = {
      landmarks: Array.from({ length: HAND_LANDMARK_COUNT }, () => vec(0.5, 0.5, 0)),
      confidence: 0.95,
    };
    expect(spanOf(collapsed)).toBe(0);
  });
});

describe('spanGrowthRate', () => {
  it('is positive for a growing hand and negative for a shrinking one', () => {
    const growing = [0.1, 0.11, 0.12, 0.13, 0.14, 0.15].map((s) =>
      handAt(vec(0.5, 0.5, 0), s),
    );
    const shrinking = [...growing].reverse();
    expect(spanGrowthRate(growing, DT)).toBeGreaterThan(0);
    expect(spanGrowthRate(shrinking, DT)).toBeLessThan(0);
  });

  it('matches the analytic relative rate for uniform growth', () => {
    // 10% growth per frame at 30 fps: d(span)/dt / span ~ 0.1 * 30 relative
    // to the current span (average pairwise, divided by the LAST span).
    const frames = [0.1, 0.11, 0.121].map((s) => handAt(vec(0.5, 0.5, 0), s));
    const rate = spanGrowthRate(frames, DT);
    // Average pairwise d(span) = 0.0105 * spanUnit; current = 0.121 * spanUnit.
    expect(rate).toBeCloseTo((0.0105 / DT) / 0.121, 3);
  });

  it('is invariant to distance from the camera (relative, not absolute)', () => {
    const near = [0.2, 0.22, 0.24].map((s) => handAt(vec(0.5, 0.5, 0), s));
    const far = [0.1, 0.11, 0.12].map((s) => handAt(vec(0.5, 0.5, 0), s));
    expect(spanGrowthRate(near, DT)).toBeCloseTo(spanGrowthRate(far, DT), 5);
  });

  it('guards degenerate input: short windows, bad dt, collapsed spans', () => {
    const hand = handAt(vec(0.5, 0.5, 0), 0.16);
    const collapsed: HandFrame = {
      landmarks: Array.from({ length: HAND_LANDMARK_COUNT }, () => vec(0.5, 0.5, 0)),
      confidence: 0.95,
    };
    expect(spanGrowthRate([], DT)).toBe(0);
    expect(spanGrowthRate([hand], DT)).toBe(0);
    expect(spanGrowthRate([hand, hand], 0)).toBe(0);
    expect(spanGrowthRate([collapsed, collapsed], DT)).toBe(0);
    expect(spanGrowthRate([hand, collapsed], DT)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// thresholdsFrom
// ---------------------------------------------------------------------------

describe('thresholdsFrom', () => {
  it('reproduces the classic tuned values from DEFAULT_PROFILE', () => {
    const th = thresholdsFrom(DEFAULT_PROFILE);
    expect(th.spikeSpeed).toBeCloseTo(0.9, 10); // old SPIKE_SPEED_MIN
    expect(th.spikeGrowth).toBeCloseTo(1.35, 10); // fixture-consistent
    expect(th.retractShrink).toBeCloseTo(1.05, 10); // fixture-consistent
    expect(th.risingUpVel).toBeCloseTo(1.0, 10); // old RISING_UP_VEL_MIN
    expect(th.whipSwingVx).toBeCloseTo(1.0, 10); // old WHIP_SWING_VX_MIN
    expect(th.whipStaticMax).toBeCloseTo(0.3, 10); // old WHIP_STATIC_SPEED_MAX
    expect(th.breathStaticMax).toBeCloseTo(0.4, 10); // old BREATH_STATIC_SPEED_MAX
    expect(th.aimMinSpeed).toBeCloseTo(0.5, 10); // old AIM_MIN_SPEED
  });

  it('derives triggers from the documented fractions of the peaks', () => {
    const strong: MotionProfile = {
      ...DEFAULT_PROFILE,
      peakPunchSpeed: 4,
      peakPunchGrowth: 6,
    };
    const th = thresholdsFrom(strong);
    expect(th.spikeSpeed).toBeCloseTo(JAB_TRIGGER_FRACTION * 4, 10);
    expect(th.spikeGrowth).toBeCloseTo(JAB_TRIGGER_FRACTION * 6, 10);
    expect(th.retractShrink).toBeCloseTo(RETRACT_FRACTION * 6, 10);
    expect(th.risingUpVel).toBeCloseTo(SWEEP_FRACTION * 4, 10);
    expect(th.whipSwingVx).toBeCloseTo(SWEEP_FRACTION * 4, 10);
    expect(th.whipStaticMax).toBeCloseTo(STATIC_FRACTION * 4, 10);
    expect(th.aimMinSpeed).toBeCloseTo(AIM_FRACTION * 4, 10);
  });

  it('a degenerate near-zero profile can never hair-trigger', () => {
    const broken: MotionProfile = {
      version: 1,
      peakPunchSpeed: 0.01,
      peakPunchGrowth: 0.01,
      peakPalmSpeed: 0.01,
      peakPalmGrowth: 0.01,
      neutralSpeed: 0,
      neutralGrowth: 0,
      capturedAt: 'broken',
    };
    const th = thresholdsFrom(broken);
    // Absolute safety floors hold the line.
    expect(th.spikeSpeed).toBeGreaterThanOrEqual(0.5);
    expect(th.spikeGrowth).toBeGreaterThanOrEqual(0.6);
    expect(th.retractShrink).toBeGreaterThanOrEqual(0.5);
    expect(th.risingUpVel).toBeGreaterThanOrEqual(0.6);
    expect(th.whipSwingVx).toBeGreaterThanOrEqual(0.6);
    expect(th.aimMinSpeed).toBeGreaterThanOrEqual(0.5);
  });

  it('a twitchy neutral baseline raises thresholds via the 3x floor', () => {
    const twitchy: MotionProfile = {
      ...DEFAULT_PROFILE,
      neutralSpeed: 0.5,
      neutralGrowth: 0.8,
    };
    const th = thresholdsFrom(twitchy);
    expect(th.spikeSpeed).toBeCloseTo(NEUTRAL_FLOOR_MULT * 0.5, 10);
    expect(th.spikeGrowth).toBeCloseTo(NEUTRAL_FLOOR_MULT * 0.8, 10);
    expect(th.whipStaticMax).toBeCloseTo(NEUTRAL_FLOOR_MULT * 0.5, 10);
    expect(th.breathStaticMax).toBeCloseTo(NEUTRAL_FLOOR_MULT * 0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// Persistence (localStorage stubbed; vitest runs in node)
// ---------------------------------------------------------------------------

function stubStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const stub = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) ?? null) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
  (globalThis as Record<string, unknown>)['localStorage'] = stub;
  return map;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['localStorage'];
});

describe('profile persistence', () => {
  it('returns null when no storage exists (node default)', () => {
    expect(loadProfile()).toBeNull();
    // And the writers are safe no-ops.
    saveProfile(DEFAULT_PROFILE);
    clearProfile();
  });

  it('round-trips a valid profile', () => {
    stubStorage();
    const profile: MotionProfile = {
      version: 1,
      peakPunchSpeed: 2.4,
      peakPunchGrowth: 3.6,
      peakPalmSpeed: 1.8,
      peakPalmGrowth: 3.1,
      neutralSpeed: 0.12,
      neutralGrowth: 0.2,
      capturedAt: '2026-07-30T00:00:00.000Z',
    };
    saveProfile(profile);
    expect(loadProfile()).toEqual(profile);
    clearProfile();
    expect(loadProfile()).toBeNull();
  });

  it('rejects wrong versions, NaN, non-finite, negative, and junk JSON', () => {
    const map = stubStorage();
    const good = JSON.parse(JSON.stringify(DEFAULT_PROFILE)) as Record<string, unknown>;

    map.set(PROFILE_STORAGE_KEY, 'not json {');
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, version: 2 }));
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, peakPunchSpeed: 'fast' }));
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, neutralSpeed: -1 }));
    expect(loadProfile()).toBeNull();

    // JSON cannot carry NaN/Infinity; they arrive as null and must reject.
    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, peakPunchGrowth: null }));
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, capturedAt: 7 }));
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify(good));
    expect(loadProfile()).not.toBeNull();
  });
});
