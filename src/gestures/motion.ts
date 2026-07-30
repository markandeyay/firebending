/**
 * Palm-span motion signals (toward-camera detection without MediaPipe z).
 *
 * WHY: MediaPipe's z is a model-inferred monocular depth guess and is far too
 * noisy on real hands to gate punch detection. Apparent size is not a guess:
 * when a hand approaches the camera its projected landmark spread grows by
 * plain projective geometry, measured from the same 2D landmarks the tracker
 * is confident about. The move layer therefore reads toward-camera intent as
 * RELATIVE palm-span growth per second (positive = approaching the camera,
 * negative = retracting) instead of -z velocity.
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
 * Windowed RELATIVE span growth per second over recent HandFrames (oldest
 * first) sampled at a fixed per-frame dt. Mirrors handSpeed: the pairwise
 * per-frame d(span)/dt values are averaged, then divided by the current span
 * so the result is scale-free (1/sec). Positive = the hand is approaching
 * the camera, negative = retracting. Degenerate input (fewer than two
 * frames, non-positive dt, collapsed spans) yields 0, never NaN.
 */
export function spanGrowthRate(window: HandFrame[], dtSec: number): number {
  if (window.length < 2 || !(dtSec > 0)) return 0;

  let sum = 0;
  let pairs = 0;
  for (let i = 0; i + 1 < window.length; i++) {
    const a = window[i];
    const b = window[i + 1];
    if (!a || !b) continue;
    const sa = spanOf(a);
    const sb = spanOf(b);
    if (sa < EPS || sb < EPS) continue; // collapsed hand: skip the pair
    sum += (sb - sa) / dtSec;
    pairs++;
  }
  if (pairs === 0) return 0;

  const last = window[window.length - 1];
  if (!last) return 0;
  const current = spanOf(last);
  if (current < EPS) return 0;

  const rate = sum / pairs / current;
  return Number.isFinite(rate) ? rate : 0;
}
