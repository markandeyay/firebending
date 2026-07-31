/**
 * Drill-export analysis pipeline (Round 3 Phase 4f).
 *
 * Run: npm run analyze [path-to-export.json]
 *
 * Ingests the newest fixtures/recorded/firebending-drill-*.json (or the
 * given path), replays every take's trimmed frames through a REAL MoveEngine
 * configured with the take's exported thresholds (MoveEngineConfig.thresholds
 * bypasses profile derivation, so the replay runs under the exact values the
 * capture ran under), and reports:
 *
 * - per positive take: confirmed reps vs fired events inside each confirmed
 *   rep window (+REP_SLACK_MS), and for each MISS which gating signal
 *   blocked it and by how much (per-rep maxima from the exported signals,
 *   cross-checked against the engine's near-miss diagnostics captured via
 *   MoveEngine.nearMissListener);
 * - per negative take: every fired event as a false positive with its
 *   timestamp and the triggering frame's signal values;
 * - signal-to-noise per gating signal per move: median in-rep peak vs the
 *   95th percentile of the out-of-rep + negative-take noise pool;
 * - THRESHOLD PROPOSALS: per motion threshold, the value that separates
 *   confirmed-rep peaks from negative-take noise with maximum margin,
 *   expressed also as the implied profile fraction (JAB_TRIGGER_FRACTION /
 *   SWEEP_FRACTION, src/gestures/profile.ts);
 * - the palm-static take scored by BOTH palm scorers (legacy 3D palmScore
 *   and the live palmScore2D) so the user's own recording gives the final
 *   live verdict on the 2D switch (docs/hagrid-report.md appendix).
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
import { MoveEngine, GRIP_ENTER_SCORE } from '../src/gestures/moves';
import type { MoveEvent, MoveName, NearMissRecord } from '../src/gestures/moves';
import { DEFAULT_PROFILE } from '../src/gestures/profile';
import type { MotionProfile, MotionThresholds } from '../src/gestures/profile';
import { palmScore, palmScore2D } from '../src/gestures/poses';
import type { Handedness } from '../src/gestures/poses';
import type {
  StudioExport,
  StudioFrame,
  StudioSideSignals,
  StudioTakeExport,
  TakeId,
} from '../src/studio/exportSchema';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Slack added to the end of each confirmed rep window when counting fires. */
export const REP_SLACK_MS = 150;
/** Standard pose hysteresis enter level (tracking/filters.ts default). */
const POSE_ENTER = 0.75;

// ---------------------------------------------------------------------------
// Take expectations
// ---------------------------------------------------------------------------

export type TakeKind = 'positive' | 'negative' | 'static-palm';

export interface TakeExpectation {
  kind: TakeKind;
  /** Expected move for positive takes. */
  move?: MoveName;
  /** Event kinds that count as a fire (trigger vs sustain-start). */
  eventKinds?: ReadonlyArray<MoveEvent['kind']>;
}

export const EXPECTATIONS: Record<TakeId, TakeExpectation> = {
  'jab-left-x5': { kind: 'positive', move: 'jab-blast', eventKinds: ['trigger'] },
  'jab-right-x5': { kind: 'positive', move: 'jab-blast', eventKinds: ['trigger'] },
  'alt-jab-combo-x3': { kind: 'positive', move: 'cross-combo', eventKinds: ['trigger'] },
  'palm-strike-left-x5': { kind: 'positive', move: 'palm-wave', eventKinds: ['trigger'] },
  'palm-strike-right-x5': { kind: 'positive', move: 'palm-wave', eventKinds: ['trigger'] },
  'palm-static-5s': { kind: 'static-palm' },
  'fire-stream-4s-x2': {
    kind: 'positive',
    move: 'fire-stream',
    eventKinds: ['sustain-start'],
  },
  'flame-fan-4s-x2': { kind: 'positive', move: 'flame-fan', eventKinds: ['sustain-start'] },
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

const THRUST_GATES = (pose: 'fist' | 'palm'): Gate[] => [
  { signal: pose, thresholdOf: () => POSE_ENTER },
  { signal: 'elbowVel', thresholdOf: (th) => th.elbowExtendVel, needsPose: true },
  { signal: 'wristSpeed', thresholdOf: (th) => th.spikeSpeed },
  { signal: 'bboxGrowth', thresholdOf: (th) => th.spikeGrowth },
];

export const MOVE_GATES: Record<MoveName, Gate[]> = {
  'jab-blast': THRUST_GATES('fist'),
  'cross-combo': THRUST_GATES('fist'),
  'fire-stream': THRUST_GATES('fist'),
  'twin-cannon': THRUST_GATES('fist'),
  'palm-wave': THRUST_GATES('palm'),
  'flame-fan': THRUST_GATES('palm'),
  'rising-flame': [
    { signal: 'palm', thresholdOf: () => POSE_ENTER },
    { signal: 'upVel', thresholdOf: (th) => th.risingUpVel },
  ],
  'fire-whip': [
    { signal: 'grip', thresholdOf: () => GRIP_ENTER_SCORE },
    { signal: 'swingVx', thresholdOf: (th) => th.whipSwingVx },
  ],
  'breath-charge': [{ signal: 'fist', thresholdOf: () => POSE_ENTER }],
};

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayResult {
  events: MoveEvent[];
  nearMisses: NearMissRecord[];
}

/**
 * Replay a take's trimmed frames through a real MoveEngine under the take's
 * exported thresholds, with near-miss diagnostics captured in full via the
 * engine's nearMissListener (the 8-slot HUD ring would drop records).
 */
export function replayTake(take: StudioTakeExport, profile: MotionProfile | null): ReplayResult {
  const engine = new MoveEngine({
    profile: profile ?? undefined,
    thresholds: take.thresholds,
  });
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
  /** Median of per-confirmed-rep in-window peaks. */
  peakMedian: number;
  /** 95th percentile of the out-of-rep + negative-take noise pool. */
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

export interface TakeAnalysis {
  id: TakeId;
  takeIndex: number;
  starred: boolean;
  status: string;
  kind: TakeKind;
  move?: MoveName;
  hasPose: boolean;
  repsConfirmed: number;
  /** Expected-move fires anywhere in the take (positive takes). */
  totalFired: number;
  reps: RepResult[];
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
  /** Confirmed reps whose peak sits at or below the proposed threshold. */
  missingReps: number;
  current: number;
  fraction: FractionProposal | null;
}

export interface DrillAnalysis {
  sourcePath: string;
  synthetic: boolean;
  exportedAt: string;
  profileSource: 'export' | 'default';
  takes: TakeAnalysis[];
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
  return t >= startMs && t <= endMs + REP_SLACK_MS;
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

export function analyzeTake(
  take: StudioTakeExport,
  profile: MotionProfile | null,
): TakeAnalysis {
  const exp = EXPECTATIONS[take.id] ?? { kind: 'positive' as const };
  const hands = relevantHands(take.id);
  const hasPose = take.frames.some((f) => f.pose !== null);
  const { events, nearMisses } = replayTake(take, profile);
  const confirmed = take.reps.filter((r) => r.confirmed);

  const base: TakeAnalysis = {
    id: take.id,
    takeIndex: take.takeIndex,
    starred: take.starred,
    status: take.status,
    kind: exp.kind,
    hasPose,
    repsConfirmed: confirmed.length,
    totalFired: 0,
    reps: [],
    falsePositives: [],
    snr: [],
  };
  if (exp.move) base.move = exp.move;

  if (exp.kind === 'negative' || exp.kind === 'static-palm') {
    // Every fired event on a negative (or the static-palm hold) is a false
    // positive; report it with the triggering frame's signal values.
    for (const e of events) {
      if (e.kind !== 'trigger' && e.kind !== 'sustain-start') continue;
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

  base.reps = confirmed.map((rep, index) => {
    const inRep = fired.filter((e) => inWindow(e.t, rep.startMs, rep.endMs));
    const miss = inRep.length === 0;
    const blockers: Blocker[] = [];
    const nm: NearMissSummary[] = [];
    if (miss) {
      const repFrames = take.frames.filter((f) => inWindow(f.t, rep.startMs, rep.endMs));
      for (const g of activeGates) {
        const threshold = g.thresholdOf(take.thresholds);
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
      manual: rep.manual,
      fired: inRep.length,
      miss,
      blockers,
      nearMisses: nm,
    };
  });

  // Signal-to-noise: per gate signal, median in-rep peak vs p95 of the
  // out-of-rep frames of this take (negative-take noise is appended by the
  // caller via appendNoise below when building the full analysis).
  base.snr = activeGates.map((g) => {
    const peaks: number[] = [];
    for (const rep of confirmed) {
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
      const inAnyRep = confirmed.some((r) => inWindow(f.t, r.startMs, r.endMs));
      if (!inAnyRep) noise.push(frameSignalMax(f, hands, g.signal));
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

/** Per-frame signal values across all frames of the given takes (both hands). */
function noisePool(takes: StudioTakeExport[], sig: SignalName): number[] {
  const out: number[] = [];
  for (const t of takes) {
    for (const f of t.frames) {
      out.push(frameSignalMax(f, ['left', 'right'], sig));
    }
  }
  return out;
}

/** Per-confirmed-rep peaks of a signal across the given takes. */
function repPeaks(takes: StudioTakeExport[], sig: SignalName): number[] {
  const out: number[] = [];
  for (const t of takes) {
    const hands = relevantHands(t.id);
    for (const rep of t.reps) {
      if (!rep.confirmed) continue;
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
 * Max-margin separator between confirmed-rep peaks and negative noise: the
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

export function buildProposals(exp: StudioExport): Proposal[] {
  const profile = exp.meta.motionProfile ?? DEFAULT_PROFILE;
  const negatives = exp.takes.filter((t) => EXPECTATIONS[t.id]?.kind === 'negative');
  const out: Proposal[] = [];
  for (const spec of PROPOSAL_SPECS) {
    const takes = exp.takes.filter((t) => spec.takeIds.includes(t.id));
    if (spec.needsPose === true) {
      // Elbow velocity is meaningless without body pose in the recording.
      const withPose = takes.filter((t) => t.frames.some((f) => f.pose !== null));
      if (withPose.length === 0) continue;
    }
    const peaks = repPeaks(takes, spec.signal);
    if (peaks.length === 0) continue;
    const noise = noisePool(negatives, spec.signal);
    const sep = proposeSeparator(peaks, noise);
    const currentTh = takes[0]?.thresholds[spec.name] ?? NaN;
    out.push({
      name: spec.name,
      signal: spec.signal,
      repPeaks: peaks,
      noiseMax: sep.noiseMax,
      threshold: sep.threshold,
      margin: sep.margin,
      missingReps: sep.missingReps,
      current: currentTh,
      fraction: sep.threshold !== null ? spec.fraction(profile, sep.threshold) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full analysis
// ---------------------------------------------------------------------------

export function analyzeExport(exp: StudioExport, sourcePath: string): DrillAnalysis {
  const profile = exp.meta.motionProfile;
  const takes = exp.takes.map((t) => analyzeTake(t, profile));

  // Fold the negative takes into every positive take's noise floor: the
  // reported noise p95 is over out-of-rep frames of the take itself PLUS
  // every frame of every negative take.
  const negatives = exp.takes.filter((t) => EXPECTATIONS[t.id]?.kind === 'negative');
  for (const ta of takes) {
    if (ta.kind !== 'positive') continue;
    const src = exp.takes.find((t) => t.id === ta.id && t.takeIndex === ta.takeIndex);
    if (!src) continue;
    const confirmed = src.reps.filter((r) => r.confirmed);
    ta.snr = ta.snr.map((row) => {
      const noise: number[] = [];
      const hands = relevantHands(src.id);
      for (const f of src.frames) {
        const inAnyRep = confirmed.some((r) => inWindow(f.t, r.startMs, r.endMs));
        if (!inAnyRep) noise.push(frameSignalMax(f, hands, row.signal));
      }
      for (const n of negatives) noise.push(...noisePool([n], row.signal));
      const noiseP95 = percentile(noise, 0.95);
      return {
        ...row,
        noiseP95,
        ratio: noiseP95 > 0 ? row.peakMedian / noiseP95 : Infinity,
      };
    });
  }

  return {
    sourcePath,
    synthetic: exp.meta.synthetic === true,
    exportedAt: exp.exportedAt,
    profileSource: profile !== null ? 'export' : 'default',
    takes,
    proposals: buildProposals(exp),
  };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

const fmt = (x: number | null | undefined, digits = 3): string =>
  x === null || x === undefined || Number.isNaN(x) ? 'n/a' : x.toFixed(digits);

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
  L.push(syntheticBanner(a));

  L.push('## Takes: reps confirmed vs fired', '');
  L.push('| take | status | starred | pose | reps confirmed | fired in-rep | misses | false positives |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const t of a.takes) {
    const firedInRep = t.reps.reduce((s, r) => s + r.fired, 0);
    const misses = t.reps.filter((r) => r.miss).length;
    L.push(
      `| ${t.id}#${t.takeIndex} | ${t.status} | ${t.starred ? 'yes' : ''} | ${t.hasPose ? 'yes' : 'no'} | ` +
        `${t.kind === 'positive' ? t.repsConfirmed : '-'} | ` +
        `${t.kind === 'positive' ? firedInRep : '-'} | ` +
        `${t.kind === 'positive' ? misses : '-'} | ` +
        `${t.kind !== 'positive' ? t.falsePositives.length : '-'} |`,
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
            `(${fmt(r.startMs, 0)}..${fmt(r.endMs, 0)} ms${r.manual ? ', manual marker' : ''})`,
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

  // False positives.
  const fps = a.takes.filter((t) => t.falsePositives.length > 0);
  if (fps.length > 0) {
    L.push('## False positives on negative takes', '');
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
  const withSnr = a.takes.filter((t) => t.snr.length > 0 && t.repsConfirmed > 0);
  if (withSnr.length > 0) {
    L.push('## Signal-to-noise per move', '');
    L.push('In-rep peak median vs out-of-rep + negative-take 95th percentile.', '');
    L.push('| take | signal | peak median (in rep) | noise p95 | ratio |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const t of withSnr) {
      for (const row of t.snr) {
        L.push(
          `| ${t.id}#${t.takeIndex} | ${row.signal} | ${fmt(row.peakMedian)} | ` +
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
      'docs/hagrid-report.md appendix): equal recall, better precision on',
      'HaGRID, and no dependence on MediaPipe z. This section is the final,',
      'player-data verdict: if the 2D column does not hold clearly more',
      'frames above the 0.75 enter level on the static-palm take, the switch',
      'must be re-reviewed.',
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
    L.push('No proposals: no confirmed reps with usable signals were found.', '');
  } else {
    L.push(
      'For each motion threshold: the midpoint between the loudest negative-',
      'take noise and the quietest confirmed-rep peak above it. Reps whose',
      'peak falls at or below the proposal are listed as still-missing, not',
      'hidden. Fractions are relative to the profile the export carried.',
      '',
    );
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
  L.push(`Analyzed ${a.takes.length} takes from ${a.sourcePath}`);
  for (const t of a.takes) {
    if (t.kind === 'positive') {
      const firedInRep = t.reps.reduce((s, r) => s + r.fired, 0);
      const misses = t.reps.filter((r) => r.miss).length;
      L.push(
        `  ${t.id}#${t.takeIndex}: ${t.repsConfirmed} reps confirmed, ` +
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
  L.push(`  ${a.proposals.length} threshold proposals (see docs/drill-report.md)`);
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
