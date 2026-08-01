/**
 * Apparent-size motion signals (src/gestures/motion.ts) and the per-player
 * MotionProfile v2 / MotionThresholds derivation (src/gestures/profile.ts).
 *
 * The pivotal invariant: thresholdsFrom(DEFAULT_PROFILE) must reproduce the
 * previously tuned absolute constants exactly, so every replay fixture and
 * test stays deterministic with no stored profile. v2 renames the growth
 * fields to bbox semantics and adds the elbow angular-velocity fields; a
 * stored v1 profile must load as null (forced recalibration).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  bboxDiagOf,
  bboxGrowthRate,
  spanOf,
  spanGrowthRate,
} from '../src/gestures/motion';
import {
  AIM_FRACTION,
  DEFAULT_PROFILE,
  FLOOR_ELBOW_VEL,
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
// spanOf / bboxDiagOf
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

describe('bboxDiagOf', () => {
  it('scales linearly with the hand size and ignores translation', () => {
    const small = bboxDiagOf(handAt(vec(0.5, 0.5, 0), 0.1));
    const large = bboxDiagOf(handAt(vec(0.2, 0.8, -0.1), 0.2));
    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeCloseTo(2, 5);
  });

  it('is larger than the palm span (full-hand extent vs two palm points)', () => {
    const hand = handAt(vec(0.5, 0.5, 0), 0.16);
    expect(bboxDiagOf(hand)).toBeGreaterThan(spanOf(hand));
  });

  it('survives a palm-measurement collapse that zeroes the span', () => {
    // Clench simulation: wrist and both palm landmark pairs collapse onto a
    // point while the finger cluster keeps its extent. Span dies; bbox holds.
    const base = handAt(vec(0.5, 0.5, 0), 0.16);
    const clenched: HandFrame = {
      landmarks: base.landmarks.map((p, i) =>
        i === 0 || i === 5 || i === 9 || i === 17 ? vec(0.5, 0.5, 0) : p,
      ),
      confidence: 0.95,
    };
    expect(spanOf(clenched)).toBe(0);
    expect(bboxDiagOf(clenched)).toBeGreaterThan(bboxDiagOf(base) * 0.4);
  });

  it('returns 0 for empty or fully collapsed hands', () => {
    expect(bboxDiagOf({ landmarks: [], confidence: 0.9 })).toBe(0);
    const collapsed: HandFrame = {
      landmarks: Array.from({ length: HAND_LANDMARK_COUNT }, () => vec(0.5, 0.5, 0)),
      confidence: 0.95,
    };
    expect(bboxDiagOf(collapsed)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Growth rates
// ---------------------------------------------------------------------------

describe('bboxGrowthRate', () => {
  it('is positive for a growing hand and negative for a shrinking one', () => {
    const growing = [0.1, 0.11, 0.12, 0.13, 0.14, 0.15].map((s) =>
      handAt(vec(0.5, 0.5, 0), s),
    );
    const shrinking = [...growing].reverse();
    expect(bboxGrowthRate(growing, DT)).toBeGreaterThan(0);
    expect(bboxGrowthRate(shrinking, DT)).toBeLessThan(0);
  });

  it('matches the span growth rate under uniform scaling', () => {
    // Uniform scaling changes every size measure at the same relative rate,
    // which is exactly why the fixture suite kept firing after the switch.
    const frames = [0.1, 0.11, 0.121].map((s) => handAt(vec(0.5, 0.5, 0), s));
    expect(bboxGrowthRate(frames, DT)).toBeCloseTo(spanGrowthRate(frames, DT), 6);
  });

  it('matches the analytic relative rate for uniform growth', () => {
    const frames = [0.1, 0.11, 0.121].map((s) => handAt(vec(0.5, 0.5, 0), s));
    const rate = bboxGrowthRate(frames, DT);
    // Average pairwise d(size) = 0.0105 * unit; current = 0.121 * unit.
    expect(rate).toBeCloseTo((0.0105 / DT) / 0.121, 3);
  });

  it('is invariant to distance from the camera (relative, not absolute)', () => {
    const near = [0.2, 0.22, 0.24].map((s) => handAt(vec(0.5, 0.5, 0), s));
    const far = [0.1, 0.11, 0.12].map((s) => handAt(vec(0.5, 0.5, 0), s));
    expect(bboxGrowthRate(near, DT)).toBeCloseTo(bboxGrowthRate(far, DT), 5);
  });

  it('guards degenerate input: short windows, bad dt, collapsed hands', () => {
    const hand = handAt(vec(0.5, 0.5, 0), 0.16);
    const collapsed: HandFrame = {
      landmarks: Array.from({ length: HAND_LANDMARK_COUNT }, () => vec(0.5, 0.5, 0)),
      confidence: 0.95,
    };
    expect(bboxGrowthRate([], DT)).toBe(0);
    expect(bboxGrowthRate([hand], DT)).toBe(0);
    expect(bboxGrowthRate([hand, hand], 0)).toBe(0);
    expect(bboxGrowthRate([collapsed, collapsed], DT)).toBe(0);
    expect(bboxGrowthRate([hand, collapsed], DT)).toBe(0);
  });
});

describe('spanGrowthRate (legacy, kept for analysis)', () => {
  it('still reports sign and degenerate guards correctly', () => {
    const growing = [0.1, 0.12, 0.14].map((s) => handAt(vec(0.5, 0.5, 0), s));
    expect(spanGrowthRate(growing, DT)).toBeGreaterThan(0);
    expect(spanGrowthRate([], DT)).toBe(0);
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
    expect(th.elbowExtendVel).toBeCloseTo(3.6, 10); // 0.45 * 8 rad/s
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
      peakPunchBboxGrowth: 6,
      peakElbowVel: 12,
    };
    const th = thresholdsFrom(strong);
    expect(th.spikeSpeed).toBeCloseTo(JAB_TRIGGER_FRACTION * 4, 10);
    expect(th.spikeGrowth).toBeCloseTo(JAB_TRIGGER_FRACTION * 6, 10);
    expect(th.retractShrink).toBeCloseTo(RETRACT_FRACTION * 6, 10);
    expect(th.elbowExtendVel).toBeCloseTo(JAB_TRIGGER_FRACTION * 12, 10);
    expect(th.risingUpVel).toBeCloseTo(SWEEP_FRACTION * 4, 10);
    expect(th.whipSwingVx).toBeCloseTo(SWEEP_FRACTION * 4, 10);
    expect(th.whipStaticMax).toBeCloseTo(STATIC_FRACTION * 4, 10);
    expect(th.aimMinSpeed).toBeCloseTo(AIM_FRACTION * 4, 10);
  });

  it('a degenerate near-zero profile can never hair-trigger', () => {
    const broken: MotionProfile = {
      version: 2,
      peakPunchSpeed: 0.01,
      peakPunchBboxGrowth: 0.01,
      peakPalmSpeed: 0.01,
      peakPalmBboxGrowth: 0.01,
      peakElbowVel: 0.01,
      neutralElbowVel: 0,
      neutralSpeed: 0,
      neutralBboxGrowth: 0,
      capturedAt: 'broken',
    };
    const th = thresholdsFrom(broken);
    // Absolute safety floors hold the line.
    expect(th.spikeSpeed).toBeGreaterThanOrEqual(0.5);
    expect(th.spikeGrowth).toBeGreaterThanOrEqual(0.6);
    expect(th.retractShrink).toBeGreaterThanOrEqual(0.5);
    expect(th.elbowExtendVel).toBeGreaterThanOrEqual(FLOOR_ELBOW_VEL);
    expect(th.risingUpVel).toBeGreaterThanOrEqual(0.6);
    expect(th.whipSwingVx).toBeGreaterThanOrEqual(0.6);
    expect(th.aimMinSpeed).toBeGreaterThanOrEqual(0.5);
  });

  it('a twitchy neutral baseline raises thresholds via the 3x floor', () => {
    const twitchy: MotionProfile = {
      ...DEFAULT_PROFILE,
      neutralSpeed: 0.5,
      neutralBboxGrowth: 0.8,
      neutralElbowVel: 2,
    };
    const th = thresholdsFrom(twitchy);
    expect(th.spikeSpeed).toBeCloseTo(NEUTRAL_FLOOR_MULT * 0.5, 10);
    expect(th.spikeGrowth).toBeCloseTo(NEUTRAL_FLOOR_MULT * 0.8, 10);
    expect(th.elbowExtendVel).toBeCloseTo(NEUTRAL_FLOOR_MULT * 2, 10);
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

  it('round-trips a valid v2 profile', () => {
    stubStorage();
    const profile: MotionProfile = {
      version: 2,
      peakPunchSpeed: 2.4,
      peakPunchBboxGrowth: 3.6,
      peakPalmSpeed: 1.8,
      peakPalmBboxGrowth: 3.1,
      peakElbowVel: 9.5,
      neutralElbowVel: 0.4,
      neutralSpeed: 0.12,
      neutralBboxGrowth: 0.2,
      capturedAt: '2026-07-30T00:00:00.000Z',
    };
    saveProfile(profile);
    expect(loadProfile()).toEqual(profile);
    clearProfile();
    expect(loadProfile()).toBeNull();
  });

  it('round-trips the optional phase-engine reach seeds', () => {
    stubStorage();
    const profile: MotionProfile = {
      ...DEFAULT_PROFILE,
      capturedAt: '2026-07-31T00:00:00.000Z',
      maxReachLeftSw: 0.82,
      maxReachRightSw: 0.88,
    };
    saveProfile(profile);
    const loaded = loadProfile();
    expect(loaded).toEqual(profile);
    expect(loaded?.maxReachLeftSw).toBeCloseTo(0.82, 10);
    expect(loaded?.maxReachRightSw).toBeCloseTo(0.88, 10);
  });

  it('accepts a profile with only one reach seed (single-arm capture)', () => {
    stubStorage();
    const profile: MotionProfile = {
      ...DEFAULT_PROFILE,
      capturedAt: '2026-07-31T00:00:00.000Z',
      maxReachRightSw: 0.9,
    };
    saveProfile(profile);
    const loaded = loadProfile();
    expect(loaded?.maxReachLeftSw).toBeUndefined();
    expect(loaded?.maxReachRightSw).toBeCloseTo(0.9, 10);
  });

  it('stays backward compatible: profiles without reach seeds still load', () => {
    stubStorage();
    saveProfile({ ...DEFAULT_PROFILE, capturedAt: '2026-07-30T00:00:00.000Z' });
    const loaded = loadProfile();
    expect(loaded).not.toBeNull();
    expect(loaded?.maxReachLeftSw).toBeUndefined();
    expect(loaded?.maxReachRightSw).toBeUndefined();
  });

  it('rejects PRESENT but corrupt reach seeds (zero, negative, non-numeric)', () => {
    const map = stubStorage();
    const good = JSON.parse(JSON.stringify(DEFAULT_PROFILE)) as Record<string, unknown>;

    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, maxReachLeftSw: 0 }));
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, maxReachRightSw: -0.8 }));
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, maxReachLeftSw: 'long' }));
    expect(loadProfile()).toBeNull();

    // JSON cannot carry NaN/Infinity; they arrive as null and must reject.
    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, maxReachRightSw: null }));
    expect(loadProfile()).toBeNull();
  });

  it('rejects a stored v1 profile (forces one recalibration)', () => {
    const map = stubStorage();
    const v1 = {
      version: 1,
      peakPunchSpeed: 2.0,
      peakPunchGrowth: 3.0,
      peakPalmSpeed: 1.6,
      peakPalmGrowth: 3.0,
      neutralSpeed: 0.1,
      neutralGrowth: 0.15,
      capturedAt: '2026-07-01T00:00:00.000Z',
    };
    map.set(PROFILE_STORAGE_KEY, JSON.stringify(v1));
    expect(loadProfile()).toBeNull();
  });

  it('rejects wrong versions, NaN, non-finite, negative, and junk JSON', () => {
    const map = stubStorage();
    const good = JSON.parse(JSON.stringify(DEFAULT_PROFILE)) as Record<string, unknown>;

    map.set(PROFILE_STORAGE_KEY, 'not json {');
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, version: 3 }));
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, peakPunchSpeed: 'fast' }));
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, neutralSpeed: -1 }));
    expect(loadProfile()).toBeNull();

    // A v2 payload missing the elbow fields must reject.
    const noElbow = { ...good };
    delete noElbow['peakElbowVel'];
    map.set(PROFILE_STORAGE_KEY, JSON.stringify(noElbow));
    expect(loadProfile()).toBeNull();

    // JSON cannot carry NaN/Infinity; they arrive as null and must reject.
    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, peakPunchBboxGrowth: null }));
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify({ ...good, capturedAt: 7 }));
    expect(loadProfile()).toBeNull();

    map.set(PROFILE_STORAGE_KEY, JSON.stringify(good));
    expect(loadProfile()).not.toBeNull();
  });
});
