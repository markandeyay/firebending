/**
 * Moves debug scene pure helpers (Phase 2 exit criterion support). Node only,
 * no DOM: the module must import cleanly headless because all DOM access
 * lives inside mountMovesDebug.
 */

import { describe, expect, it } from 'vitest';
import {
  formatEventLine,
  nextFixture,
  LatencyStats,
  POSITIVE_FIXTURES,
} from '../src/screens/movesDebug';
import type { MoveEvent } from '../src/gestures/moves';

function event(overrides: Partial<MoveEvent> = {}): MoveEvent {
  return {
    move: 'jab-blast',
    hand: 'right',
    t: 1234.4,
    aim: { x: 0, y: 0, z: -1 },
    origin: { x: 0.6, y: 0.5, z: 0 },
    empowered: false,
    kind: 'trigger',
    triggerLatencyMs: 16.7,
    ...overrides,
  };
}

describe('formatEventLine', () => {
  it('contains timestamp, move name, hand, kind, and latency', () => {
    const line = formatEventLine(event());
    expect(line).toContain('[1234ms]');
    expect(line).toContain('jab-blast');
    expect(line).toContain('right');
    expect(line).toContain('trigger');
    expect(line).toContain('latency:17ms');
  });

  it('marks empowered events and omits the mark otherwise', () => {
    expect(formatEventLine(event({ empowered: true }))).toContain('EMPOWERED');
    expect(formatEventLine(event())).not.toContain('EMPOWERED');
  });

  it('formats sustain and two-hand events', () => {
    const line = formatEventLine(
      event({ move: 'twin-cannon', hand: 'both', kind: 'sustain-start', triggerLatencyMs: 0 })
    );
    expect(line).toContain('twin-cannon');
    expect(line).toContain('both');
    expect(line).toContain('sustain-start');
    expect(line).toContain('latency:0ms');
  });

  it('never contains em dashes', () => {
    const lines = [
      formatEventLine(event()),
      formatEventLine(event({ empowered: true, move: 'fire-whip', hand: 'left' })),
      formatEventLine(event({ kind: 'sustain-end', triggerLatencyMs: 0 })),
    ];
    for (const line of lines) {
      expect(line).not.toContain('—');
    }
  });
});

describe('LatencyStats', () => {
  it('starts empty', () => {
    expect(new LatencyStats().summary()).toEqual([]);
  });

  it('computes count, mean, and max per move on known inputs', () => {
    const stats = new LatencyStats();
    stats.add('jab-blast', 10);
    stats.add('jab-blast', 20);
    stats.add('jab-blast', 30);
    stats.add('fire-whip', 5);
    const summary = stats.summary();
    expect(summary).toHaveLength(2);
    const jab = summary.find((s) => s.move === 'jab-blast');
    const whip = summary.find((s) => s.move === 'fire-whip');
    expect(jab).toEqual({ move: 'jab-blast', count: 3, meanMs: 20, maxMs: 30 });
    expect(whip).toEqual({ move: 'fire-whip', count: 1, meanMs: 5, maxMs: 5 });
  });

  it('sorts the summary by move name for stable display', () => {
    const stats = new LatencyStats();
    stats.add('twin-cannon', 1);
    stats.add('breath-charge', 2);
    stats.add('fire-whip', 3);
    expect(stats.summary().map((s) => s.move)).toEqual([
      'breath-charge',
      'fire-whip',
      'twin-cannon',
    ]);
  });

  it('handles zero latencies without inventing a mean', () => {
    const stats = new LatencyStats();
    stats.add('rising-flame', 0);
    stats.add('rising-flame', 0);
    const row = stats.summary()[0];
    expect(row).toEqual({ move: 'rising-flame', count: 2, meanMs: 0, maxMs: 0 });
  });
});

describe('nextFixture', () => {
  it('cycles through all 10 positive fixtures exactly once before wrapping', () => {
    expect(POSITIVE_FIXTURES).toHaveLength(10);
    const first = POSITIVE_FIXTURES[0];
    if (first === undefined) throw new Error('no fixtures');
    const seen: string[] = [];
    let cur = first;
    for (let i = 0; i < POSITIVE_FIXTURES.length; i++) {
      seen.push(cur);
      cur = nextFixture(cur);
    }
    expect(seen).toEqual([...POSITIVE_FIXTURES]);
    expect(cur).toBe(first); // wrapped
  });

  it('wraps from the last fixture to the first', () => {
    const last = POSITIVE_FIXTURES[POSITIVE_FIXTURES.length - 1];
    if (last === undefined) throw new Error('no fixtures');
    expect(nextFixture(last)).toBe(POSITIVE_FIXTURES[0]);
  });

  it('restarts the cycle on an unknown fixture name', () => {
    expect(nextFixture('idle-rest')).toBe(POSITIVE_FIXTURES[0]);
    expect(nextFixture('')).toBe(POSITIVE_FIXTURES[0]);
  });
});

describe('node safety', () => {
  it('is importable in node without touching the DOM', () => {
    // If module evaluation had touched document/window, the imports at the
    // top of this file would already have thrown in the node environment.
    expect(typeof document).toBe('undefined');
  });
});
