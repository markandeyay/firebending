/**
 * Body-zone classification (src/gestures/zones.ts). Boundaries are in
 * shoulder-width units around the body frame; the hip line used here is the
 * standard synthetic body's (hips 0.37 screen units below the shoulder line
 * at a 0.32 shoulder width: hipY ~1.156).
 */

import { describe, expect, it } from 'vitest';
import {
  CHEST_HALF_WIDTH,
  HIP_ZONE_MARGIN,
  LATERAL_INNER_MIN,
  LATERAL_OUTER_MIN,
  isAboveShoulder,
  isChest,
  isHip,
  lateralBandOf,
  zoneOf,
} from '../src/gestures/zones';

const HIP_Y = 1.15625;

describe('zoneOf', () => {
  it('classifies the canonical positions', () => {
    expect(zoneOf({ x: 0, y: -0.1 }, HIP_Y)).toBe('ABOVE_SHOULDER');
    expect(zoneOf({ x: -0.3, y: 0.5 }, HIP_Y)).toBe('CHEST');
    expect(zoneOf({ x: 0, y: 1.1 }, HIP_Y)).toBe('HIP');
    expect(zoneOf({ x: 1.0, y: 0.5 }, HIP_Y)).toBe('LATERAL_INNER');
    expect(zoneOf({ x: -1.0, y: 0.5 }, HIP_Y)).toBe('LATERAL_INNER');
    expect(zoneOf({ x: 1.5, y: 0.5 }, HIP_Y)).toBe('LATERAL_OUTER');
    expect(zoneOf({ x: -1.5, y: 0.5 }, HIP_Y)).toBe('LATERAL_OUTER');
  });

  it('height wins over laterality (documented priority)', () => {
    expect(zoneOf({ x: 1.5, y: -0.2 }, HIP_Y)).toBe('ABOVE_SHOULDER');
    expect(zoneOf({ x: 1.5, y: 1.2 }, HIP_Y)).toBe('HIP');
  });

  it('respects the hip margin: slightly above the hip line is still HIP', () => {
    const justAbove = HIP_Y - HIP_ZONE_MARGIN + 0.01;
    const wellAbove = HIP_Y - HIP_ZONE_MARGIN - 0.01;
    expect(zoneOf({ x: 0, y: justAbove }, HIP_Y)).toBe('HIP');
    expect(zoneOf({ x: 0, y: wellAbove }, HIP_Y)).toBe('CHEST');
  });
});

describe('predicates', () => {
  it('isAboveShoulder / isHip / isChest agree with zoneOf on their bands', () => {
    expect(isAboveShoulder({ x: 0, y: -0.01 })).toBe(true);
    expect(isAboveShoulder({ x: 0, y: 0.01 })).toBe(false);
    expect(isHip({ x: 0, y: HIP_Y }, HIP_Y)).toBe(true);
    expect(isHip({ x: 0, y: 0.5 }, HIP_Y)).toBe(false);
    expect(isChest({ x: 0.5, y: 0.5 }, HIP_Y)).toBe(true);
    expect(isChest({ x: CHEST_HALF_WIDTH + 0.01, y: 0.5 }, HIP_Y)).toBe(false);
  });
});

describe('lateralBandOf', () => {
  it('is side-relative: outward is positive for the arm side', () => {
    expect(lateralBandOf({ x: 0.9, y: 0.3 }, 'right')).toBe('inner');
    expect(lateralBandOf({ x: -0.9, y: 0.3 }, 'left')).toBe('inner');
    // The wrong side's lateral space is "center" for this arm: a right arm
    // crossing the body midline is not swinging outward.
    expect(lateralBandOf({ x: -0.9, y: 0.3 }, 'right')).toBe('center');
    expect(lateralBandOf({ x: 1.4, y: 0.3 }, 'right')).toBe('outer');
    expect(lateralBandOf({ x: -1.4, y: 0.3 }, 'left')).toBe('outer');
  });

  it('band edges sit at the exported constants', () => {
    expect(lateralBandOf({ x: LATERAL_INNER_MIN + 1e-6, y: 0 }, 'right')).toBe('inner');
    expect(lateralBandOf({ x: LATERAL_INNER_MIN - 1e-6, y: 0 }, 'right')).toBe('center');
    expect(lateralBandOf({ x: LATERAL_OUTER_MIN + 1e-6, y: 0 }, 'right')).toBe('outer');
    expect(lateralBandOf({ x: LATERAL_OUTER_MIN - 1e-6, y: 0 }, 'right')).toBe('inner');
  });
});
