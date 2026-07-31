/**
 * Analyze-pipeline test (Round 3 Phase 4f; extended for AUTO-PEAK + the
 * 7-move set): synthesizes a fake studio export IN THE TEST from the
 * committed synthetic fixtures, piped through the REAL SignalTracker
 * (src/studio/signals.ts) and wrapped in the export schema with
 * meta.synthetic = true, then asserts the full tools/analyze.ts pipeline:
 * replay through a real MoveEngine under the current derived tuning, fired
 * counts inside rep windows, the AUTO-PEAK fallback for takes with zero
 * confirmed reps, a deliberate miss with blocker diagnosis, false-positive
 * detection on a negative take, the per-move summary, threshold proposals,
 * the palm 3D-vs-2D comparison on a static-palm take, and the loud
 * SYNTHETIC + AUTO-PEAK labeling of the generated report. No file is
 * written to docs/ by this test.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SignalTracker } from '../src/studio/signals';
import type { StudioExport, StudioFrame, StudioRep, StudioTakeExport, TakeId } from '../src/studio/exportSchema';
import type { LandmarkRecording } from '../src/tracking/types';
import { DEFAULT_PROFILE, thresholdsFrom } from '../src/gestures/profile';
import {
  analyzeExport,
  buildReport,
  effectiveReps,
  proposeSeparator,
  replayTake,
  summarize,
} from '../tools/analyze';

const SYNTHETIC_DIR = new URL('../fixtures/synthetic/', import.meta.url);

function loadFixture(label: string): LandmarkRecording {
  return JSON.parse(
    readFileSync(new URL(`${label}.json`, SYNTHETIC_DIR), 'utf8'),
  ) as LandmarkRecording;
}

/**
 * Build one take by running the fixture's frames through the real
 * SignalTracker, exactly as the studio does during capture.
 */
function makeTake(id: TakeId, fixtureLabel: string, reps: StudioRep[]): StudioTakeExport {
  const rec = loadFixture(fixtureLabel);
  const tracker = new SignalTracker();
  const frames: StudioFrame[] = rec.frames.map((f) => ({
    t: f.t,
    left: f.left,
    right: f.right,
    pose: f.pose ?? null,
    signals: tracker.update(f),
  }));
  const last = frames[frames.length - 1];
  if (!last) throw new Error(`empty fixture ${fixtureLabel}`);
  return {
    id,
    takeIndex: 1,
    starred: true,
    status: 'confirmed',
    fps: rec.fps,
    trimmedRange: [0, last.t],
    thresholds: thresholdsFrom(DEFAULT_PROFILE),
    frameClockOffset: 0,
    frames,
    reps,
    quality: [],
  };
}

function rep(startMs: number, endMs: number): StudioRep {
  return { startMs, endMs, confirmed: true, manual: false };
}

function makeExport(takes: StudioTakeExport[]): StudioExport {
  return {
    version: 1,
    exportedAt: '2026-07-30T00:00:00.000Z',
    meta: {
      cameraWidth: 640,
      cameraHeight: 480,
      distanceEstimate: 0.2,
      lightingNote: 'synthetic pipeline test',
      framingSummary: 'synthetic',
      motionProfile: null,
      synthetic: true,
    },
    takes,
  };
}

// The jab-right fixture fires exactly one right jab (tests/moves.test.ts);
// the thrust peaks near t=680 (tests/fixtures.test.ts). Rep 1 brackets it;
// rep 2 sits in the post-retract tail where nothing can fire: the
// DELIBERATE MISS.
const JAB_REPS = [rep(300, 1100), rep(1300, 1750)];

const buildAnalysis = () => {
  const takes = [
    makeTake('jab-right-x5', 'jab-right', JAB_REPS),
    // ZERO confirmed reps: this take must fall back to AUTO-PEAK windows
    // detected over its primary signal (abs-vx for the whip slot).
    makeTake('fire-whip-right-x3', 'fire-whip', []),
    // Static palm slot from the palm-wave fixture: gives the 3D-vs-2D palm
    // comparison real palm frames to chew on.
    makeTake('palm-static-5s', 'palm-wave', []),
    // DELIBERATE FALSE POSITIVE: a jab motion inside a negative slot.
    makeTake('neg-reaching-20s', 'jab-right', []),
    // Clean negative: talking-hands never fires (tests/moves.test.ts).
    makeTake('neg-idle-20s', 'talking-hands', []),
  ];
  const exp = makeExport(takes);
  return { exp, analysis: analyzeExport(exp, 'synthetic://pipeline-test') };
};

describe('drill analyze pipeline on a synthesized export', () => {
  const { exp, analysis } = buildAnalysis();

  it('flags the export as synthetic', () => {
    expect(analysis.synthetic).toBe(true);
  });

  it('replays a take through a real MoveEngine under current derived tuning', () => {
    const take = exp.takes[0];
    if (!take) throw new Error('missing take');
    const { events } = replayTake(take, thresholdsFrom(DEFAULT_PROFILE));
    const fired = events.filter((e) => e.kind === 'trigger');
    expect(fired).toHaveLength(1);
    const first = fired[0];
    expect(first?.move).toBe('jab-blast');
    expect(first?.hand).toBe('right');
  });

  it('counts fired events inside confirmed rep windows', () => {
    const jab = analysis.takes.find((t) => t.id === 'jab-right-x5');
    if (!jab) throw new Error('missing jab analysis');
    expect(jab.kind).toBe('positive');
    expect(jab.repsUsed).toBe(2);
    expect(jab.autoReps).toBe(false);
    expect(jab.totalFired).toBe(1);
    const hit = jab.reps[0];
    expect(hit?.fired).toBe(1);
    expect(hit?.miss).toBe(false);
    expect(hit?.auto).toBe(false);
  });

  it('AUTO-PEAK fallback: zero confirmed reps get machine-detected windows', () => {
    const take = exp.takes.find((t) => t.id === 'fire-whip-right-x3');
    if (!take) throw new Error('missing whip take');
    const windows = effectiveReps(take);
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      expect(w.auto).toBe(true);
      expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
    }

    const whip = analysis.takes.find((t) => t.id === 'fire-whip-right-x3');
    if (!whip) throw new Error('missing whip analysis');
    expect(whip.autoReps).toBe(true);
    expect(whip.repsUsed).toBe(windows.length);
    // The whip fixture fires exactly one fire-whip; the auto window around
    // the swing peak must contain it.
    expect(whip.totalFired).toBe(1);
    expect(whip.reps.reduce((s, r) => s + r.fired, 0)).toBe(1);
    expect(analysis.autoPeakUsed).toBe(true);
  });

  it('detects the deliberate miss and names the blocking signals', () => {
    const jab = analysis.takes.find((t) => t.id === 'jab-right-x5');
    const missRep = jab?.reps[1];
    if (!missRep) throw new Error('missing rep');
    expect(missRep.miss).toBe(true);
    expect(missRep.fired).toBe(0);
    // The tail window holds a near-static hand: at least the motion
    // secondaries must be reported as blockers, with positive deficits.
    expect(missRep.blockers.length).toBeGreaterThan(0);
    const signals = missRep.blockers.map((b) => b.signal);
    expect(signals).toContain('wristSpeed');
    for (const b of missRep.blockers) {
      expect(b.deficit).toBeGreaterThan(0);
      expect(b.max).toBeLessThan(b.threshold);
      expect(Number.isFinite(b.max)).toBe(true);
    }
  });

  it('reports every fire on a negative take as a false positive', () => {
    const neg = analysis.takes.find((t) => t.id === 'neg-reaching-20s');
    if (!neg) throw new Error('missing negative analysis');
    expect(neg.kind).toBe('negative');
    expect(neg.falsePositives).toHaveLength(1);
    const fp = neg.falsePositives[0];
    expect(fp?.move).toBe('jab-blast');
    expect(Number.isFinite(fp?.t)).toBe(true);
    // Triggering signal values are attached from the exported frame signals.
    expect(fp?.signals.wristSpeed).toBeGreaterThan(0);
    expect(Number.isFinite(fp?.signals.fist ?? NaN)).toBe(true);
  });

  it('keeps a clean negative clean', () => {
    const idle = analysis.takes.find((t) => t.id === 'neg-idle-20s');
    expect(idle?.falsePositives).toHaveLength(0);
  });

  it('builds the per-move summary with hit rates and out-of-rep FPs', () => {
    const jabRow = analysis.moveSummary.find((r) => r.move === 'jab-blast');
    if (!jabRow) throw new Error('missing jab-blast summary row');
    expect(jabRow.takes).toContain('jab-right-x5#1');
    expect(jabRow.reps).toBe(2);
    expect(jabRow.firedInRep).toBe(1);
    expect(jabRow.hitRate).toBeCloseTo(0.5, 10);
    // The deliberate FP on the negative take counts against jab-blast.
    expect(jabRow.fpOutOfRep).toBeGreaterThanOrEqual(1);

    const whipRow = analysis.moveSummary.find((r) => r.move === 'fire-whip');
    if (!whipRow) throw new Error('missing fire-whip summary row');
    expect(whipRow.autoReps).toBe(whipRow.reps);
    expect(whipRow.firedInRep).toBe(1);
  });

  it('maps every fired move per take (take-to-move table data)', () => {
    const neg = analysis.takes.find((t) => t.id === 'neg-reaching-20s');
    const jabCount = neg?.firedByMove.find((f) => f.move === 'jab-blast');
    expect(jabCount?.total).toBe(1);
    expect(jabCount?.outOfRep).toBe(1); // negatives have no rep windows
  });

  it('computes signal-to-noise rows for positive takes', () => {
    const jab = analysis.takes.find((t) => t.id === 'jab-right-x5');
    if (!jab) throw new Error('missing jab analysis');
    expect(jab.snr.length).toBeGreaterThan(0);
    const speed = jab.snr.find((r) => r.signal === 'wristSpeed');
    if (!speed) throw new Error('missing wristSpeed snr');
    expect(speed.peakMedian).toBeGreaterThan(0);
    expect(Number.isFinite(speed.noiseP95)).toBe(true);
  });

  it('scores the static-palm take with BOTH palm scorers', () => {
    const palm = analysis.takes.find((t) => t.id === 'palm-static-5s');
    const c = palm?.palmCompare;
    if (!c) throw new Error('missing palm comparison');
    expect(c.frames).toBeGreaterThan(0);
    // The palm-wave fixture holds a clear open palm: both scorers must see
    // frames above the 0.75 enter level.
    expect(c.score3D.above75).toBeGreaterThan(0);
    expect(c.score2D.above75).toBeGreaterThan(0);
  });

  it('uses the negative takes as the noise pool when they exist', () => {
    expect(analysis.noiseProvenance).toContain('negative takes');
    expect(analysis.noiseProvenance).not.toContain('ABSENT');
  });

  it('emits threshold proposals with honest separation reporting', () => {
    expect(analysis.proposals.length).toBeGreaterThan(0);
    const spike = analysis.proposals.find((p) => p.name === 'spikeSpeed');
    if (!spike) throw new Error('missing spikeSpeed proposal');
    expect(spike.repPeaks).toHaveLength(2); // one per confirmed jab rep
    expect(Number.isFinite(spike.noiseMax)).toBe(true);
    // The deliberate-FP negative contains a full jab, so its noise ceiling
    // reaches the rep peak: the proposal must NOT invent a separator, and
    // must count the reps that would miss instead of hiding them.
    if (spike.threshold === null) {
      expect(spike.missingReps).toBe(spike.repPeaks.length);
    } else {
      expect(spike.margin).toBeGreaterThanOrEqual(0);
      expect(spike.fraction?.constant).toBe('JAB_TRIGGER_FRACTION');
    }
  });

  it('max-margin separator math: clean split, midpoint and margin', () => {
    const sep = proposeSeparator([1.6, 1.8, 2.0], [0.4, 0.9, 1.0]);
    expect(sep.noiseMax).toBe(1.0);
    expect(sep.threshold).toBeCloseTo(1.3, 10);
    expect(sep.margin).toBeCloseTo(0.3, 10);
    expect(sep.missingReps).toBe(0);
    // A rep peak buried under the noise stays reported as missing.
    const partial = proposeSeparator([0.8, 1.6], [0.4, 1.0]);
    expect(partial.threshold).toBeCloseTo(1.3, 10);
    expect(partial.missingReps).toBe(1);
    // No separation at all.
    const none = proposeSeparator([0.5, 0.6], [0.7]);
    expect(none.threshold).toBeNull();
    expect(none.missingReps).toBe(2);
  });

  it('labels a synthetic report loudly and includes every section', () => {
    const report = buildReport(analysis);
    expect(report).toContain('[SYNTHETIC DATA]');
    expect(report).toContain('SYNTHETIC INPUT - NOT REAL PLAYER DATA');
    expect(report).toContain('AUTO-PEAK REP WINDOWS IN USE');
    expect(report).toContain('## Takes: reps vs fired (7-move set)');
    expect(report).toContain('## Which moves fired in which takes');
    expect(report).toContain('## Per-move summary: reps, hit rate, false positives');
    expect(report).toContain('## Missed reps: what blocked them');
    expect(report).toContain('## False positives on negative / static takes');
    expect(report).toContain('## Signal-to-noise per move');
    expect(report).toContain('palmScore2D (live)');
    expect(report).toContain('## Threshold proposals (max-margin separators)');
    expect(report).toContain('PROPOSALS ARE NOT APPLIED AUTOMATICALLY');
    expect(report).toContain('THIS RUN WAS SYNTHETIC');

    const summary = summarize(analysis);
    expect(summary).toContain('SYNTHETIC INPUT');
    expect(summary).toContain('AUTO-PEAK');
    expect(summary).toContain('NOT auto-applied');
  });
});

// ---------------------------------------------------------------------------
// Capture-rate hard gate (Phase 1): fps stamping and the LOW FPS banner
// ---------------------------------------------------------------------------

describe('capture-rate hard gate in analyze', () => {
  it('stamps each take with its measured fps; 30 fps takes pass clean', () => {
    const { analysis } = buildAnalysis();
    for (const t of analysis.takes) {
      expect(t.fps).toBe(30);
      expect(t.lowFps).toBe(false);
    }
    expect(analysis.lowFpsTakes).toEqual([]);
    // Fixture-built exports predate captureHealth: absence must be null,
    // never treated as healthy-by-default.
    expect(analysis.captureHealth).toBeNull();
    const report = buildReport(analysis);
    expect(report).toContain('capture fps');
    expect(report).not.toContain('CAPTURE RATE UNDER 30 FPS');
    expect(summarize(analysis)).not.toContain('CAPTURE RATE HARD GATE');
  });

  it('names low-fps takes in a top banner and keeps analyzing them', () => {
    const takes = [
      makeTake('jab-right-x5', 'jab-right', JAB_REPS),
      makeTake('fire-whip-right-x3', 'fire-whip', []),
    ];
    // Simulate a ~14 fps capture on the jab take (the real failure mode
    // that motivated the gate) with per-take instantaneous stats.
    const jab = takes[0];
    if (!jab) throw new Error('missing take');
    jab.fps = 14.2;
    jab.fpsMean = 14.5;
    jab.fpsMin = 9.8;
    const exp = makeExport(takes);
    const analysis = analyzeExport(exp, 'synthetic://lowfps-test');

    const jabA = analysis.takes.find((t) => t.id === 'jab-right-x5');
    expect(jabA?.lowFps).toBe(true);
    expect(jabA?.fpsMin).toBeCloseTo(9.8, 9);
    const whipA = analysis.takes.find((t) => t.id === 'fire-whip-right-x3');
    expect(whipA?.lowFps).toBe(false);
    expect(analysis.lowFpsTakes).toEqual(['jab-right-x5#1']);

    // Analysis still runs on the low take: numbers print, banner names it.
    expect(jabA?.reps.length).toBe(2);

    const report = buildReport(analysis);
    const bannerAt = report.indexOf('CAPTURE RATE UNDER 30 FPS - PHASE 1 HARD GATE');
    expect(bannerAt).toBeGreaterThan(-1);
    // Prominent: the banner sits above every section of the report.
    expect(bannerAt).toBeLessThan(report.indexOf('## Takes'));
    expect(report).toContain('jab-right-x5#1: 14.2 fps (min 9.8)');
    expect(report).toContain('INVALID for tuning');
    expect(report).toContain('**LOW FPS**');

    const summary = summarize(analysis);
    expect(summary).toContain('CAPTURE RATE HARD GATE');
    expect(summary).toContain('jab-right-x5#1');
  });

  it('reports the export captureHealth line when present', () => {
    const takes = [makeTake('jab-right-x5', 'jab-right', JAB_REPS)];
    const exp = makeExport(takes);
    exp.captureHealth = { minFps: 30, medianFps: 30, takesUnderGate: 0 };
    const analysis = analyzeExport(exp, 'synthetic://health-test');
    expect(analysis.captureHealth).toEqual({
      minFps: 30,
      medianFps: 30,
      takesUnderGate: 0,
    });
    expect(buildReport(analysis)).toContain('Capture health: min 30.0 fps');
  });
});
