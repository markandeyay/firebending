/**
 * Apparent-size motion signals (toward-camera detection without MediaPipe z).
 *
 * WHY: MediaPipe's z is a model-inferred monocular depth guess and is far too
 * noisy on real hands to gate punch detection. Apparent size is not a guess:
 * when a hand approaches the camera its projected landmark spread grows by
 * plain projective geometry, measured from the same 2D landmarks the tracker
 * is confident about. The move layer therefore reads toward-camera intent as
 * RELATIVE apparent-size growth per second (positive = approaching the
 * camera, negative = retracting) instead of -z velocity.
 *
 * WHICH SIZE MEASUREMENT: the exported growth signal is the FULL-HAND
 * BOUNDING-BOX DIAGONAL (bboxDiagOf), not the palm span. On real hands a
 * clenching fist collapses the palm-length and knuckle-width measurements
 * into a small noisy cluster, so a span-based signal measured its weakest
 * quantity exactly when a jab happened. The min/max box over all 21
 * landmarks (x, y only) is larger and far less collapse-prone: even a tight
 * fist keeps a stable wrist-to-knuckle extent, and measured on the noisy
 * negative fixtures the bbox growth is dramatically quieter than span growth
 * (a single jittered landmark barely moves the box while it whipsaws a
 * two-point span). spanOf is kept for calibrationStats-style size baselines.
 *
 * spanOf uses the LARGER of two palm measurements on purpose: pitching the
 * hand forward foreshortens the palm length (wrist to middle MCP) while the
 * knuckle width (index MCP to pinky MCP) survives, and yawing the hand
 * foreshortens the width while the length survives. Taking the max keeps the
 * signal from collapsing under ordinary hand rotation.
 */

import type { HandFrame } from '../tracking/types';
import { LM } from '../tracking/types';
import { dist, lm } from './poses';

const EPS = 1e-6;

/**
 * Palm span of one hand in normalized screen units: the larger of the palm
 * length (wrist to middle MCP) and the palm width (index MCP to pinky MCP).
 * Grows as the hand approaches the camera; robust against pitch and yaw
 * (each foreshortens only one of the two measurements).
 */
export function spanOf(hand: HandFrame): number {
  const length = dist(lm(hand, LM.WRIST), lm(hand, LM.MIDDLE_MCP));
  const width = dist(lm(hand, LM.INDEX_MCP), lm(hand, LM.PINKY_MCP));
  return Math.max(length, width);
}

/**
 * Full-hand bounding-box diagonal in normalized screen units: the diagonal
 * of the min/max box over all 21 landmarks, x and y only (z is untrusted).
 * Grows as the hand approaches the camera. Preferred over spanOf for motion
 * signals because the full-hand box survives a clenching fist (see the
 * module header). Returns 0 for an empty or fully collapsed hand.
 */
export function bboxDiagOf(hand: HandFrame): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of hand.landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return 0;
  const dx = maxX - minX;
  const dy = maxY - minY;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Shared windowed relative-growth core for any per-hand size measure. */
function relativeGrowthRate(
  window: HandFrame[],
  dtSec: number,
  sizeOf: (hand: HandFrame) => number,
): number {
  if (window.length < 2 || !(dtSec > 0)) return 0;

  let sum = 0;
  let pairs = 0;
  for (let i = 0; i + 1 < window.length; i++) {
    const a = window[i];
    const b = window[i + 1];
    if (!a || !b) continue;
    const sa = sizeOf(a);
    const sb = sizeOf(b);
    if (sa < EPS || sb < EPS) continue; // collapsed hand: skip the pair
    sum += (sb - sa) / dtSec;
    pairs++;
  }
  if (pairs === 0) return 0;

  const last = window[window.length - 1];
  if (!last) return 0;
  const current = sizeOf(last);
  if (current < EPS) return 0;

  const rate = sum / pairs / current;
  return Number.isFinite(rate) ? rate : 0;
}

/**
 * Windowed RELATIVE span growth per second over recent HandFrames (oldest
 * first) sampled at a fixed per-frame dt. Mirrors handSpeed: the pairwise
 * per-frame d(span)/dt values are averaged, then divided by the current span
 * so the result is scale-free (1/sec). Positive = the hand is approaching
 * the camera, negative = retracting. Degenerate input (fewer than two
 * frames, non-positive dt, collapsed spans) yields 0, never NaN.
 *
 * SUPERSEDED for gameplay by bboxGrowthRate (fist collapse, module header);
 * kept exported for analysis tools and tests.
 */
export function spanGrowthRate(window: HandFrame[], dtSec: number): number {
  return relativeGrowthRate(window, dtSec, spanOf);
}

/**
 * Windowed RELATIVE bounding-box-diagonal growth per second, computed
 * exactly like spanGrowthRate (average pairwise rate over the window,
 * divided by the current diagonal, 1/sec). THE toward-camera signal for the
 * move layer: positive = approaching the camera, negative = retracting.
 * Degenerate input yields 0, never NaN.
 */
export function bboxGrowthRate(window: HandFrame[], dtSec: number): number {
  return relativeGrowthRate(window, dtSec, bboxDiagOf);
}
