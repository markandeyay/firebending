/**
 * Dump raw feature distributions per HaGRID class: the quantities the pose
 * scorers smoothstep over. Used to pick tuning-constant edges in poses.ts.
 *
 * Run: npx tsx tools/hagrid/features.ts
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dist,
  sub,
  cross,
  normalize,
  lm,
  handScale,
} from '../../src/gestures/poses';
import type { Handedness } from '../../src/gestures/poses';
import type { HandFrame } from '../../src/tracking/types';
import { LM } from '../../src/tracking/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadDir(): string {
  const cacheDir = process.env['HAGRID_CACHE'];
  if (cacheDir && existsSync(join(cacheDir, 'analysis'))) {
    return join(cacheDir, 'analysis');
  }
  return join(ROOT, 'fixtures', 'hagrid');
}

const FINGERS: ReadonlyArray<readonly [number, number]> = [
  [LM.INDEX_MCP, LM.INDEX_TIP],
  [LM.MIDDLE_MCP, LM.MIDDLE_TIP],
  [LM.RING_MCP, LM.RING_TIP],
  [LM.PINKY_MCP, LM.PINKY_TIP],
];

function ratios(hand: HandFrame): number[] {
  const wrist = lm(hand, LM.WRIST);
  return FINGERS.map(([mcp, tip]) => {
    const d = dist(lm(hand, mcp), wrist);
    return d < 1e-6 ? NaN : dist(lm(hand, tip), wrist) / d;
  }).filter((x) => Number.isFinite(x));
}

function meanGap(hand: HandFrame): number {
  const s = handScale(hand);
  const tips = [LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];
  let sum = 0;
  for (let i = 0; i + 1 < tips.length; i++) {
    sum += dist(lm(hand, tips[i]!), lm(hand, tips[i + 1]!)) / s;
  }
  return sum / 3;
}

function thumbNearDist(hand: HandFrame): number {
  const s = handScale(hand);
  const t = lm(hand, LM.THUMB_TIP);
  return (
    Math.min(dist(t, lm(hand, LM.INDEX_PIP)), dist(t, lm(hand, LM.INDEX_MCP))) / s
  );
}

function thumbRise(hand: HandFrame): number {
  const s = handScale(hand);
  return (lm(hand, LM.THUMB_MCP).y - lm(hand, LM.THUMB_TIP).y) / s;
}

function facingZ(hand: HandFrame, handedness: Handedness): number {
  const wrist = lm(hand, LM.WRIST);
  const u = sub(lm(hand, LM.INDEX_MCP), wrist);
  const v = sub(lm(hand, LM.PINKY_MCP), wrist);
  const z = normalize(cross(u, v)).z;
  return handedness === 'right' ? z : -z;
}

function pctLine(values: number[]): string {
  const s = [...values].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => pick(q).toFixed(2)).join(' ');
}

const dir = loadDir();
console.log(`# loading from ${dir}`);
for (const f of readdirSync(dir).sort()) {
  if (!f.endsWith('.json')) continue;
  const cls = f.replace(/\.json$/, '');
  const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Array<{
    landmarks: Array<{ x: number; y: number; z: number }>;
    confidence: number;
    handedness: Handedness;
  }>;
  const hands = raw.map((r) => ({
    hand: { landmarks: r.landmarks, confidence: r.confidence } as HandFrame,
    handedness: r.handedness,
  }));
  const allRatios = hands.flatMap((h) => ratios(h.hand));
  const maxRatio = hands.map((h) => Math.max(...ratios(h.hand)));
  const minRatio = hands.map((h) => Math.min(...ratios(h.hand)));
  const gaps = hands.map((h) => meanGap(h.hand));
  const near = hands.map((h) => thumbNearDist(h.hand));
  const rise = hands.map((h) => thumbRise(h.hand));
  const facing = hands.map((h) => facingZ(h.hand, h.handedness));
  console.log(`\n== ${cls} (${hands.length})`);
  console.log(`  finger ratio pooled  ${pctLine(allRatios)}`);
  console.log(`  finger ratio max     ${pctLine(maxRatio)}`);
  console.log(`  finger ratio min     ${pctLine(minRatio)}`);
  console.log(`  mean tip gap / s     ${pctLine(gaps)}`);
  console.log(`  thumb near dist / s  ${pctLine(near)}`);
  console.log(`  thumb rise / s       ${pctLine(rise)}`);
  console.log(`  facing z (signed)    ${pctLine(facing)}`);
}
