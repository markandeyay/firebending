/**
 * Debug HUD pure helpers (phase-engine rebuild). Node only, no DOM: the
 * DebugHud class touches the document, but the formatting helpers and the
 * module import path must stay headless (the arena screen imports this
 * module in every environment).
 */

import { describe, expect, it } from 'vitest';
import {
  EXT_BAR_CELLS,
  EXT_BAR_FULL,
  REFRESH_HZ,
  aimAnglesDeg,
  extensionBar,
  formatArmDebug,
  formatInputLine,
  INPUT_STALE_AFTER_MS,
  signedFixed,
} from '../src/ui/debugHud';
import type { ArmDebugState } from '../src/gestures/phaseEngine';

function arm(overrides: Partial<ArmDebugState> = {}): ArmDebugState {
  return {
    state: 'RETRACTED',
    extension: 0.28,
    zone: 'CHEST',
    paused: false,
    lastTransition: null,
    ...overrides,
  };
}

describe('extensionBar', () => {
  it('renders an empty, partial, and saturated bar', () => {
    expect(extensionBar(0)).toBe('[--------]');
    expect(extensionBar(EXT_BAR_FULL)).toBe('[########]');
    expect(extensionBar(EXT_BAR_FULL / 2)).toBe('[####----]');
  });

  it('clamps out-of-range and junk extensions instead of exploding', () => {
    expect(extensionBar(9)).toBe('[########]');
    expect(extensionBar(-1)).toBe('[--------]');
    expect(extensionBar(Number.NaN)).toBe('[--------]');
  });

  it('always has the same width (stable HUD columns)', () => {
    for (const ext of [0, 0.3, 0.71, 1.0, 2.2]) {
      expect(extensionBar(ext)).toHaveLength(EXT_BAR_CELLS + 2);
    }
  });
});

describe('signedFixed', () => {
  it('signs both directions at the requested precision', () => {
    expect(signedFixed(12.44, 1)).toBe('+12.4');
    expect(signedFixed(-3.06, 1)).toBe('-3.1');
    expect(signedFixed(0, 1)).toBe('+0.0');
  });
});

describe('aimAnglesDeg', () => {
  it('reads dead ahead as (0, 0)', () => {
    const a = aimAnglesDeg({ x: 0, y: 0, z: -1 });
    expect(a.yawDeg).toBeCloseTo(0, 10);
    expect(a.pitchDeg).toBeCloseTo(0, 10);
  });

  it('yaw is positive to the player\'s right, pitch positive up', () => {
    // Screen space: x right, y DOWN, z negative toward the enemy.
    const right = aimAnglesDeg({ x: 0.5, y: 0, z: -0.866 });
    expect(right.yawDeg).toBeCloseTo(30, 2);
    expect(right.pitchDeg).toBeCloseTo(0, 10);
    const up = aimAnglesDeg({ x: 0, y: -0.5, z: -0.866 });
    expect(up.yawDeg).toBeCloseTo(0, 10);
    expect(up.pitchDeg).toBeCloseTo(30, 2);
    const downLeft = aimAnglesDeg({ x: -0.5, y: 0.5, z: -0.707 });
    expect(downLeft.yawDeg).toBeLessThan(0);
    expect(downLeft.pitchDeg).toBeLessThan(0);
  });
});

describe('formatArmDebug', () => {
  it('renders the exact state line with a padded state token', () => {
    const [line1, line2] = formatArmDebug(
      'L',
      arm({ state: 'EXTENDED', extension: 0.94, zone: 'CHEST' }),
    );
    expect(line1).toBe('L EXTENDED  ext 0.94 [######--] zone CHEST');
    expect(line2).toBe('  -');
  });

  it('keeps the ext column aligned across all three states', () => {
    const col = (state: ArmDebugState['state']): number =>
      formatArmDebug('R', arm({ state })).at(0)?.indexOf('ext') ?? -1;
    expect(col('RETRACTED')).toBe(col('EXTENDING'));
    expect(col('EXTENDING')).toBe(col('EXTENDED'));
  });

  it('flags a paused (confidence-frozen) machine', () => {
    const [line1] = formatArmDebug('R', arm({ paused: true, zone: 'HIP' }));
    expect(line1.endsWith('zone HIP PAUSED')).toBe(true);
  });

  it('renders the last transition with its timing', () => {
    const [, line2] = formatArmDebug(
      'R',
      arm({
        state: 'EXTENDED',
        lastTransition: { from: 'EXTENDING', to: 'EXTENDED', atT: 1200, tookMs: 180 },
      }),
    );
    expect(line2).toBe('  EXTENDING>EXTENDED 180ms');
  });

  it('rounds fractional transition timings to whole milliseconds', () => {
    const [, line2] = formatArmDebug(
      'L',
      arm({
        lastTransition: { from: 'EXTENDED', to: 'RETRACTED', atT: 1500, tookMs: 66.6667 },
      }),
    );
    expect(line2).toBe('  EXTENDED>RETRACTED 67ms');
  });

  it('never contains em dashes', () => {
    const lines = [
      ...formatArmDebug('L', arm({ paused: true })),
      ...formatArmDebug('R', arm({ zone: 'NONE' })),
    ];
    for (const line of lines) expect(line).not.toContain('—');
  });

  it('suppresses the duration on zero-duration entry edges', () => {
    const [, line2] = formatArmDebug(
      'L',
      arm({
        lastTransition: { from: 'RETRACTED', to: 'EXTENDING', atT: 900, tookMs: 0 },
      }),
    );
    expect(line2).toBe('  RETRACTED>EXTENDING');
  });
});

describe('formatInputLine', () => {
  it('reads live while frames are fresh', () => {
    expect(formatInputLine(true, 0)).toBe('input  live');
    expect(formatInputLine(true, INPUT_STALE_AFTER_MS - 1)).toBe('input  live');
  });

  it('reads STALE with the age once frames stop', () => {
    expect(formatInputLine(true, INPUT_STALE_AFTER_MS)).toBe('input  STALE 0.6s');
    expect(formatInputLine(true, 12_340)).toBe('input  STALE 12.3s');
  });

  it('renders the before-any-frames placeholder', () => {
    expect(formatInputLine(false, Infinity)).toBe('input  - (no frames yet)');
  });
});

describe('refresh budget', () => {
  it('caps the HUD text updates at ~10 Hz', () => {
    expect(REFRESH_HZ).toBeLessThanOrEqual(10);
  });
});

describe('node safety', () => {
  it('is importable in node without touching the DOM', () => {
    expect(typeof document).toBe('undefined');
  });
});
