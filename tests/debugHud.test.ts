/**
 * Debug HUD pure helpers. Node only, no DOM: DebugHud's class touches the
 * document, but formatNearMiss and the module import path must stay headless
 * (the arena screen imports this module in every environment).
 */

import { describe, expect, it } from 'vitest';
import { formatNearMiss, REFRESH_HZ } from '../src/ui/debugHud';
import type { NearMissRecord } from '../src/gestures/moves';

function rec(overrides: Partial<NearMissRecord> = {}): NearMissRecord {
  return {
    t: 1200,
    move: 'jab-blast',
    condition: 'speed',
    value: 0.42,
    threshold: 0.61,
    ...overrides,
  };
}

describe('formatNearMiss', () => {
  it('renders the exact condition/value/threshold line', () => {
    expect(formatNearMiss(rec())).toBe('JAB: speed 0.42 vs threshold 0.61 FAIL');
  });

  it('uses two decimals and the short move names', () => {
    expect(
      formatNearMiss(rec({ move: 'palm-wave', condition: 'growth', value: 1.2345, threshold: 1.35 })),
    ).toBe('PALM: growth 1.23 vs threshold 1.35 FAIL');
    expect(
      formatNearMiss(rec({ move: 'rising-flame', condition: 'upVel', value: 0.5, threshold: 1 })),
    ).toBe('RISING: upVel 0.50 vs threshold 1.00 FAIL');
    expect(
      formatNearMiss(rec({ move: 'fire-whip', condition: 'swingVx', value: 0.9, threshold: 1 })),
    ).toBe('WHIP: swingVx 0.90 vs threshold 1.00 FAIL');
  });

  it('names the failing fusion primary by signal', () => {
    expect(
      formatNearMiss(rec({ condition: 'elbowVel', value: 2.1, threshold: 3.6 })),
    ).toBe('JAB: elbowVel 2.10 vs threshold 3.60 FAIL');
  });

  it('renders the two-pair no-secondary line', () => {
    expect(
      formatNearMiss(
        rec({
          condition: 'secondary',
          value: 0.51,
          threshold: 0.9,
          value2: 0.4,
          threshold2: 1.35,
        }),
      ),
    ).toBe('JAB: no secondary: speed 0.51/0.90, growth 0.40/1.35');
  });

  it('never contains em dashes', () => {
    expect(formatNearMiss(rec())).not.toContain('—');
    expect(
      formatNearMiss(rec({ condition: 'secondary', value2: 1, threshold2: 2 })),
    ).not.toContain('—');
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
