/**
 * Score the real pose classifiers against HaGRID hand-landmark fixtures and
 * sweep decision thresholds.
 *
 * Run: npx tsx tools/hagrid/analyze.ts [--set NAME=value ...]
 *
 * Loads fixtures/hagrid/<class>.json (or the larger analysis set from
 * $HAGRID_CACHE/analysis when present), computes score distributions per
 * class for fistScore / palmScore / gripScore, and prints precision/recall
 * sweeps against the negative suite. `--set` overrides a tuning constant in
 * the parametrized re-implementation so candidate constants can be tried
 * without editing poses.ts; with no overrides the parametrized scorers are
 * parity-checked against the real ones (single source of truth).
 *
 * Grip caveat: HaGRID stills place hands anywhere in the frame, so the
 * raised-wrist factor is neutralized by translating each hand so the wrist
 * sits at y = 0.5 before scoring (shape-only evaluation). The raised-y band
 * cannot be tuned from stills.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fistScore,
  palmScore,
  gripScore,
  smoothstep,
  clamp01,
  dist,
  sub,
  cross,
  normalize,
  lm,
  handScale,
  FIST_CURL_FULL_RATIO,
  FIST_CURL_NONE_RATIO,
  PALM_EXT_NONE_RATIO,
  PALM_EXT_FULL_RATIO,
  PALM_GAP_TIGHT,
  PALM_GAP_SPREAD,
  PALM_FACING_MIN,
  PALM_FACING_FULL,
  GRIP_THUMB_NEAR,
  GRIP_THUMB_FAR,
  GRIP_THUMB_RISE_MIN,
  GRIP_THUMB_RISE_FULL,
} from '../../src/gestures/poses';
import type { Handedness } from '../../src/gestures/poses';
import type { HandFrame } from '../../src/tracking/types';
import { LM } from '../../src/tracking/types';

interface Sample {
  hand: HandFrame;
  handedness: Handedness;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadClasses(): Map<string, Sample[]> {
  const cacheDir = process.env['HAGRID_CACHE'];
  let dir = join(ROOT, 'fixtures', 'hagrid');
  if (cacheDir && existsSync(join(cacheDir, 'analysis'))) {
    dir = join(cacheDir, 'analysis');
  }
  console.log(`# loading from ${dir}`);
  const classes = new Map<string, Sample[]>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Array<{
      landmarks: Array<{ x: number; y: number; z: number }>;
      confidence: number;
      handedness: Handedness;
    }>;
    classes.set(
      f.replace(/\.json$/, ''),
      raw.map((r) => ({
        hand: { landmarks: r.landmarks, confidence: r.confidence },
        handedness: r.handedness,
      }))
    );
  }
  return classes;
}

// ---------------------------------------------------------------------------
// Parametrized scorers (must mirror poses.ts exactly; parity-checked below)
// ---------------------------------------------------------------------------

const C = {
  FIST_CURL_FULL_RATIO,
  FIST_CURL_NONE_RATIO,
  PALM_EXT_NONE_RATIO,
  PALM_EXT_FULL_RATIO,
  PALM_GAP_TIGHT,
  PALM_GAP_SPREAD,
  PALM_FACING_MIN,
  PALM_FACING_FULL,
  GRIP_THUMB_NEAR,
  GRIP_THUMB_FAR,
  GRIP_THUMB_RISE_MIN,
  GRIP_THUMB_RISE_FULL,
};
type Consts = typeof C;

const FINGERS: ReadonlyArray<readonly [number, number]> = [
  [LM.INDEX_MCP, LM.INDEX_TIP],
  [LM.MIDDLE_MCP, LM.MIDDLE_TIP],
  [LM.RING_MCP, LM.RING_TIP],
  [LM.PINKY_MCP, LM.PINKY_TIP],
];

function fingerRatio(hand: HandFrame, mcp: number, tip: number): number | null {
  const wrist = lm(hand, LM.WRIST);
  const mcpDist = dist(lm(hand, mcp), wrist);
  if (mcpDist < 1e-6) return null;
  return dist(lm(hand, tip), wrist) / mcpDist;
}

function pFist(hand: HandFrame, c: Consts): number {
  let sum = 0;
  for (const [mcp, tip] of FINGERS) {
    const r = fingerRatio(hand, mcp, tip);
    if (r === null) continue;
    sum += 1 - smoothstep(c.FIST_CURL_FULL_RATIO, c.FIST_CURL_NONE_RATIO, r);
  }
  return clamp01(sum / FINGERS.length);
}

function pPalm(hand: HandFrame, handedness: Handedness, c: Consts): number {
  const s = handScale(hand);
  if (s < 1e-6) return 0;
  let extSum = 0;
  for (const [mcp, tip] of FINGERS) {
    const r = fingerRatio(hand, mcp, tip);
    if (r === null) continue;
    extSum += smoothstep(c.PALM_EXT_NONE_RATIO, c.PALM_EXT_FULL_RATIO, r);
  }
  const extension = extSum / FINGERS.length;
  const tips = [LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];
  let gapSum = 0;
  for (let i = 0; i + 1 < tips.length; i++) {
    gapSum += dist(lm(hand, tips[i]!), lm(hand, tips[i + 1]!)) / s;
  }
  const meanGap = gapSum / 3;
  const together = 1 - smoothstep(c.PALM_GAP_TIGHT, c.PALM_GAP_SPREAD, meanGap);
  const wrist = lm(hand, LM.WRIST);
  const u = sub(lm(hand, LM.INDEX_MCP), wrist);
  const v = sub(lm(hand, LM.PINKY_MCP), wrist);
  const normal = normalize(cross(u, v));
  const towardCameraZ = handedness === 'right' ? normal.z : -normal.z;
  const facing = smoothstep(c.PALM_FACING_MIN, c.PALM_FACING_FULL, towardCameraZ);
  return clamp01(extension * together * facing);
}

function pGrip(hand: HandFrame, c: Consts): number {
  const s = handScale(hand);
  if (s < 1e-6) return 0;
  const curl = pFist(hand, c);
  const thumbTip = lm(hand, LM.THUMB_TIP);
  const dNear =
    Math.min(
      dist(thumbTip, lm(hand, LM.INDEX_PIP)),
      dist(thumbTip, lm(hand, LM.INDEX_MCP))
    ) / s;
  const thumbNear = 1 - smoothstep(c.GRIP_THUMB_NEAR, c.GRIP_THUMB_FAR, dNear);
  const rise = (lm(hand, LM.THUMB_MCP).y - thumbTip.y) / s;
  const thumbUp = smoothstep(c.GRIP_THUMB_RISE_MIN, c.GRIP_THUMB_RISE_FULL, rise);
  // Raised factor neutralized: wrist translated to y=0.5 by the caller.
  return clamp01(curl * thumbNear * thumbUp);
}

/** Translate a hand so its wrist y is 0.5 (neutralizes grip's raised band). */
function atNeutralY(hand: HandFrame): HandFrame {
  const dy = 0.5 - hand.landmarks[0]!.y;
  return {
    landmarks: hand.landmarks.map((p) => ({ x: p.x, y: p.y + dy, z: p.z })),
    confidence: hand.confidence,
  };
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i]!;
}

function fmtDist(scores: number[]): string {
  const s = [...scores].sort((a, b) => a - b);
  return [0.05, 0.25, 0.5, 0.75, 0.95]
    .map((q) => pct(s, q).toFixed(3))
    .join(' ');
}

interface PR {
  t: number;
  precision: number;
  recall: number;
}

/**
 * Threshold semantics match Hysteresis.update: a frame counts toward entry
 * when score > t (strict). Saturated ties (e.g. a 3-of-4-curled hand at
 * exactly 0.75 on fist) therefore do NOT fire.
 */
function prAt(pos: number[], neg: number[], t: number): PR {
  const tp = pos.filter((x) => x > t).length;
  const fp = neg.filter((x) => x > t).length;
  return {
    t,
    precision: tp + fp > 0 ? tp / (tp + fp) : 1,
    recall: tp / pos.length,
  };
}

function sweep(pos: number[], neg: number[]): PR[] {
  const out: PR[] = [];
  for (let t = 0.05; t <= 0.96; t += 0.05) {
    out.push(prAt(pos, neg, t));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const overrides: Partial<Record<keyof Consts, number>> = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--set') {
    const [name, val] = (process.argv[++i] ?? '').split('=');
    if (name && val !== undefined && name in C) {
      overrides[name as keyof Consts] = Number(val);
    } else {
      throw new Error(`bad --set ${process.argv[i]}`);
    }
  }
}
const c: Consts = { ...C, ...overrides };
const hasOverrides = Object.keys(overrides).length > 0;
if (hasOverrides) console.log('# overrides:', JSON.stringify(overrides));

const classes = loadClasses();
const names = [...classes.keys()].sort();

// Parity check: parametrized scorers must match the real ones exactly when
// no overrides are applied.
{
  let checked = 0;
  for (const [, samples] of classes) {
    for (const s of samples.slice(0, 50)) {
      const n = atNeutralY(s.hand);
      const f = Math.abs(pFist(s.hand, C) - fistScore(s.hand));
      const p = Math.abs(
        pPalm(s.hand, s.handedness, C) - palmScore(s.hand, s.handedness)
      );
      const g = Math.abs(pGrip(n, C) - gripScore(n));
      if (f > 1e-12 || p > 1e-12 || g > 1e-12) {
        throw new Error(`parity failure: fist=${f} palm=${p} grip=${g}`);
      }
      checked++;
    }
  }
  console.log(`# parity check ok on ${checked} samples`);
}

// Handedness/mirroring validation on open-palm classes: the facing normal z
// (signed toward camera) must be predominantly positive.
{
  for (const cls of ['stop', 'palm']) {
    const samples = classes.get(cls) ?? [];
    let posCount = 0;
    for (const s of samples) {
      const wrist = lm(s.hand, LM.WRIST);
      const u = sub(lm(s.hand, LM.INDEX_MCP), wrist);
      const v = sub(lm(s.hand, LM.PINKY_MCP), wrist);
      const z = normalize(cross(u, v)).z;
      const toward = s.handedness === 'right' ? z : -z;
      if (toward > 0) posCount++;
    }
    console.log(
      `# facing validation ${cls}: ${posCount}/${samples.length} positive ` +
        `(${((100 * posCount) / Math.max(1, samples.length)).toFixed(1)}%)`
    );
  }
}

// Score every class under every scorer.
const fistS = new Map<string, number[]>();
const palmS = new Map<string, number[]>();
const gripS = new Map<string, number[]>();
for (const cls of names) {
  const samples = classes.get(cls)!;
  fistS.set(cls, samples.map((s) => pFist(s.hand, c)));
  palmS.set(cls, samples.map((s) => pPalm(s.hand, s.handedness, c)));
  gripS.set(cls, samples.map((s) => pGrip(atNeutralY(s.hand), c)));
}

console.log('\n# score distributions (p5 p25 p50 p75 p95)');
console.log('class            fist                      palm                      grip(shape)');
for (const cls of names) {
  console.log(
    `${cls.padEnd(15)} ${fmtDist(fistS.get(cls)!)}   ${fmtDist(palmS.get(cls)!)}   ${fmtDist(gripS.get(cls)!)}`
  );
}

// Negative suite per the retuning brief.
const NEG_SUITE = [
  'no_gesture',
  'ok',
  'one',
  'peace',
  'four',
  'rock',
  'call',
  'dislike',
  'stop_inverted',
  'mute',
];

function collect(map: Map<string, number[]>, list: string[]): number[] {
  return list.flatMap((cls) => map.get(cls) ?? []);
}

interface PoseEval {
  label: string;
  pos: number[];
  neg: number[];
  extra?: Array<[string, number[]]>;
}

console.log('\n# per-class counts above operating thresholds');
console.log('class            fist>.75  palm>.75  grip>.45  grip>.60  grip>.75');
for (const cls of names) {
  const n = (m: Map<string, number[]>, t: number) =>
    m.get(cls)!.filter((x) => x > t).length;
  console.log(
    `${cls.padEnd(15)}  ${String(n(fistS, 0.75)).padStart(4)}      ` +
      `${String(n(palmS, 0.75)).padStart(4)}      ${String(n(gripS, 0.45)).padStart(4)}      ` +
      `${String(n(gripS, 0.6)).padStart(4)}      ${String(n(gripS, 0.75)).padStart(4)}`
  );
}

const evals: PoseEval[] = [
  {
    label: 'fist (pos=fist; like/dislike reported separately as thumb-variant fists)',
    pos: fistS.get('fist')!,
    neg: collect(
      fistS,
      NEG_SUITE.filter((n) => n !== 'dislike')
    ),
    extra: [
      ['dislike', fistS.get('dislike')!],
      ['like', fistS.get('like')!],
    ],
  },
  {
    label: 'fist strict (dislike included in negatives)',
    pos: fistS.get('fist')!,
    neg: collect(fistS, NEG_SUITE),
  },
  {
    label: 'palm (pos=palm+stop)',
    pos: [...palmS.get('palm')!, ...palmS.get('stop')!],
    neg: collect(palmS, NEG_SUITE),
  },
  {
    label: 'grip shape (pos=like; suite negatives)',
    pos: gripS.get('like')!,
    neg: collect(gripS, NEG_SUITE),
    extra: [
      ['fist', gripS.get('fist')!],
      ['dislike', gripS.get('dislike')!],
    ],
  },
  {
    label: 'grip shape strict (negatives = suite + fist + palm + stop)',
    pos: gripS.get('like')!,
    neg: collect(gripS, [...NEG_SUITE, 'fist', 'palm', 'stop']),
  },
];

for (const e of evals) {
  console.log(`\n# ${e.label}`);
  console.log('  t    precision recall');
  for (const { t, precision, recall } of sweep(e.pos, e.neg)) {
    console.log(`  ${t.toFixed(2)} ${precision.toFixed(4)}   ${recall.toFixed(4)}`);
  }
  // Operating points of interest (0.75/0.55 standard enter/exit,
  // 0.45/0.28 grip's current enter/exit in moves.ts).
  for (const t of [0.28, 0.45, 0.55, 0.75, 0.85]) {
    const { precision, recall } = prAt(e.pos, e.neg, t);
    console.log(
      `  at t=${t.toFixed(2)}: precision=${precision.toFixed(4)} recall=${recall.toFixed(4)}`
    );
  }
  if (e.extra) {
    for (const [name, scores] of e.extra) {
      const over45 = scores.filter((x) => x > 0.45).length;
      const over55 = scores.filter((x) => x > 0.55).length;
      const over75 = scores.filter((x) => x > 0.75).length;
      console.log(
        `  ${name}: ${over45}/${scores.length} > 0.45, ` +
          `${over55}/${scores.length} > 0.55, ${over75}/${scores.length} > 0.75`
      );
    }
  }
}
