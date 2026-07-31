/**
 * Drill-export analysis pipeline (Round 3 Phase 4f; extended for the
 * 2026-07-31 drill review: AUTO-PEAK rep fallback + the 7-move set).
 *
 * Run: npm run analyze [path-to-export.json]
 *
 * Ingests the newest fixtures/recorded/firebending-drill-*.json (or the
 * given path), replays every take's trimmed frames through a REAL MoveEngine
 * under the CURRENT derived tuning (thresholdsFrom(export profile ??
 * DEFAULT_PROFILE)), so a rerun after a constants change validates exactly
 * the tuning that will ship; the capture-time thresholds each take exported
 * are shown in the report header for provenance. It reports:
 *
 * - AUTO-PEAK rep windows: a take with ZERO confirmed reps (markers never
 *   clicked in review) falls back to deterministic peak detection
 *   (src/studio/peaks.ts detectReps) over the take's primary review signal
 *   (src/studio/takes.ts). Auto windows are labeled auto everywhere, loudly:
 *   they are the machine's guess at where the player's reps were, not a
 *   human-confirmed ground truth.
 * - per positive take: reps (confirmed or AUTO-PEAK) vs fired events inside
 *   each rep window (+REP_SLACK_MS), and for each MISS which gating signal
 *   blocked it and by how much;
 * - the take-to-move mapping table: per take, every move that fired
 *   (trigger / sustain-start) anywhere in the take;
 * - the per-move summary: reps, fired in-rep, hit rate, and false positives
 *   measured across all OTHER takes' out-of-rep spans;
 * - signal-to-noise per gating signal per move;
 * - THRESHOLD PROPOSALS (max-margin separators between rep-window signal
 *   peaks and the noise pool). NOISE FLOOR PROVENANCE: when the export
 *   carries negative takes they are the noise pool; when they are ABSENT
 *   (this recording session) the pool is the between-rep (out-of-rep) spans
 *   of the positive takes plus every frame of the static-palm hold, and the
 *   report says so loudly;
 * - the palm-static take scored by BOTH palm scorers (legacy 3D palmScore
 *   and palmScore2D) for the docs/hagrid-report.md appendix verdict.
 *
 * 7-MOVE MAPPING: palm is no longer a classified pose on the critical path
 * (src/gestures/moves.ts header). The studio's palm-strike takes therefore
 * map to jab-blast and the flame-fan take maps to fire-stream; the mapping
 * is reported per take.
 *
 * Output: docs/drill-report.md plus a terminal summary. Proposals are NEVER
 * auto-applied: constants change only after review, against the user's
 * recorded data.
 *
 * Everything below main() is exported and DOM-free so the pipeline test
 * (tests/drillAnalyze.test.ts) can run the full analysis on a synthesized
 * export. Reports from exports marked meta.synthetic are labeled loudly.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MoveEngine, GRIP_ENTER_SCORE, BREATH_FIST_ENTER } from '../src/gestures/moves';
import type { MoveEvent, MoveName, NearMissRecord } from '../src/gestures/moves';
import { DEFAULT_PROFILE, thresholdsFrom } from '../src/gestures/profile';
import type { MotionProfile, MotionThresholds } from '../src/gestures/profile';
import { palmScore, palmScore2D } from '../src/gestures/poses';
import type { Handedness } from '../src/gestures/poses';
import { RATE_GATE_FPS, TARGET_CAPTURE_FPS } from '../src/studio/captureRate';
import type { CaptureHealth } from '../src/studio/captureRate';
import { detectReps } from '../src/studio/peaks';
import type { SignalSample } from '../src/studio/peaks';
import { primarySignalValue, takeDef } from '../src/studio/takes';
import type {
  StudioExport,
  StudioFrame,
  StudioSideSignals,
  StudioTakeExport,
  TakeId,
} from '../src/studio/exportSchema';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Slack added to BOTH ends of each rep window when counting fires and
 * signal peaks: at the recorded ~14 fps a peak-detected boundary can start
 * a frame late, so the window is treated symmetrically.
 */
export const REP_SLACK_MS = 150;

/** All seven moves, for the mapping and summary tables. */
export const ALL_MOVES: readonly MoveName[] = [
  'jab-blast',
  'fire-stream',
  'cross-combo',
  'twin-cannon',
  'rising-flame',
  'fire-whip',
  'breath-charge',
];

// ---------------------------------------------------------------------------
// Take expectations (7-move mapping)
// ---------------------------------------------------------------------------

export type TakeKind = 'positive' | 'negative' | 'static-palm';

export interface TakeExpectation {
  kind: TakeKind;
  /** Expected move for positive takes. */
  move?: MoveName;
  /** Event kinds that count as a fire (trigger vs sustain-start). */
  eventKinds?: ReadonlyArray<MoveEvent['kind']>;
  /** Present when the slot's original move was folded into another one. */
  mappedFrom?: string;
}

export const EXPECTATIONS: Record<TakeId, TakeExpectation> = {
  'jab-left-x5': { kind: 'positive', move: 'jab-blast', eventKinds: ['trigger'] },
  'jab-right-x5': { kind: 'positive', move: 'jab-blast', eventKinds: ['trigger'] },
  'alt-jab-combo-x3': { kind: 'positive', move: 'cross-combo', eventKinds: ['trigger'] },
  // 7-move mapping: a palm strike is a thrust; it must fire jab-blast now.
  'palm-strike-left-x5': {
    kind: 'positive',
    move: 'jab-blast',
    eventKinds: ['trigger'],
    mappedFrom: 'palm-wave',
  },
  'palm-strike-right-x5': {
    kind: 'positive',
    move: 'jab-blast',
    eventKinds: ['trigger'],
    mappedFrom: 'palm-wave',
  },
  'palm-static-5s': { kind: 'static-palm' },
  'fire-stream-4s-x2': {
    kind: 'positive',
    move: 'fire-stream',
    eventKinds: ['sustain-start'],
  },
  // 7-move mapping: a held palm push is a sustained thrust: fire-stream.
  'flame-fan-4s-x2': {
    kind: 'positive',
    move: 'fire-stream',
    eventKinds: ['sustain-start'],
    mappedFrom: 'flame-fan',
  },
  'twin-cannon-x3': { kind: 'positive', move: 'twin-cannon', eventKinds: ['trigger'] },
  'rising-flame-x3': { kind: 'positive', move: 'rising-flame', eventKinds: ['trigger'] },
  'fire-whip-left-x3': { kind: 'positive', move: 'fire-whip', eventKinds: ['trigger'] },
  'fire-whip-right-x3': { kind: 'positive', move: 'fire-whip', eventKinds: ['trigger'] },
  'breath-charge-x3': { kind: 'positive', move: 'breath-charge', eventKinds: ['trigger'] },
  'neg-talking-30s': { kind: 'negative' },
  'neg-idle-20s': { kind: 'negative' },
  'neg-reaching-20s': { kind: 'negative' },
};

/** Which hand slots carry the signal for a take id. */
export function relevantHands(id: TakeId): Handedness[] {
  if (id.includes('-left')) return ['left'];
  if (id.includes('-right')) return ['right'];
  return ['left', 'right'];
}

// ---------------------------------------------------------------------------
// Rep windows: confirmed markers, or the AUTO-PEAK fallback
// ---------------------------------------------------------------------------

export interface RepWindow {
  startMs: number;
  endMs: number;
  /** True when the window came from peak detection, not a confirmed marker. */
  auto: boolean;
  manual: boolean;
}

/**
 * The rep windows analysis runs on: the take's CONFIRMED markers when any
 * exist, else AUTO-PEAK windows from deterministic peak detection
 * (src/studio/peaks.ts detectReps, the same code that drives the studio's
 * live rep counter) over the take's primary review signal. Negative and
 * static-palm takes never get windows.
 */
export function effectiveReps(take: StudioTakeExport): RepWindow[] {
  const exp = EXPECTATIONS[take.id] ?? { kind: 'positive' as const };
  if (exp.kind !== 'positive') return [];
  const confirmed = take.reps.filter((r) => r.confirmed);
  if (confirmed.length > 0) {
    return confirmed.map((r) => ({
      startMs: r.startMs,
      endMs: r.endMs,
      auto: false,
      manual: r.manual,
    }));
  }
  const spec = takeDef(take.id).primary;
  const samples: SignalSample[] = take.frames.map((f) => ({
    t: f.t,
    v: primarySignalValue(f.signals, spec),
  }));
  return detectReps(samples).map((c) => ({
    startMs: c.startMs,
    endMs: c.endMs,
    auto: true,
    manual: false,
  }));
}

// ---------------------------------------------------------------------------
// Per-move gating signals (what can block a fire, for miss diagnosis + SNR)
// ---------------------------------------------------------------------------

export type SignalName =
  | 'wristSpeed'
  | 'bboxGrowth'
  | 'elbowVel'
  | 'upVel'
  | 'swingVx'
  | 'fist'
  | 'palm'
  | 'grip';

/** Read one signal from one side's exported StudioSideSignals. */
export function readSignal(side: StudioSideSignals, sig: SignalName): number {
  switch (sig) {
    case 'wristSpeed':
      return side.wristSpeed;
    case 'bboxGrowth':
      return side.bboxGrowth;
    case 'elbowVel':
      return side.elbowVel;
    case 'upVel':
      return -side.velY; // y grows down; upward velocity is -velY
    case 'swingVx':
      return Math.abs(side.velX);
    case 'fist':
      return side.fist;
    case 'palm':
      return side.palm;
    case 'grip':
      return side.grip;
  }
}

interface Gate {
  signal: SignalName;
  thresholdOf: (th: MotionThresholds) => number;
  /** Only meaningful when the take carried body pose. */
  needsPose?: boolean;
}

/**
 * Pose-agnostic thrust gates (7-move set): the elbow/speed/growth fusion
 * alone; NO finger-pose gate anywhere in the thrust family.
 */
const THRUST_GATES: Gate[] = [
  { signal: 'elbowVel', thresholdOf: (th) => th.elbowExtendVel, needsPose: true },
  { signal: 'wristSpeed', thresholdOf: (th) => th.spikeSpeed },
  { signal: 'bboxGrowth', thresholdOf: (th) => th.spikeGrowth },
];

export const MOVE_GATES: Record<MoveName, Gate[]> = {
  'jab-blast': THRUST_GATES,
  'cross-combo': THRUST_GATES,
  'fire-stream': THRUST_GATES,
  'twin-cannon': THRUST_GATES,
  'rising-flame': [{ signal: 'upVel', thresholdOf: (th) => th.risingUpVel }],
  'fire-whip': [
    { signal: 'grip', thresholdOf: () => GRIP_ENTER_SCORE },
    { signal: 'swingVx', thresholdOf: (th) => th.whipSwingVx },
  ],
  // The breath chamber keeps its fist read at the data-derived enter level
  // (see BREATH_FIST_ENTER in src/gestures/moves.ts).
  'breath-charge': [{ signal: 'fist', thresholdOf: () => BREATH_FIST_ENTER }],
};

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayResult {
  events: MoveEvent[];
  nearMisses: NearMissRecord[];
}

/**
 * Replay a take's trimmed frames through a real MoveEngine under the GIVEN
 * thresholds (analysis passes the current derived tuning), with near-miss
 * diagnostics captured in full via the engine's nearMissListener (the 8-slot
 * HUD ring would drop records).
 */
export function replayTake(
  take: StudioTakeExport,
  thresholds: MotionThresholds,
): ReplayResult {
  const engine = new MoveEngine({ thresholds });
  engine.debugEnabled = true;
  const nearMisses: NearMissRecord[] = [];
  engine.nearMissListener = (rec) => nearMisses.push({ ...rec });
  const events: MoveEvent[] = [];
  for (const f of take.frames) {
    events.push(
      ...engine.update({ t: f.t, left: f.left, right: f.right, face: null, pose: f.pose }),
    );
  }
  return { events, nearMisses };
}

// ---------------------------------------------------------------------------
// Analysis result types
// ---------------------------------------------------------------------------

export interface Blocker {
  signal: SignalName;
  /** Per-rep maximum observed across the take's relevant hands. */
  max: number;
  threshold: number;
  /** threshold - max (how far the signal fell short). */
  deficit: number;
}

export interface NearMissSummary {
  condition: NearMissRecord['condition'];
  /** Best (largest) value the failed condition reached inside the window. */
  maxValue: number;
  threshold: number;
  count: number;
}

export interface RepResult {
  index: number;
  startMs: number;
  endMs: number;
  auto: boolean;
  manual: boolean;
  /** Expected-move events fired inside [startMs, endMs + REP_SLACK_MS]. */
  fired: number;
  miss: boolean;
  /** For misses: gates whose per-rep maximum never crossed. */
  blockers: Blocker[];
  /** Engine near-miss records inside the window, aggregated per condition. */
  nearMisses: NearMissSummary[];
}

export interface FalsePositive {
  t: number;
  move: MoveName;
  hand: string;
  kind: MoveEvent['kind'];
  /** Signal values at the triggering frame (max across hands for 'both'). */
  signals: Partial<Record<SignalName, number>>;
}

export interface SnrRow {
  signal: SignalName;
  /** Median of per-rep in-window peaks. */
  peakMedian: number;
  /** 95th percentile of the noise pool (see noise provenance). */
  noiseP95: number;
  /** peakMedian / noiseP95 (Infinity when the noise floor is 0). */
  ratio: number;
}

export interface Dist {
  n: number;
  p5: number;
  median: number;
  p95: number;
  above75: number;
  above55: number;
}

export interface PalmCompare {
  frames: number;
  score3D: Dist;
  score2D: Dist;
}

/** Fired counts for one move within one take. */
export interface MoveFireCount {
  move: MoveName;
  /** Trigger/sustain-start events anywhere in the take. */
  total: number;
  /** Of those, events OUTSIDE every rep window (+slack) of the take. */
  outOfRep: number;
}

export interface TakeAnalysis {
  id: TakeId;
  takeIndex: number;
  starred: boolean;
  status: string;
  /** Measured landmark capture rate of the take (frames/duration). */
  fps: number;
  /** Mean/min instantaneous fps when the export carries them (newer
   *  studio builds); absent on pre-gate exports. */
  fpsMean?: number;
  fpsMin?: number;
  /**
   * Phase 1 capture hard gate: the take measured under TARGET_CAPTURE_FPS
   * (30). Every downstream number derived from such a take is invalid for
   * tuning; the report banner names these takes.
   */
  lowFps: boolean;
  kind: TakeKind;
  move?: MoveName;
  /** Original move name when the 7-move fold remapped the slot. */
  mappedFrom?: string;
  hasPose: boolean;
  /** Rep windows used (confirmed markers or AUTO-PEAK). */
  repsUsed: number;
  /** True when the windows came from AUTO-PEAK detection. */
  autoReps: boolean;
  /** Expected-move fires anywhere in the take (positive takes). */
  totalFired: number;
  reps: RepResult[];
  /** Every move that fired anywhere in this take (mapping table). */
  firedByMove: MoveFireCount[];
  falsePositives: FalsePositive[];
  snr: SnrRow[];
  palmCompare?: PalmCompare;
}

export interface FractionProposal {
  constant: string;
  profilePeakName: string;
  profilePeak: number;
  implied: number;
  current: number;
}

export interface Proposal {
  /** MotionThresholds field the proposal targets. */
  name: keyof MotionThresholds;
  signal: SignalName;
  repPeaks: number[];
  noiseMax: number;
  /** Midpoint between max noise and the lowest separable rep peak; null
   *  when no rep peak clears the noise at all. */
  threshold: number | null;
  /** Half-gap between the lowest separable rep peak and the max noise. */
  margin: number;
  /** Reps whose peak sits at or below the proposed threshold. */
  missingReps: number;
  current: number;
  fraction: FractionProposal | null;
}

/** One row of the per-move summary table. */
export interface MoveSummaryRow {
  move: MoveName;
  /** Takes expected to produce this move. */
  takes: string[];
  reps: number;
  autoReps: number;
  firedInRep: number;
  misses: number;
  /** firedInRep / reps (NaN when reps is 0). */
  hitRate: number;
  /** Fires of this move in OTHER takes' out-of-rep spans. */
  fpOutOfRep: number;
  /** Fires of this move inside OTHER takes' rep windows (cross-fires). */
  crossInRep: number;
}

export interface DrillAnalysis {
  sourcePath: string;
  synthetic: boolean;
  exportedAt: string;
  profileSource: 'export' | 'default';
  /** The thresholds every replay ran under (current derived tuning). */
  thresholds: MotionThresholds;
  /** True when at least one take ran on AUTO-PEAK rep windows. */
  autoPeakUsed: boolean;
  /**
   * Takes (id#index) measured under TARGET_CAPTURE_FPS: the Phase 1
   * capture hard gate. Their numbers are invalid for tuning.
   */
  lowFpsTakes: string[];
  /** The export's capture-health summary; null on pre-gate exports. */
  captureHealth: CaptureHealth | null;
  /** Human-readable provenance of the noise pool used for proposals. */
  noiseProvenance: string;
  takes: TakeAnalysis[];
  moveSummary: MoveSummaryRow[];
  proposals: Proposal[];
}

// ---------------------------------------------------------------------------
// Small stats helpers
// ---------------------------------------------------------------------------

export function percentile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)));
  const v = s[i];
  return v === undefined ? NaN : v;
}

const median = (v: number[]): number => percentile(v, 0.5);

function distOf(values: number[]): Dist {
  return {
    n: values.length,
    p5: percentile(values, 0.05),
    median: median(values),
    p95: percentile(values, 0.95),
    above75: values.filter((x) => x > 0.75).length,
    above55: values.filter((x) => x > 0.55).length,
  };
}

// ---------------------------------------------------------------------------
// Per-take analysis
// ---------------------------------------------------------------------------

function frameSignalMax(frame: StudioFrame, hands: Handedness[], sig: SignalName): number {
  let best = -Infinity;
  for (const h of hands) {
    const side = h === 'left' ? frame.signals.left : frame.signals.right;
    const v = readSignal(side, sig);
    if (v > best) best = v;
  }
  return best === -Infinity ? 0 : best;
}

function inWindow(t: number, startMs: number, endMs: number): boolean {
  return t >= startMs - REP_SLACK_MS && t <= endMs + REP_SLACK_MS;
}

function inAnyWindow(t: number, reps: RepWindow[]): boolean {
  return reps.some((r) => inWindow(t, r.startMs, r.endMs));
}

function frameSignals(frame: StudioFrame, hands: Handedness[]): Partial<Record<SignalName, number>> {
  const sigs: SignalName[] = ['wristSpeed', 'bboxGrowth', 'elbowVel', 'fist', 'palm', 'grip'];
  const out: Partial<Record<SignalName, number>> = {};
  for (const s of sigs) out[s] = frameSignalMax(frame, hands, s);
  return out;
}

/** Nearest frame at or before t (falls back to the first frame). */
function frameAt(frames: StudioFrame[], t: number): StudioFrame | null {
  let best: StudioFrame | null = null;
  for (const f of frames) {
    if (f.t <= t) best = f;
    else break;
  }
  return best ?? (frames.length > 0 ? (frames[0] ?? null) : null);
}

const isFire = (e: MoveEvent): boolean =>
  e.kind === 'trigger' || e.kind === 'sustain-start';

export function analyzeTake(
  take: StudioTakeExport,
  reps: RepWindow[],
  thresholds: MotionThresholds,
): TakeAnalysis {
  const exp = EXPECTATIONS[take.id] ?? { kind: 'positive' as const };
  const hands = relevantHands(take.id);
  const hasPose = take.frames.some((f) => f.pose !== null);
  const { events, nearMisses } = replayTake(take, thresholds);

  const firedByMove: MoveFireCount[] = ALL_MOVES.map((move) => {
    const fires = events.filter((e) => e.move === move && isFire(e));
    return {
      move,
      total: fires.length,
      outOfRep: fires.filter((e) => !inAnyWindow(e.t, reps)).length,
    };
  }).filter((c) => c.total > 0);

  const base: TakeAnalysis = {
    id: take.id,
    takeIndex: take.takeIndex,
    starred: take.starred,
    status: take.status,
    fps: take.fps,
    ...(take.fpsMean !== undefined ? { fpsMean: take.fpsMean } : {}),
    ...(take.fpsMin !== undefined ? { fpsMin: take.fpsMin } : {}),
    lowFps: take.fps < TARGET_CAPTURE_FPS,
    kind: exp.kind,
    hasPose,
    repsUsed: reps.length,
    autoReps: reps.some((r) => r.auto),
    totalFired: 0,
    reps: [],
    firedByMove,
    falsePositives: [],
    snr: [],
  };
  if (exp.move) base.move = exp.move;
  if (exp.mappedFrom !== undefined) base.mappedFrom = exp.mappedFrom;

  if (exp.kind === 'negative' || exp.kind === 'static-palm') {
    // Every fired event on a negative (or the static-palm hold) is a false
    // positive; report it with the triggering frame's signal values.
    for (const e of events) {
      if (!isFire(e)) continue;
      const evHands: Handedness[] = e.hand === 'both' ? ['left', 'right'] : [e.hand];
      const f = frameAt(take.frames, e.t);
      base.falsePositives.push({
        t: e.t,
        move: e.move,
        hand: e.hand,
        kind: e.kind,
        signals: f ? frameSignals(f, evHands) : {},
      });
    }
    if (exp.kind === 'static-palm') {
      // BOTH palm scorers on the raw exported landmarks: the user's own
      // static-palm hold is the live verdict on the 2D scorer switch.
      const s3: number[] = [];
      const s2: number[] = [];
      for (const f of take.frames) {
        for (const h of ['left', 'right'] as const) {
          const hf = h === 'left' ? f.left : f.right;
          if (hf === null || hf.landmarks.length < 21) continue;
          s3.push(palmScore(hf, h));
          s2.push(palmScore2D(hf, h));
        }
      }
      base.palmCompare = { frames: s3.length, score3D: distOf(s3), score2D: distOf(s2) };
    }
    return base;
  }

  // Positive take.
  const move = exp.move;
  const kinds = exp.eventKinds ?? ['trigger'];
  const gates = move ? MOVE_GATES[move] : [];
  const activeGates = gates.filter((g) => !(g.needsPose === true && !hasPose));
  const fired = events.filter((e) => e.move === move && kinds.includes(e.kind));
  base.totalFired = fired.length;

  base.reps = reps.map((rep, index) => {
    const inRep = fired.filter((e) => inWindow(e.t, rep.startMs, rep.endMs));
    const miss = inRep.length === 0;
    const blockers: Blocker[] = [];
    const nm: NearMissSummary[] = [];
    if (miss) {
      const repFrames = take.frames.filter((f) => inWindow(f.t, rep.startMs, rep.endMs));
      for (const g of activeGates) {
        const threshold = g.thresholdOf(thresholds);
        let max = -Infinity;
        for (const f of repFrames) {
          const v = frameSignalMax(f, hands, g.signal);
          if (v > max) max = v;
        }
        if (max === -Infinity) max = 0;
        if (max < threshold) {
          blockers.push({ signal: g.signal, max, threshold, deficit: threshold - max });
        }
      }
      // Aggregate the engine's own near-miss records inside the window.
      const byCondition = new Map<NearMissRecord['condition'], NearMissSummary>();
      for (const r of nearMisses) {
        if (!inWindow(r.t, rep.startMs, rep.endMs)) continue;
        const cur = byCondition.get(r.condition);
        if (!cur) {
          byCondition.set(r.condition, {
            condition: r.condition,
            maxValue: r.value,
            threshold: r.threshold,
            count: 1,
          });
        } else {
          cur.count++;
          if (r.value > cur.maxValue) {
            cur.maxValue = r.value;
            cur.threshold = r.threshold;
          }
        }
      }
      nm.push(...byCondition.values());
    }
    return {
      index,
      startMs: rep.startMs,
      endMs: rep.endMs,
      auto: rep.auto,
      manual: rep.manual,
      fired: inRep.length,
      miss,
      blockers,
      nearMisses: nm,
    };
  });

  // Signal-to-noise: per gate signal, median in-rep peak vs p95 of the
  // out-of-rep frames of this take (the full cross-take noise pool is
  // folded in by analyzeExport).
  base.snr = activeGates.map((g) => {
    const peaks: number[] = [];
    for (const rep of reps) {
      let max = -Infinity;
      for (const f of take.frames) {
        if (!inWindow(f.t, rep.startMs, rep.endMs)) continue;
        const v = frameSignalMax(f, hands, g.signal);
        if (v > max) max = v;
      }
      if (max !== -Infinity) peaks.push(max);
    }
    const noise: number[] = [];
    for (const f of take.frames) {
      if (!inAnyWindow(f.t, reps)) noise.push(frameSignalMax(f, hands, g.signal));
    }
    const peakMedian = median(peaks);
    const noiseP95 = percentile(noise, 0.95);
    return {
      signal: g.signal,
      peakMedian,
      noiseP95,
      ratio: noiseP95 > 0 ? peakMedian / noiseP95 : Infinity,
    };
  });

  return base;
}

// ---------------------------------------------------------------------------
// Cross-take: noise pools and threshold proposals
// ---------------------------------------------------------------------------

export interface NoisePoolResult {
  /** Per-frame signal values of the noise pool for one signal. */
  values: number[];
  provenance: string;
}

/**
 * The noise pool for one signal. When the export carries negative takes,
 * every frame of every negative take (the original design). When they are
 * ABSENT, the fallback pool: every OUT-OF-REP frame of every positive take
 * plus every frame of the static-palm hold. The provenance string states
 * which pool was used; the report prints it loudly.
 */
export function noisePoolFor(
  exp: StudioExport,
  repsByTake: Map<StudioTakeExport, RepWindow[]>,
  sig: SignalName,
): NoisePoolResult {
  const negatives = exp.takes.filter((t) => EXPECTATIONS[t.id]?.kind === 'negative');
  if (negatives.length > 0) {
    const values: number[] = [];
    for (const t of negatives) {
      for (const f of t.frames) values.push(frameSignalMax(f, ['left', 'right'], sig));
    }
    return { values, provenance: `all frames of ${negatives.length} negative takes` };
  }
  const values: number[] = [];
  let posTakes = 0;
  let staticTakes = 0;
  for (const t of exp.takes) {
    const kind = EXPECTATIONS[t.id]?.kind ?? 'positive';
    if (kind === 'negative') continue;
    if (kind === 'static-palm') {
      staticTakes++;
      for (const f of t.frames) values.push(frameSignalMax(f, ['left', 'right'], sig));
      continue;
    }
    posTakes++;
    const reps = repsByTake.get(t) ?? [];
    for (const f of t.frames) {
      if (!inAnyWindow(f.t, reps)) {
        values.push(frameSignalMax(f, ['left', 'right'], sig));
      }
    }
  }
  return {
    values,
    provenance:
      `NEGATIVE TAKES ABSENT: noise floor built from the between-rep ` +
      `(out-of-rep) spans of ${posTakes} positive takes plus all frames of ` +
      `${staticTakes} static-palm hold(s)`,
  };
}

/** Per-rep peaks of a signal across the given takes' rep windows. */
function repPeaksFor(
  takes: StudioTakeExport[],
  repsByTake: Map<StudioTakeExport, RepWindow[]>,
  sig: SignalName,
): number[] {
  const out: number[] = [];
  for (const t of takes) {
    const hands = relevantHands(t.id);
    for (const rep of repsByTake.get(t) ?? []) {
      let max = -Infinity;
      for (const f of t.frames) {
        if (!inWindow(f.t, rep.startMs, rep.endMs)) continue;
        const v = frameSignalMax(f, hands, sig);
        if (v > max) max = v;
      }
      if (max !== -Infinity) out.push(max);
    }
  }
  return out;
}

/**
 * Max-margin separator between rep-window peaks and the noise pool: the
 * midpoint between the largest noise value and the smallest rep peak above
 * it. Reps whose peak falls at or below the proposal would still miss and
 * are counted, not hidden.
 */
export function proposeSeparator(
  peaks: number[],
  noise: number[],
): { threshold: number | null; margin: number; missingReps: number; noiseMax: number } {
  const noiseMax = noise.length > 0 ? Math.max(...noise) : 0;
  const above = peaks.filter((p) => p > noiseMax);
  if (above.length === 0) {
    return { threshold: null, margin: 0, missingReps: peaks.length, noiseMax };
  }
  const minAbove = Math.min(...above);
  const threshold = (noiseMax + minAbove) / 2;
  return {
    threshold,
    margin: (minAbove - noiseMax) / 2,
    missingReps: peaks.filter((p) => p <= threshold).length,
    noiseMax,
  };
}

const THRUST_TAKE_IDS: TakeId[] = [
  'jab-left-x5',
  'jab-right-x5',
  'alt-jab-combo-x3',
  'palm-strike-left-x5',
  'palm-strike-right-x5',
  'fire-stream-4s-x2',
  'flame-fan-4s-x2',
  'twin-cannon-x3',
];

interface ProposalSpec {
  name: keyof MotionThresholds;
  signal: SignalName;
  takeIds: TakeId[];
  fraction: (profile: MotionProfile, t: number) => FractionProposal;
  needsPose?: boolean;
}

const PROPOSAL_SPECS: ProposalSpec[] = [
  {
    name: 'spikeSpeed',
    signal: 'wristSpeed',
    takeIds: THRUST_TAKE_IDS,
    fraction: (p, t) => ({
      constant: 'JAB_TRIGGER_FRACTION',
      profilePeakName: 'peakPunchSpeed',
      profilePeak: p.peakPunchSpeed,
      implied: t / p.peakPunchSpeed,
      current: 0.45,
    }),
  },
  {
    name: 'spikeGrowth',
    signal: 'bboxGrowth',
    takeIds: THRUST_TAKE_IDS,
    fraction: (p, t) => ({
      constant: 'JAB_TRIGGER_FRACTION (growth term)',
      profilePeakName: 'peakPunchBboxGrowth',
      profilePeak: p.peakPunchBboxGrowth,
      implied: t / p.peakPunchBboxGrowth,
      current: 0.45,
    }),
  },
  {
    name: 'elbowExtendVel',
    signal: 'elbowVel',
    takeIds: THRUST_TAKE_IDS,
    needsPose: true,
    fraction: (p, t) => ({
      constant: 'JAB_TRIGGER_FRACTION (elbow term)',
      profilePeakName: 'peakElbowVel',
      profilePeak: p.peakElbowVel,
      implied: t / p.peakElbowVel,
      current: 0.45,
    }),
  },
  {
    name: 'risingUpVel',
    signal: 'upVel',
    takeIds: ['rising-flame-x3'],
    fraction: (p, t) => ({
      constant: 'SWEEP_FRACTION',
      profilePeakName: 'peakPunchSpeed',
      profilePeak: p.peakPunchSpeed,
      implied: t / p.peakPunchSpeed,
      current: 0.5,
    }),
  },
  {
    name: 'whipSwingVx',
    signal: 'swingVx',
    takeIds: ['fire-whip-left-x3', 'fire-whip-right-x3'],
    fraction: (p, t) => ({
      constant: 'SWEEP_FRACTION',
      profilePeakName: 'peakPunchSpeed',
      profilePeak: p.peakPunchSpeed,
      implied: t / p.peakPunchSpeed,
      current: 0.5,
    }),
  },
];

export function buildProposals(
  exp: StudioExport,
  repsByTake: Map<StudioTakeExport, RepWindow[]>,
  thresholds: MotionThresholds,
): { proposals: Proposal[]; provenance: string } {
  const profile = exp.meta.motionProfile ?? DEFAULT_PROFILE;
  const out: Proposal[] = [];
  let provenance = '';
  for (const spec of PROPOSAL_SPECS) {
    const takes = exp.takes.filter((t) => spec.takeIds.includes(t.id));
    if (spec.needsPose === true) {
      // Elbow velocity is meaningless without body pose in the recording.
      const withPose = takes.filter((t) => t.frames.some((f) => f.pose !== null));
      if (withPose.length === 0) continue;
    }
    const peaks = repPeaksFor(takes, repsByTake, spec.signal);
    if (peaks.length === 0) continue;
    const noise = noisePoolFor(exp, repsByTake, spec.signal);
    provenance = noise.provenance;
    const sep = proposeSeparator(peaks, noise.values);
    out.push({
      name: spec.name,
      signal: spec.signal,
      repPeaks: peaks,
      noiseMax: sep.noiseMax,
      threshold: sep.threshold,
      margin: sep.margin,
      missingReps: sep.missingReps,
      current: thresholds[spec.name],
      fraction: sep.threshold !== null ? spec.fraction(profile, sep.threshold) : null,
    });
  }
  return { proposals: out, provenance };
}

// ---------------------------------------------------------------------------
// Full analysis
// ---------------------------------------------------------------------------

export function analyzeExport(exp: StudioExport, sourcePath: string): DrillAnalysis {
  const profile = exp.meta.motionProfile;
  // CURRENT derived tuning: rerunning analyze after a constants change
  // validates the tuning that will actually ship.
  const thresholds = thresholdsFrom(profile ?? DEFAULT_PROFILE);

  const repsByTake = new Map<StudioTakeExport, RepWindow[]>();
  for (const t of exp.takes) repsByTake.set(t, effectiveReps(t));

  const takes = exp.takes.map((t) => analyzeTake(t, repsByTake.get(t) ?? [], thresholds));

  // Fold the full noise pool into every positive take's reported SNR: the
  // noise p95 covers the cross-take pool, not just the take's own frames.
  for (const ta of takes) {
    if (ta.kind !== 'positive') continue;
    ta.snr = ta.snr.map((row) => {
      const pool = noisePoolFor(exp, repsByTake, row.signal);
      const noiseP95 = percentile(pool.values, 0.95);
      return {
        ...row,
        noiseP95,
        ratio: noiseP95 > 0 ? row.peakMedian / noiseP95 : Infinity,
      };
    });
  }

  // Per-move summary: reps, fired, hit rate, plus false positives measured
  // across all OTHER takes' out-of-rep spans (cross-fires inside other
  // takes' rep windows are reported separately, not hidden).
  const moveSummary: MoveSummaryRow[] = ALL_MOVES.map((move) => {
    const own = takes.filter((t) => t.kind === 'positive' && t.move === move);
    const others = takes.filter((t) => !(t.kind === 'positive' && t.move === move));
    const reps = own.reduce((s, t) => s + t.repsUsed, 0);
    const autoReps = own.reduce(
      (s, t) => s + t.reps.filter((r) => r.auto).length,
      0,
    );
    const firedInRep = own.reduce(
      (s, t) => s + t.reps.reduce((ss, r) => ss + r.fired, 0),
      0,
    );
    const misses = own.reduce((s, t) => s + t.reps.filter((r) => r.miss).length, 0);
    let fpOutOfRep = 0;
    let crossInRep = 0;
    for (const t of others) {
      const c = t.firedByMove.find((f) => f.move === move);
      if (!c) continue;
      fpOutOfRep += c.outOfRep;
      crossInRep += c.total - c.outOfRep;
    }
    return {
      move,
      takes: own.map((t) => `${t.id}#${t.takeIndex}`),
      reps,
      autoReps,
      firedInRep,
      misses,
      hitRate: reps > 0 ? firedInRep / reps : NaN,
      fpOutOfRep,
      crossInRep,
    };
  });

  const { proposals, provenance } = buildProposals(exp, repsByTake, thresholds);

  return {
    sourcePath,
    synthetic: exp.meta.synthetic === true,
    exportedAt: exp.exportedAt,
    profileSource: profile !== null ? 'export' : 'default',
    thresholds,
    autoPeakUsed: takes.some((t) => t.autoReps),
    lowFpsTakes: takes
      .filter((t) => t.lowFps)
      .map((t) => `${t.id}#${t.takeIndex}`),
    captureHealth: exp.captureHealth ?? null,
    noiseProvenance: provenance,
    takes,
    moveSummary,
    proposals,
  };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

const fmt = (x: number | null | undefined, digits = 3): string =>
  x === null || x === undefined || Number.isNaN(x) ? 'n/a' : x.toFixed(digits);

const pct = (x: number): string => (Number.isNaN(x) ? 'n/a' : `${(100 * x).toFixed(0)}%`);

function syntheticBanner(a: DrillAnalysis): string {
  if (!a.synthetic) return '';
  return [
    '',
    '> **SYNTHETIC INPUT - NOT REAL PLAYER DATA.** This report was generated',
    '> from a synthesized export (pipeline test fixtures). None of the numbers',
    '> below may be used to tune thresholds. Record real drills in the studio',
    '> and re-run `npm run analyze`.',
    '',
  ].join('\n');
}

/**
 * Phase 1 capture hard gate banner: any take under TARGET_CAPTURE_FPS (30)
 * invalidates every number derived from it. Analysis still runs so the
 * failure is visible, but the banner names the invalid takes at the top.
 */
function lowFpsBanner(a: DrillAnalysis): string {
  if (a.lowFpsTakes.length === 0) return '';
  const lows = a.takes.filter((t) => t.lowFps);
  return [
    '',
    `> **CAPTURE RATE UNDER ${TARGET_CAPTURE_FPS} FPS - PHASE 1 HARD GATE.** The`,
    '> takes listed below were captured under the required 30 fps landmark',
    '> rate (a 120 ms jab spans under 2 samples at 14 fps). Per the hard',
    '> gate, EVERY downstream number derived from these takes (rep windows,',
    '> hit rates, SNR, threshold proposals) is INVALID for tuning. The',
    '> analysis still runs so the failure stays visible, but do not apply',
    `> anything based on them. Takes at or above ${TARGET_CAPTURE_FPS} fps are unaffected.`,
    '>',
    ...lows.map(
      (t) =>
        `> - ${t.id}#${t.takeIndex}: ${fmt(t.fps, 1)} fps` +
        (t.fpsMin !== undefined ? ` (min ${fmt(t.fpsMin, 1)})` : ''),
    ),
    '',
  ].join('\n');
}

function autoPeakBanner(a: DrillAnalysis): string {
  if (!a.autoPeakUsed) return '';
  return [
    '',
    '> **AUTO-PEAK REP WINDOWS IN USE.** One or more takes had ZERO confirmed',
    '> rep markers (review markers were never clicked), so their rep windows',
    '> were AUTO-DETECTED by deterministic peak detection over each take\'s',
    '> primary review signal (src/studio/peaks.ts). Auto windows are marked',
    '> `auto` in every table below. They are the machine\'s reconstruction of',
    '> where the player\'s reps were, not human-confirmed ground truth.',
    '',
  ].join('\n');
}

export function buildReport(a: DrillAnalysis): string {
  const L: string[] = [];
  const title = a.synthetic
    ? '# Drill analysis report [SYNTHETIC DATA]'
    : '# Drill analysis report';
  L.push(title, '');
  L.push(`- Source: \`${a.sourcePath}\``);
  L.push(`- Exported at: ${a.exportedAt}`);
  L.push(
    `- Motion profile: ${a.profileSource === 'export' ? 'from export (calibrated)' : 'DEFAULT_PROFILE (no calibration in export)'}`,
  );
  L.push(
    `- Replayed under CURRENT derived tuning: spikeSpeed ${fmt(a.thresholds.spikeSpeed)}, ` +
      `spikeGrowth ${fmt(a.thresholds.spikeGrowth)}, elbowExtendVel ${fmt(a.thresholds.elbowExtendVel)}, ` +
      `risingUpVel ${fmt(a.thresholds.risingUpVel)}, whipSwingVx ${fmt(a.thresholds.whipSwingVx)} ` +
      `(capture-time thresholds are stored per take in the export)`,
  );
  if (a.captureHealth !== null) {
    L.push(
      `- Capture health: min ${fmt(a.captureHealth.minFps, 1)} fps, ` +
        `median ${fmt(a.captureHealth.medianFps, 1)} fps, ` +
        `${a.captureHealth.takesUnderGate} take(s) under the ${RATE_GATE_FPS} fps studio gate`,
    );
  }
  L.push(lowFpsBanner(a));
  L.push(syntheticBanner(a));
  L.push(autoPeakBanner(a));

  L.push('## Takes: reps vs fired (7-move set)', '');
  L.push(
    'Palm-strike takes map to jab-blast and the flame-fan take maps to',
    'fire-stream: palm is no longer a classified pose on the critical path.',
    '',
  );
  L.push('| take | maps to | status | pose | capture fps | reps used | rep source | fired in-rep | misses | false positives |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const t of a.takes) {
    const firedInRep = t.reps.reduce((s, r) => s + r.fired, 0);
    const misses = t.reps.filter((r) => r.miss).length;
    const mapped = t.move
      ? `${t.move}${t.mappedFrom !== undefined ? ` (was ${t.mappedFrom})` : ''}`
      : t.kind;
    const fpsCell =
      `${fmt(t.fps, 1)}` +
      (t.fpsMin !== undefined ? ` (min ${fmt(t.fpsMin, 1)})` : '') +
      (t.lowFps ? ' **LOW FPS**' : '');
    L.push(
      `| ${t.id}#${t.takeIndex} | ${mapped} | ${t.status} | ${t.hasPose ? 'yes' : 'no'} | ${fpsCell} | ` +
        `${t.kind === 'positive' ? t.repsUsed : '-'} | ` +
        `${t.kind === 'positive' ? (t.autoReps ? '**AUTO-PEAK**' : 'confirmed') : '-'} | ` +
        `${t.kind === 'positive' ? firedInRep : '-'} | ` +
        `${t.kind === 'positive' ? misses : '-'} | ` +
        `${t.kind !== 'positive' ? t.falsePositives.length : '-'} |`,
    );
  }
  L.push('');

  // Take-to-move mapping: every move that fired anywhere in each take.
  L.push('## Which moves fired in which takes', '');
  L.push(
    'Trigger / sustain-start events per move across each whole take',
    '(in-rep + out-of-rep). The expected move is marked with `<-`.',
    '',
  );
  L.push('| take | ' + ALL_MOVES.join(' | ') + ' |');
  L.push('| --- |' + ALL_MOVES.map(() => ' --- |').join(''));
  for (const t of a.takes) {
    const cells = ALL_MOVES.map((m) => {
      const c = t.firedByMove.find((f) => f.move === m);
      const mark = t.kind === 'positive' && t.move === m ? ' <-' : '';
      if (!c) return `0${mark}`;
      return `${c.total} (${c.outOfRep} out-of-rep)${mark}`;
    });
    L.push(`| ${t.id}#${t.takeIndex} | ${cells.join(' | ')} |`);
  }
  L.push('');

  // Per-move summary.
  L.push('## Per-move summary: reps, hit rate, false positives', '');
  L.push(
    'False positives are fires of the move inside OTHER takes\' out-of-rep',
    'spans; cross-fires inside other takes\' rep windows are listed',
    'separately (a jab firing during a twin-cannon rep is a cross-fire, not',
    'background noise).',
    '',
  );
  L.push('| move | takes | reps (auto) | fired in-rep | hit rate | misses | FP (other takes, out-of-rep) | cross-fires (other takes, in-rep) |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of a.moveSummary) {
    L.push(
      `| ${row.move} | ${row.takes.join(', ') || '-'} | ${row.reps} (${row.autoReps} auto) | ` +
        `${row.firedInRep} | ${pct(row.hitRate)} | ${row.misses} | ${row.fpOutOfRep} | ${row.crossInRep} |`,
    );
  }
  L.push('');

  // Misses.
  const missing = a.takes.filter((t) => t.reps.some((r) => r.miss));
  if (missing.length > 0) {
    L.push('## Missed reps: what blocked them', '');
    for (const t of missing) {
      for (const r of t.reps) {
        if (!r.miss) continue;
        L.push(
          `### ${t.id}#${t.takeIndex} rep ${r.index + 1} ` +
            `(${fmt(r.startMs, 0)}..${fmt(r.endMs, 0)} ms` +
            `${r.auto ? ', AUTO-PEAK window' : r.manual ? ', manual marker' : ''})`,
          '',
        );
        if (r.blockers.length === 0) {
          L.push(
            '- Every gating signal crossed its threshold at some point in the',
            '  window, but no event fired: look at timing (hysteresis frames,',
            '  retract window, cooldowns) via the near-miss records below.',
          );
        } else {
          L.push('| blocking signal | rep max | threshold | short by |');
          L.push('| --- | --- | --- | --- |');
          for (const b of r.blockers) {
            L.push(
              `| ${b.signal} | ${fmt(b.max)} | ${fmt(b.threshold)} | ${fmt(b.deficit)} |`,
            );
          }
        }
        if (r.nearMisses.length > 0) {
          L.push('', 'Engine near-miss records in the window:', '');
          L.push('| failed condition | best value | threshold | occurrences |');
          L.push('| --- | --- | --- | --- |');
          for (const n of r.nearMisses) {
            L.push(
              `| ${n.condition} | ${fmt(n.maxValue)} | ${fmt(n.threshold)} | ${n.count} |`,
            );
          }
        }
        L.push('');
      }
    }
  }

  // False positives on negative/static takes.
  const fps = a.takes.filter((t) => t.falsePositives.length > 0);
  if (fps.length > 0) {
    L.push('## False positives on negative / static takes', '');
    L.push('| take | t (ms) | move | hand | kind | wristSpeed | bboxGrowth | elbowVel | fist | palm | grip |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const t of fps) {
      for (const f of t.falsePositives) {
        L.push(
          `| ${t.id}#${t.takeIndex} | ${fmt(f.t, 0)} | ${f.move} | ${f.hand} | ${f.kind} | ` +
            `${fmt(f.signals.wristSpeed)} | ${fmt(f.signals.bboxGrowth)} | ` +
            `${fmt(f.signals.elbowVel)} | ${fmt(f.signals.fist)} | ` +
            `${fmt(f.signals.palm)} | ${fmt(f.signals.grip)} |`,
        );
      }
    }
    L.push('');
  }

  // SNR.
  const withSnr = a.takes.filter((t) => t.snr.length > 0 && t.repsUsed > 0);
  if (withSnr.length > 0) {
    L.push('## Signal-to-noise per move', '');
    L.push(`In-rep peak median vs the noise pool 95th percentile.`, '');
    L.push(`Noise pool: ${a.noiseProvenance || 'negative takes'}.`, '');
    L.push('| take | rep source | signal | peak median (in rep) | noise p95 | ratio |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const t of withSnr) {
      for (const row of t.snr) {
        L.push(
          `| ${t.id}#${t.takeIndex} | ${t.autoReps ? 'AUTO-PEAK' : 'confirmed'} | ` +
            `${row.signal} | ${fmt(row.peakMedian)} | ` +
            `${fmt(row.noiseP95)} | ${row.ratio === Infinity ? 'inf' : fmt(row.ratio, 2)} |`,
        );
      }
    }
    L.push('');
  }

  // Palm comparison.
  const palmTakes = a.takes.filter((t) => t.palmCompare);
  if (palmTakes.length > 0) {
    L.push('## Static palm hold: palmScore (3D) vs palmScore2D (live scorer)', '');
    L.push(
      'palmScore2D is the LIVE scorer since the HaGRID investigation (see',
      'docs/hagrid-report.md appendix). Since the 7-move simplification no',
      'MOVE reads either scorer; this comparison remains the player-data',
      'verdict on the 2D switch for the studio and any future palm use.',
      '',
    );
    L.push('| take | scorer | hands scored | p5 | median | p95 | frames > 0.75 | frames > 0.55 |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const t of palmTakes) {
      const c = t.palmCompare;
      if (!c) continue;
      L.push(
        `| ${t.id}#${t.takeIndex} | palmScore (3D) | ${c.frames} | ${fmt(c.score3D.p5)} | ` +
          `${fmt(c.score3D.median)} | ${fmt(c.score3D.p95)} | ${c.score3D.above75} | ${c.score3D.above55} |`,
      );
      L.push(
        `| ${t.id}#${t.takeIndex} | palmScore2D (live) | ${c.frames} | ${fmt(c.score2D.p5)} | ` +
          `${fmt(c.score2D.median)} | ${fmt(c.score2D.p95)} | ${c.score2D.above75} | ${c.score2D.above55} |`,
      );
    }
    L.push('');
  }

  // Proposals.
  L.push('## Threshold proposals (max-margin separators)', '');
  if (a.proposals.length === 0) {
    L.push('No proposals: no rep windows with usable signals were found.', '');
  } else {
    L.push(
      'For each motion threshold: the midpoint between the loudest noise-pool',
      'value and the quietest rep-window peak above it. Reps whose peak falls',
      'at or below the proposal are listed as still-missing, not hidden.',
      'Fractions are relative to the profile the export carried.',
      '',
    );
    L.push(`**Noise pool provenance: ${a.noiseProvenance || 'negative takes'}.**`, '');
    if (a.autoPeakUsed) {
      L.push('**Rep peaks come from AUTO-PEAK windows (see banner above).**', '');
    }
    L.push('| threshold | signal | current | proposed | margin | rep peaks (min..med..max) | noise max | reps still missing | implied fraction |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const p of a.proposals) {
      const peaks = `${fmt(Math.min(...p.repPeaks))}..${fmt(median(p.repPeaks))}..${fmt(Math.max(...p.repPeaks))}`;
      const frac = p.fraction
        ? `${p.fraction.constant}: ${fmt(p.fraction.implied, 3)} (now ${fmt(p.fraction.current, 2)}, peak ${p.fraction.profilePeakName}=${fmt(p.fraction.profilePeak, 2)})`
        : 'no separation found';
      L.push(
        `| ${p.name} | ${p.signal} | ${fmt(p.current)} | ${fmt(p.threshold)} | ${fmt(p.margin)} | ` +
          `${peaks} | ${fmt(p.noiseMax)} | ${p.missingReps}/${p.repPeaks.length} | ${frac} |`,
      );
    }
    L.push('');
  }
  L.push(
    '**PROPOSALS ARE NOT APPLIED AUTOMATICALLY.** Review the tables above',
    'against the recording, then change the constants in',
    '`src/gestures/profile.ts` / `src/gestures/moves.ts` by hand (the',
    'orchestrator applies them once the user\'s recorded data supports them).',
    a.synthetic
      ? '\n**THIS RUN WAS SYNTHETIC: applying anything from it is forbidden.**'
      : '',
    '',
  );

  return L.join('\n');
}

export function summarize(a: DrillAnalysis): string {
  const L: string[] = [];
  if (a.synthetic) L.push('*** SYNTHETIC INPUT - numbers unusable for tuning ***');
  if (a.lowFpsTakes.length > 0) {
    L.push(
      `*** CAPTURE RATE HARD GATE: ${a.lowFpsTakes.length} take(s) under ` +
        `${TARGET_CAPTURE_FPS} fps: ${a.lowFpsTakes.join(', ')}`,
    );
    L.push('*** Every number derived from those takes is INVALID for tuning.');
  }
  if (a.autoPeakUsed) {
    L.push('*** AUTO-PEAK REP WINDOWS IN USE: zero confirmed markers found on');
    L.push('*** one or more takes; windows are machine-detected, not reviewed.');
  }
  L.push(`Analyzed ${a.takes.length} takes from ${a.sourcePath}`);
  for (const t of a.takes) {
    if (t.kind === 'positive') {
      const firedInRep = t.reps.reduce((s, r) => s + r.fired, 0);
      const misses = t.reps.filter((r) => r.miss).length;
      L.push(
        `  ${t.id}#${t.takeIndex} -> ${t.move ?? '?'}` +
          `${t.mappedFrom !== undefined ? ` (was ${t.mappedFrom})` : ''}: ` +
          `${t.repsUsed} reps${t.autoReps ? ' [AUTO-PEAK]' : ''}, ` +
          `${firedInRep} fired in-rep, ${misses} missed` +
          (misses > 0
            ? ` (blocked by: ${t.reps
                .filter((r) => r.miss)
                .flatMap((r) => r.blockers.map((b) => `${b.signal} short ${fmt(b.deficit, 2)}`))
                .join('; ') || 'timing, see report'})`
            : ''),
      );
    } else {
      L.push(
        `  ${t.id}#${t.takeIndex}: ${t.kind}, ${t.falsePositives.length} false positives` +
          (t.palmCompare
            ? `; palm 3D>0.75 ${t.palmCompare.score3D.above75}/${t.palmCompare.frames} vs 2D ${t.palmCompare.score2D.above75}/${t.palmCompare.frames}`
            : ''),
      );
    }
  }
  L.push('Per-move hit rates:');
  for (const row of a.moveSummary) {
    L.push(
      `  ${row.move}: ${row.firedInRep}/${row.reps} in-rep (${pct(row.hitRate)}), ` +
        `${row.fpOutOfRep} FP out-of-rep, ${row.crossInRep} cross-fires`,
    );
  }
  L.push(`  ${a.proposals.length} threshold proposals (see docs/drill-report.md)`);
  L.push(`  Noise pool: ${a.noiseProvenance || 'negative takes'}`);
  L.push('  Proposals are NOT auto-applied; apply only after review with real data.');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function newestExportPath(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => /^firebending-drill-.*\.json$/.test(f))
    .map((f) => join(dir, f));
  if (files.length === 0) return null;
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

function main(): void {
  const arg = process.argv[2];
  const path = arg ?? newestExportPath(join(ROOT, 'fixtures', 'recorded'));
  if (path === null || !existsSync(path)) {
    console.log(
      'No recorded export found (fixtures/recorded/firebending-drill-*.json).\n' +
        'Record the drill board in the studio (npm run studio), export it,\n' +
        'drop the JSON into fixtures/recorded/, then re-run npm run analyze.\n' +
        'Pipeline documentation: docs/drill-report.md.',
    );
    return;
  }
  const exp = JSON.parse(readFileSync(path, 'utf8')) as StudioExport;
  if (exp.version !== 1) {
    throw new Error(`unsupported export version ${String(exp.version)} in ${path}`);
  }
  const analysis = analyzeExport(exp, path);
  const report = buildReport(analysis);
  const reportPath = join(ROOT, 'docs', 'drill-report.md');
  writeFileSync(reportPath, report);
  console.log(summarize(analysis));
  console.log(`\nFull report written to ${reportPath}`);
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
