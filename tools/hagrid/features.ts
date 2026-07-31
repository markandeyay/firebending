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

// ---------------------------------------------------------------------------
// Pure-2D palm features (palmScore2D investigation): x/y only, no z anywhere.
// ---------------------------------------------------------------------------

function dist2D(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function handScale2D(hand: HandFrame): number {
  return dist2D(lm(hand, LM.WRIST), lm(hand, LM.MIDDLE_MCP));
}

/** Signed palm winding area: det(indexMCP-wrist, pinkyMCP-wrist) / s^2,
 *  sign-flipped for the left hand so positive = palm toward camera. */
function winding2D(hand: HandFrame, handedness: Handedness): number {
  const s = handScale2D(hand);
  if (s < 1e-6) return 0;
  const w = lm(hand, LM.WRIST);
  const u = { x: lm(hand, LM.INDEX_MCP).x - w.x, y: lm(hand, LM.INDEX_MCP).y - w.y };
  const v = { x: lm(hand, LM.PINKY_MCP).x - w.x, y: lm(hand, LM.PINKY_MCP).y - w.y };
  const det = u.x * v.y - u.y * v.x;
  return (handedness === 'right' ? det : -det) / (s * s);
}

/** Monotone-chain convex hull of 2D points; returns hull in CCW order. */
function hull2D(pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length <= 2) return p;
  const crossZ = (
    o: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Array<{ x: number; y: number }> = [];
  for (const pt of p) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2]!, lower[lower.length - 1]!, pt) <= 0)
      lower.pop();
    lower.push(pt);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i]!;
    while (upper.length >= 2 && crossZ(upper[upper.length - 2]!, upper[upper.length - 1]!, pt) <= 0)
      upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Min-area-rect aspect (minor/major, 0..1) over the 2D landmark hull. */
function hullAspect2D(hand: HandFrame): number {
  const h = hull2D(hand.landmarks.map((p) => ({ x: p.x, y: p.y })));
  if (h.length < 3) return 0;
  let best = Infinity;
  let bestAspect = 0;
  for (let i = 0; i < h.length; i++) {
    const a = h[i]!;
    const b = h[(i + 1) % h.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const elen = Math.sqrt(ex * ex + ey * ey);
    if (elen < 1e-9) continue;
    const ux = ex / elen;
    const uy = ey / elen;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const pt of h) {
      const u = pt.x * ux + pt.y * uy;
      const v = -pt.x * uy + pt.y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const hgt = maxV - minV;
    const area = w * hgt;
    if (area < best) {
      best = area;
      const major = Math.max(w, hgt);
      bestAspect = major < 1e-9 ? 0 : Math.min(w, hgt) / major;
    }
  }
  return bestAspect;
}

function ratios2D(hand: HandFrame): number[] {
  const wrist = lm(hand, LM.WRIST);
  return FINGERS.map(([mcp, tip]) => {
    const d = dist2D(lm(hand, mcp), wrist);
    return d < 1e-6 ? NaN : dist2D(lm(hand, tip), wrist) / d;
  }).filter((x) => Number.isFinite(x));
}

function meanGap2D(hand: HandFrame): number {
  const s = handScale2D(hand);
  const tips = [LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];
  let sum = 0;
  for (let i = 0; i + 1 < tips.length; i++) {
    sum += dist2D(lm(hand, tips[i]!), lm(hand, tips[i + 1]!)) / s;
  }
  return sum / 3;
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
  // Pure-2D palm features (palmScore2D investigation).
  const r2 = hands.flatMap((h) => ratios2D(h.hand));
  const gap2 = hands.map((h) => meanGap2D(h.hand));
  const wind2 = hands.map((h) => winding2D(h.hand, h.handedness));
  const asp2 = hands.map((h) => hullAspect2D(h.hand));
  console.log(`  2D finger ratio      ${pctLine(r2)}`);
  console.log(`  2D mean tip gap / s  ${pctLine(gap2)}`);
  console.log(`  2D winding / s^2     ${pctLine(wind2)}`);
  console.log(`  2D hull aspect       ${pctLine(asp2)}`);
}
