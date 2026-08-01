/**
 * Predictive hand extrapolation for RENDERING (quality round Phase 1).
 *
 * The hand pipeline emits real samples at the achieved hand-inference rate
 * (~14 fps sustained on the reference machine) while the game renders at
 * 60 fps, so a glove pinned
 * to the last sample visibly steps. This module extrapolates a hand forward
 * to the render frame's time using CONSTANT WRIST VELOCITY from the last two
 * REAL samples, applied as a RIGID OFFSET to the whole hand: finger
 * articulation is never extrapolated (per-landmark velocities are noise at
 * this rate), the whole last-known hand shape just slides along the wrist's
 * motion. World landmarks (metric, hand-centered shape data) pass through
 * untouched for the same reason.
 *
 * HORIZON: extrapolation is capped at PREDICT_HORIZON_MS past the newest
 * sample; beyond that the raw last sample is returned unchanged (a stalled
 * tracker must freeze the glove, not launch it along a stale velocity).
 *
 * CONSUMERS: the glove render path only. Gesture/move code keeps consuming
 * real emitted frames; predicted hands never enter the move engine.
 *
 * Pure and headless-testable; HandPredictor is the tiny stateful convenience
 * wrapper LiveLandmarkSource feeds with emitted samples.
 */

import type { HandFrame, Vec3 } from './types';
import { LM } from './types';

/** Max extrapolation past the newest real sample, ms. */
export const PREDICT_HORIZON_MS = 100;

/** A real hand sample: the emitted frame's time plus its hand. */
export interface HandSample {
  /** Frame time, ms (same clock as LandmarkFrame.t). */
  t: number;
  hand: HandFrame;
}

/**
 * Extrapolate a hand to `targetTMs` from two real samples (prev older, last
 * newer). Constant wrist velocity between the two samples, applied as a
 * rigid offset to every screen landmark; `world` (hand-centered shape) and
 * confidence come from the last sample untouched.
 *
 * - targetTMs at or before last.t, non-ordered samples (prev.t >= last.t),
 *   or a missing wrist in either sample: returns last.hand unchanged.
 * - targetTMs beyond last.t + PREDICT_HORIZON_MS: clamped to the horizon.
 *
 * Writes landmark objects into `out` when provided (hot-path reuse);
 * otherwise allocates a fresh HandFrame. When the function returns
 * last.hand unchanged, `out` is not written.
 */
export function predictHand(
  prev: HandSample,
  last: HandSample,
  targetTMs: number,
  out?: HandFrame,
): HandFrame {
  const dtSamples = last.t - prev.t;
  if (!(dtSamples > 0)) return last.hand;
  const prevWrist = prev.hand.landmarks[LM.WRIST];
  const lastWrist = last.hand.landmarks[LM.WRIST];
  if (!prevWrist || !lastWrist) return last.hand;

  const horizon = Math.min(targetTMs, last.t + PREDICT_HORIZON_MS);
  const aheadSec = (horizon - last.t) / 1000;
  if (!(aheadSec > 0)) return last.hand;

  const vx = (lastWrist.x - prevWrist.x) / (dtSamples / 1000);
  const vy = (lastWrist.y - prevWrist.y) / (dtSamples / 1000);
  const vz = (lastWrist.z - prevWrist.z) / (dtSamples / 1000);
  const ox = vx * aheadSec;
  const oy = vy * aheadSec;
  const oz = vz * aheadSec;

  const src = last.hand.landmarks;
  const result: HandFrame =
    out ??
    ({
      landmarks: src.map(() => ({ x: 0, y: 0, z: 0 })),
      confidence: 0,
    } as HandFrame);
  const dst = result.landmarks;
  // Grow a reused output to the source length (defensive; always 21).
  while (dst.length < src.length) dst.push({ x: 0, y: 0, z: 0 });
  if (dst.length > src.length) dst.length = src.length;
  for (let i = 0; i < src.length; i++) {
    const s = src[i] as Vec3;
    const d = dst[i] as Vec3;
    d.x = s.x + ox;
    d.y = s.y + oy;
    d.z = s.z + oz;
  }
  result.confidence = last.hand.confidence;
  if (last.hand.world) result.world = last.hand.world;
  else delete result.world;
  return result;
}

/** Predicted hands for both sides (null = no real sample for that side). */
export interface PredictedHands {
  left: HandFrame | null;
  right: HandFrame | null;
}

/**
 * Per-side two-sample history + reusable output buffers. feed() with every
 * REAL emitted frame; predict(nowMs) extrapolates both sides to the render
 * time. A side seen only once (or currently absent from the feed for longer
 * than STALE_MS) predicts as its raw last sample / null respectively.
 */
export class HandPredictor {
  /** A side unseen for this long is dropped (hand left the frame). */
  static readonly STALE_MS = 500;

  private prevL: HandSample | null = null;
  private lastL: HandSample | null = null;
  private prevR: HandSample | null = null;
  private lastR: HandSample | null = null;
  private readonly outL: HandFrame = { landmarks: [], confidence: 0 };
  private readonly outR: HandFrame = { landmarks: [], confidence: 0 };
  private readonly result: PredictedHands = { left: null, right: null };

  /** Record the hands of one REAL emitted frame (t = frame time, ms). */
  feed(t: number, left: HandFrame | null, right: HandFrame | null): void {
    if (left) {
      this.prevL = this.lastL;
      this.lastL = { t, hand: left };
    }
    if (right) {
      this.prevR = this.lastR;
      this.lastR = { t, hand: right };
    }
  }

  /** Extrapolate both sides to `tMs` (same clock as feed). The returned
   * object and its HandFrames are REUSED across calls; consume immediately. */
  predict(tMs: number): PredictedHands {
    this.result.left = this.predictSide(this.prevL, this.lastL, tMs, this.outL);
    this.result.right = this.predictSide(this.prevR, this.lastR, tMs, this.outR);
    return this.result;
  }

  private predictSide(
    prev: HandSample | null,
    last: HandSample | null,
    tMs: number,
    out: HandFrame,
  ): HandFrame | null {
    if (last === null) return null;
    if (tMs - last.t > HandPredictor.STALE_MS) return null;
    if (prev === null) return last.hand;
    return predictHand(prev, last, tMs, out);
  }

  reset(): void {
    this.prevL = null;
    this.lastL = null;
    this.prevR = null;
    this.lastR = null;
  }
}
