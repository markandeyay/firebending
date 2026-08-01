/**
 * Phase-engine evaluation harness (position-state-machine rebuild,
 * 2026-07-31): proves the rebuilt PhaseMoveEngine on the user's REAL ~14 fps
 * drill recording, head to head against the legacy velocity MoveEngine, and
 * stress-tests framerate independence by resampling the same takes to 10,
 * 14, 20 and 30 fps (tools/resample.ts).
 *
 * Run: npx tsx tools/phaseEval.ts [path-to-export.json]
 *
 * Same discipline as tools/analyze.ts (whose exports this file REUSES:
 * EXPECTATIONS, effectiveReps, replayTake, REP_SLACK_MS):
 * - rep windows are effectiveReps (confirmed markers, or AUTO-PEAK when the
 *   markers were never clicked; this recording has zero confirmed markers,
 *   so every window is AUTO-PEAK and labeled so);
 * - a HIT is the expected move firing inside a rep window widened by
 *   REP_SLACK_MS on both ends (at most one hit counted per window);
 * - a FALSE POSITIVE is any fire outside every window of a positive take,
 *   or any fire at all on a negative / static take;
 * - BASELINE replays run the legacy MoveEngine under each take's exported
 *   capture-time thresholds (replayTake); PHASE replays construct a
 *   PhaseMoveEngine with the export's stored motionProfile (this export
 *   carries none, so the engine runs on its anatomical defaults).
 *
 * Rep windows are computed ONCE from the native take and reused at every
 * resampled rate: the ground truth of when the player moved does not change
 * with the sampling of the observation.
 *
 * For every native-rate miss the harness prints the extension / phase /
 * zone trajectory of the relevant arm around the window (the phase engine's
 * own debugState, polled per frame), so a miss is a diagnosis, not a shrug.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MoveEngine } from '../src/gestures/moves';
import type { MoveEvent, MoveName } from '../src/gestures/moves';
import type { MotionProfile, MotionThresholds } from '../src/gestures/profile';
import { PhaseMoveEngine } from '../src/gestures/phaseEngine';
import type { ArmPhase } from '../src/gestures/extension';
import type { ZoneName } from '../src/gestures/zones';
import type { LandmarkFrame } from '../src/tracking/types';
import {
  ALL_MOVES,
  EXPECTATIONS,
  REP_SLACK_MS,
  effectiveReps,
  newestExportPath,
  relevantHands,
  replayTake,
} from './analyze';
import type { RepWindow } from './analyze';
import type { StudioExport, StudioTakeExport } from '../src/studio/exportSchema';
import { resampleFrames } from './resample';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The framerate stress ladder, frames per second. 14 is the user's native
 *  capture rate; 10 is the sparsity gate; 20 and 30 are healthier cameras. */
export const STRESS_RATES: readonly number[] = [10, 14, 20, 30];

// ---------------------------------------------------------------------------
// Replay plumbing
// ---------------------------------------------------------------------------

/** A take's frames as engine-ready LandmarkFrames (same construction as
 *  analyze.ts replayTake: face is never recorded, pose passes verbatim). */
export function landmarkFramesOf(take: StudioTakeExport): LandmarkFrame[] {
  return take.frames.map((f) => ({
    t: f.t,
    left: f.left,
    right: f.right,
    face: null,
    pose: f.pose,
  }));
}

/** One row of the per-frame phase-engine trace (miss diagnostics). */
export interface TraceRow {
  t: number;
  leftExt: number;
  leftPhase: ArmPhase;
  leftZone: ZoneName | 'NONE';
  rightExt: number;
  rightPhase: ArmPhase;
  rightZone: ZoneName | 'NONE';
}

export interface PhaseReplayResult {
  events: MoveEvent[];
  trace: TraceRow[];
}

/**
 * Replay frames through a fresh PhaseMoveEngine built the way arena builds
 * one: with the export's stored motion profile when present. The per-frame
 * debugState poll feeds the miss-diagnosis traces.
 */
export function replayPhaseFrames(
  frames: LandmarkFrame[],
  profile: MotionProfile | null,
  withTrace = false,
): PhaseReplayResult {
  const engine = new PhaseMoveEngine(profile !== null ? { profile } : {});
  const events: MoveEvent[] = [];
  const trace: TraceRow[] = [];
  for (const f of frames) {
    events.push(...engine.update(f));
    if (withTrace) {
      const d = engine.debugState;
      trace.push({
        t: f.t,
        leftExt: d.left.extension,
        leftPhase: d.left.state,
        leftZone: d.left.zone,
        rightExt: d.right.extension,
        rightPhase: d.right.state,
        rightZone: d.right.zone,
      });
    }
  }
  return { events, trace };
}

/** Replay frames through a fresh legacy MoveEngine under given thresholds
 *  (the resampled-rate twin of analyze.ts replayTake, which only accepts a
 *  whole take; the engine construction is identical). */
export function replayBaselineFrames(
  frames: LandmarkFrame[],
  thresholds: MotionThresholds,
): MoveEvent[] {
  const engine = new MoveEngine({ thresholds });
  const events: MoveEvent[] = [];
  for (const f of frames) events.push(...engine.update(f));
  return events;
}

// ---------------------------------------------------------------------------
// Scoring (the analyze.ts discipline, shared with tests/framerateStress)
// ---------------------------------------------------------------------------

const isFire = (e: MoveEvent): boolean => e.kind === 'trigger' || e.kind === 'sustain-start';

function inWindow(t: number, w: RepWindow): boolean {
  return t >= w.startMs - REP_SLACK_MS && t <= w.endMs + REP_SLACK_MS;
}

export interface TakeScore {
  /** Rep windows containing at least one expected-move fire (max 1/window). */
  hits: number;
  /**
   * Same windows matched on the MOTION-COMPLETION time (event t minus
   * triggerLatencyMs, i.e. when the traversal/hold physically completed)
   * instead of the emission time. Supplementary diagnosis metric: the phase
   * engine's deliberate settle delay (JAB_SETTLE_MS) shifts emissions past
   * windows that were detected from hand-speed bursts, and this metric
   * separates "motion missed" from "motion detected, emitted late".
   */
  hitsCompletion: number;
  /** Indices of windows with no expected-move fire (emission-time match). */
  missIndices: number[];
  /** Fires outside all windows (positive takes) or all fires (negatives). */
  falsePositives: MoveEvent[];
}

/**
 * Score one take's replay events against its rep windows per the harness
 * rules in the module header. Windows must be the NATIVE take's windows,
 * whatever rate the events were produced at.
 */
export function scoreTake(
  take: StudioTakeExport,
  reps: RepWindow[],
  events: MoveEvent[],
): TakeScore {
  const exp = EXPECTATIONS[take.id] ?? { kind: 'positive' as const };
  const fires = events.filter(isFire);
  if (exp.kind !== 'positive') {
    return { hits: 0, hitsCompletion: 0, missIndices: [], falsePositives: fires };
  }
  const kinds = exp.eventKinds ?? ['trigger'];
  const expected = fires.filter((e) => e.move === exp.move && kinds.includes(e.kind));
  let hits = 0;
  let hitsCompletion = 0;
  const missIndices: number[] = [];
  reps.forEach((w, i) => {
    if (expected.some((e) => inWindow(e.t, w))) hits++;
    else missIndices.push(i);
    if (expected.some((e) => inWindow(e.t - e.triggerLatencyMs, w))) hitsCompletion++;
  });
  const falsePositives = fires.filter((e) => !reps.some((w) => inWindow(e.t, w)));
  return { hits, hitsCompletion, missIndices, falsePositives };
}

/** Per-move aggregate for one engine at one rate. */
export interface MoveTally {
  reps: number;
  hits: number;
  /** Completion-time hits (see TakeScore.hitsCompletion). */
  hitsCompletion: number;
  /** False positives attributed to this move's name, across ALL takes. */
  fps: number;
}

/**
 * Aggregate per-take scores into per-move rows: reps and hits accrue to the
 * take's expected move; false positives accrue to the move that FIRED them
 * (a stray jab on the whip take is a jab problem, not a whip problem).
 */
export function tallyByMove(
  scored: Array<{ take: StudioTakeExport; reps: RepWindow[]; score: TakeScore }>,
): Map<MoveName, MoveTally> {
  const rows = new Map<MoveName, MoveTally>();
  for (const m of ALL_MOVES) rows.set(m, { reps: 0, hits: 0, hitsCompletion: 0, fps: 0 });
  for (const { take, reps, score } of scored) {
    const exp = EXPECTATIONS[take.id];
    if (exp?.kind === 'positive' && exp.move !== undefined) {
      const row = rows.get(exp.move);
      if (row !== undefined) {
        row.reps += reps.length;
        row.hits += score.hits;
        row.hitsCompletion += score.hitsCompletion;
      }
    }
    for (const e of score.falsePositives) {
      const row = rows.get(e.move);
      if (row !== undefined) row.fps++;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Report rendering (terminal)
// ---------------------------------------------------------------------------

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const num = (x: number, d = 2): string => x.toFixed(d);

interface TakeRun {
  take: StudioTakeExport;
  reps: RepWindow[];
  frames: LandmarkFrame[];
  baseScore: TakeScore;
  phaseScore: TakeScore;
  trace: TraceRow[];
}

function printPerTake(runs: TakeRun[]): void {
  console.log('\n=== Per take (native rate, AUTO-PEAK rep windows) ===');
  console.log(
    pad('take', 22) +
      pad('maps to', 14) +
      pad('fps', 6) +
      pad('reps', 6) +
      pad('base hit', 10) +
      pad('phase hit', 11) +
      pad('base FP', 9) +
      'phase FP',
  );
  for (const r of runs) {
    const exp = EXPECTATIONS[r.take.id];
    const label = exp?.kind === 'positive' ? (exp.move ?? '?') : exp?.kind ?? '?';
    console.log(
      pad(r.take.id, 22) +
        pad(label, 14) +
        pad(num(r.take.fps, 1), 6) +
        pad(String(r.reps.length), 6) +
        pad(String(r.baseScore.hits), 10) +
        pad(String(r.phaseScore.hits), 11) +
        pad(String(r.baseScore.falsePositives.length), 9) +
        String(r.phaseScore.falsePositives.length),
    );
  }
}

function printMoveTable(runs: TakeRun[]): void {
  const base = tallyByMove(runs.map((r) => ({ take: r.take, reps: r.reps, score: r.baseScore })));
  const phase = tallyByMove(runs.map((r) => ({ take: r.take, reps: r.reps, score: r.phaseScore })));
  console.log('\n=== Per move: baseline vs phase (native rate) ===');
  console.log(
    '(hits = expected move fired inside window +-150 ms; cmpl = same match on',
  );
  console.log(
    ' the motion-completion time t - triggerLatencyMs, diagnosis only)',
  );
  console.log(
    pad('move', 15) +
      pad('reps', 6) +
      pad('base hits', 11) +
      pad('phase hits', 12) +
      pad('phase cmpl', 12) +
      pad('base FP', 9) +
      'phase FP',
  );
  let tReps = 0;
  let tBH = 0;
  let tPH = 0;
  let tPC = 0;
  let tBF = 0;
  let tPF = 0;
  for (const m of ALL_MOVES) {
    const b = base.get(m);
    const p = phase.get(m);
    if (b === undefined || p === undefined) continue;
    tReps += b.reps;
    tBH += b.hits;
    tPH += p.hits;
    tPC += p.hitsCompletion;
    tBF += b.fps;
    tPF += p.fps;
    console.log(
      pad(m, 15) +
        pad(String(b.reps), 6) +
        pad(String(b.hits), 11) +
        pad(String(p.hits), 12) +
        pad(String(p.hitsCompletion), 12) +
        pad(String(b.fps), 9) +
        String(p.fps),
    );
  }
  console.log(
    pad('TOTAL', 15) +
      pad(String(tReps), 6) +
      pad(String(tBH), 11) +
      pad(String(tPH), 12) +
      pad(String(tPC), 12) +
      pad(String(tBF), 9) +
      String(tPF),
  );
}

/** Trajectory printout around each phase-engine miss: the diagnosis data. */
function printMissTraces(runs: TakeRun[]): void {
  const missed = runs.filter((r) => r.phaseScore.missIndices.length > 0);
  if (missed.length === 0) {
    console.log('\nNo phase-engine misses at native rate.');
    return;
  }
  console.log('\n=== Phase-engine misses: extension / phase / zone around each window ===');
  for (const r of missed) {
    const hands = relevantHands(r.take.id);
    for (const i of r.phaseScore.missIndices) {
      const w = r.reps[i];
      if (w === undefined) continue;
      console.log(
        `\n--- ${r.take.id} rep ${i + 1} (${num(w.startMs, 0)}..${num(w.endMs, 0)} ms, ` +
          `${w.auto ? 'AUTO-PEAK' : 'confirmed'}) hands=${hands.join('+')}`,
      );
      for (const row of r.trace) {
        if (row.t < w.startMs - 400 || row.t > w.endMs + 400) continue;
        const parts: string[] = [pad(num(row.t, 0), 8)];
        if (hands.includes('left')) {
          parts.push(`L ext=${num(row.leftExt)} ${pad(row.leftPhase, 10)} ${row.leftZone}`);
        }
        if (hands.includes('right')) {
          parts.push(`R ext=${num(row.rightExt)} ${pad(row.rightPhase, 10)} ${row.rightZone}`);
        }
        console.log('  ' + parts.join('  '));
      }
    }
  }
}

interface RateCell {
  hits: number;
  reps: number;
  fps: number;
}

function printStressMatrix(
  title: string,
  matrix: Map<MoveName, Map<number, RateCell>>,
): void {
  console.log(`\n=== ${title}: hits/reps (FP) per rate ===`);
  console.log(
    pad('move', 15) + STRESS_RATES.map((r) => pad(`${r} fps`, 14)).join(''),
  );
  for (const m of ALL_MOVES) {
    const row = matrix.get(m);
    if (row === undefined) continue;
    const anyReps = STRESS_RATES.some((r) => (row.get(r)?.reps ?? 0) > 0);
    const anyFp = STRESS_RATES.some((r) => (row.get(r)?.fps ?? 0) > 0);
    if (!anyReps && !anyFp) continue;
    const cells = STRESS_RATES.map((rate) => {
      const c = row.get(rate);
      if (c === undefined) return pad('-', 14);
      return pad(`${c.hits}/${c.reps} (${c.fps})`, 14);
    });
    console.log(pad(m, 15) + cells.join(''));
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function loadExport(path: string): StudioExport {
  const exp = JSON.parse(readFileSync(path, 'utf8')) as StudioExport;
  if (exp.version !== 1) {
    throw new Error(`unsupported export version ${String(exp.version)} in ${path}`);
  }
  return exp;
}

function main(): void {
  const arg = process.argv[2];
  const path = arg ?? newestExportPath(join(ROOT, 'fixtures', 'recorded'));
  if (path === null || !existsSync(path)) {
    console.log('No recorded export found (fixtures/recorded/firebending-drill-*.json).');
    return;
  }
  const exp = loadExport(path);
  const profile = exp.meta.motionProfile;
  console.log(`Loaded ${path}`);
  console.log(
    `Motion profile: ${profile !== null ? 'from export (calibrated)' : 'NONE in export; phase engine runs on anatomical defaults'}`,
  );
  console.log(`Takes: ${exp.takes.length}; slack ${REP_SLACK_MS} ms; rates ${STRESS_RATES.join('/')}`);

  // Native-rate head-to-head.
  const runs: TakeRun[] = exp.takes.map((take) => {
    const reps = effectiveReps(take);
    const frames = landmarkFramesOf(take);
    const baseEvents = replayTake(take, take.thresholds).events;
    const phase = replayPhaseFrames(frames, profile, true);
    return {
      take,
      reps,
      frames,
      baseScore: scoreTake(take, reps, baseEvents),
      phaseScore: scoreTake(take, reps, phase.events),
      trace: phase.trace,
    };
  });

  printPerTake(runs);
  printMoveTable(runs);
  printMissTraces(runs);

  // Framerate stress: same takes, same windows, resampled streams.
  const phaseMatrix = new Map<MoveName, Map<number, RateCell>>();
  const baseMatrix = new Map<MoveName, Map<number, RateCell>>();
  for (const m of ALL_MOVES) {
    phaseMatrix.set(m, new Map());
    baseMatrix.set(m, new Map());
  }
  for (const rate of STRESS_RATES) {
    const scoredPhase: Array<{ take: StudioTakeExport; reps: RepWindow[]; score: TakeScore }> = [];
    const scoredBase: typeof scoredPhase = [];
    for (const r of runs) {
      const frames = resampleFrames(r.frames, rate);
      scoredPhase.push({
        take: r.take,
        reps: r.reps,
        score: scoreTake(r.take, r.reps, replayPhaseFrames(frames, profile).events),
      });
      scoredBase.push({
        take: r.take,
        reps: r.reps,
        score: scoreTake(r.take, r.reps, replayBaselineFrames(frames, r.take.thresholds)),
      });
    }
    for (const [m, tally] of tallyByMove(scoredPhase)) {
      phaseMatrix.get(m)?.set(rate, { hits: tally.hits, reps: tally.reps, fps: tally.fps });
    }
    for (const [m, tally] of tallyByMove(scoredBase)) {
      baseMatrix.get(m)?.set(rate, { hits: tally.hits, reps: tally.reps, fps: tally.fps });
    }
  }
  printStressMatrix('PHASE engine framerate stress', phaseMatrix);
  printStressMatrix('BASELINE engine framerate stress (contrast)', baseMatrix);

  // Flatness verdict: within one rep across the ladder, per move.
  console.log('\n=== Flatness verdict (phase engine, max-min hits across rates) ===');
  let allFlat = true;
  for (const m of ALL_MOVES) {
    const row = phaseMatrix.get(m);
    if (row === undefined) continue;
    const hits = STRESS_RATES.map((r) => row.get(r)?.hits ?? 0);
    const reps = row.get(STRESS_RATES[0] ?? 10)?.reps ?? 0;
    if (reps === 0) continue;
    const spread = Math.max(...hits) - Math.min(...hits);
    const flat = spread <= 1;
    if (!flat) allFlat = false;
    console.log(
      `  ${pad(m, 15)} hits ${hits.join('/')}  spread ${spread}  ${flat ? 'FLAT' : 'NOT FLAT'}`,
    );
  }
  console.log(allFlat ? '\nPASS: every move within one rep across 10/14/20/30 fps.'
    : '\nFAIL: at least one move varies by more than one rep across rates.');
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
