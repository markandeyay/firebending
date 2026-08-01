/**
 * FRAMERATE-INDEPENDENCE INVARIANT for the phase engine, pinned to the
 * user's REAL recorded drill (fixtures/recorded/firebending-drill-
 * 2026-07-31.json, ~14 fps capture with real pose samples at ~3.8 Hz).
 * The whole point of the position-state-machine rebuild is that the same
 * recorded trajectory resampled to 10, 14, 20 or 30 fps (tools/resample.ts:
 * decimation down, positional interpolation up) fires the same events;
 * these tests encode that permanently, so any future threshold or engine
 * change that reintroduces a rate dependence fails CI instead of failing
 * on the player's machine.
 *
 * The invariant is on EVENT COUNTS per take, not on rep-window hit
 * bookkeeping: the drill's AUTO-PEAK windows come from hand-speed bursts
 * and carry their own skew (see docs/phase-eval-report.md), while the
 * event count is the pure detector output. The negative take must stay
 * silent at every rate.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StudioExport, StudioTakeExport, TakeId } from '../src/studio/exportSchema';
import type { MoveName } from '../src/gestures/moves';
import { landmarkFramesOf, replayPhaseFrames, STRESS_RATES } from '../tools/phaseEval';
import { resampleFrames } from '../tools/resample';

const DRILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'recorded',
  'firebending-drill-2026-07-31.json',
);

const drill = JSON.parse(readFileSync(DRILL_PATH, 'utf8')) as StudioExport;

function takeOf(id: TakeId): StudioTakeExport {
  const take = drill.takes.find((t) => t.id === id);
  if (take === undefined) throw new Error(`take ${id} missing from drill export`);
  return take;
}

/** Trigger / sustain-start counts of one move per stress rate. */
function firesPerRate(id: TakeId, move: MoveName): number[] {
  const frames = landmarkFramesOf(takeOf(id));
  return STRESS_RATES.map((rate) => {
    const events = replayPhaseFrames(resampleFrames(frames, rate), drill.meta.motionProfile).events;
    return events.filter(
      (e) => e.move === move && (e.kind === 'trigger' || e.kind === 'sustain-start'),
    ).length;
  });
}

/** ALL fires (any move) per stress rate, for the negative take. */
function allFiresPerRate(id: TakeId): number[] {
  const frames = landmarkFramesOf(takeOf(id));
  return STRESS_RATES.map((rate) => {
    const events = replayPhaseFrames(resampleFrames(frames, rate), drill.meta.motionProfile).events;
    return events.filter((e) => e.kind === 'trigger' || e.kind === 'sustain-start').length;
  });
}

describe('framerate stress: phase engine on the real 14 fps drill', () => {
  it('replays the real export (sanity)', () => {
    expect(drill.version).toBe(1);
    expect(drill.takes.length).toBeGreaterThan(0);
    expect(STRESS_RATES).toEqual([10, 14, 20, 30]);
  });

  it('jab-left-x5: identical jab count at 10/14/20/30 fps, and detects jabs', () => {
    const counts = firesPerRate('jab-left-x5', 'jab-blast');
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeGreaterThan(0);
  });

  it('jab-right-x5: identical jab count at 10/14/20/30 fps, and detects jabs', () => {
    const counts = firesPerRate('jab-right-x5', 'jab-blast');
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeGreaterThan(0);
  });

  it('twin-cannon-x3: identical twin count across rates, and detects twins', () => {
    const counts = firesPerRate('twin-cannon-x3', 'twin-cannon');
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeGreaterThan(0);
  });

  it('rising-flame-x3: identical rising count across rates, and detects sweeps', () => {
    const counts = firesPerRate('rising-flame-x3', 'rising-flame');
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeGreaterThan(0);
  });

  it('breath-charge-x3: identical charge count across rates, and detects charges', () => {
    const counts = firesPerRate('breath-charge-x3', 'breath-charge');
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeGreaterThan(0);
  });

  it('fire-whip-right-x3: identical whip count across rates, and detects whips', () => {
    const counts = firesPerRate('fire-whip-right-x3', 'fire-whip');
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeGreaterThan(0);
  });

  it('palm-static-5s (negative): zero fires of any move at every rate', () => {
    expect(allFiresPerRate('palm-static-5s')).toEqual([0, 0, 0, 0]);
  });
});
