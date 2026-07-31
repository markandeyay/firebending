/**
 * Predictive hand extrapolation (src/tracking/predict.ts): constant wrist
 * velocity applied as a RIGID offset to the whole hand, horizon cap, raw
 * pass-through beyond the cap, no finger-articulation extrapolation, and
 * the HandPredictor per-side sample bookkeeping.
 */

import { describe, expect, it } from 'vitest';
import type { HandFrame, Vec3 } from '../src/tracking/types';
import { HAND_LANDMARK_COUNT, LM } from '../src/tracking/types';
import {
  HandPredictor,
  PREDICT_HORIZON_MS,
  predictHand,
  type HandSample,
} from '../src/tracking/predict';

/** A hand whose wrist sits at (x, y, z) with fingers fanned deterministically. */
function hand(x: number, y: number, z = 0, confidence = 0.9): HandFrame {
  const landmarks: Vec3[] = [];
  for (let i = 0; i < HAND_LANDMARK_COUNT; i++) {
    landmarks.push({ x: x + i * 0.01, y: y + i * 0.005, z: z + i * 0.001 });
  }
  return { landmarks, confidence };
}

function sample(t: number, h: HandFrame): HandSample {
  return { t, hand: h };
}

describe('predictHand', () => {
  it('extrapolates the wrist at constant velocity', () => {
    // Wrist moves +0.1 x over 33 ms -> ~3.03 u/s; predict 16.5 ms ahead.
    const prev = sample(0, hand(0.4, 0.5));
    const last = sample(33, hand(0.5, 0.5));
    const out = predictHand(prev, last, 33 + 16.5);
    const wrist = out.landmarks[LM.WRIST]!;
    expect(wrist.x).toBeCloseTo(0.5 + 0.1 * (16.5 / 33), 10);
    expect(wrist.y).toBeCloseTo(0.5, 10);
  });

  it('applies the SAME rigid offset to every landmark (no articulation change)', () => {
    const prev = sample(0, hand(0.4, 0.6, -0.02));
    const last = sample(40, hand(0.45, 0.55, -0.03));
    const out = predictHand(prev, last, 90); // 50 ms ahead (within horizon)
    const lastWrist = last.hand.landmarks[LM.WRIST]!;
    const outWrist = out.landmarks[LM.WRIST]!;
    const ox = outWrist.x - lastWrist.x;
    const oy = outWrist.y - lastWrist.y;
    const oz = outWrist.z - lastWrist.z;
    expect(ox).not.toBe(0);
    for (let i = 0; i < HAND_LANDMARK_COUNT; i++) {
      const s = last.hand.landmarks[i]!;
      const d = out.landmarks[i]!;
      expect(d.x - s.x).toBeCloseTo(ox, 12);
      expect(d.y - s.y).toBeCloseTo(oy, 12);
      expect(d.z - s.z).toBeCloseTo(oz, 12);
    }
    // Relative finger geometry (tip minus wrist) is EXACTLY the last sample's.
    const relLast = {
      x: last.hand.landmarks[LM.INDEX_TIP]!.x - lastWrist.x,
      y: last.hand.landmarks[LM.INDEX_TIP]!.y - lastWrist.y,
    };
    const relOut = {
      x: out.landmarks[LM.INDEX_TIP]!.x - outWrist.x,
      y: out.landmarks[LM.INDEX_TIP]!.y - outWrist.y,
    };
    expect(relOut.x).toBeCloseTo(relLast.x, 12);
    expect(relOut.y).toBeCloseTo(relLast.y, 12);
  });

  it('caps the horizon at PREDICT_HORIZON_MS past the last sample', () => {
    const prev = sample(0, hand(0.0, 0.5));
    const last = sample(100, hand(0.1, 0.5)); // 1 u/s
    const atCap = predictHand(prev, last, 100 + PREDICT_HORIZON_MS);
    const wayPast = predictHand(prev, last, 100 + 10_000);
    expect(wayPast.landmarks[LM.WRIST]!.x).toBeCloseTo(
      atCap.landmarks[LM.WRIST]!.x,
      10,
    );
    expect(wayPast.landmarks[LM.WRIST]!.x).toBeCloseTo(
      0.1 + 1 * (PREDICT_HORIZON_MS / 1000),
      10,
    );
  });

  it('returns the raw last sample for targets at or before the last sample', () => {
    const prev = sample(0, hand(0.0, 0.5));
    const last = sample(33, hand(0.1, 0.5));
    expect(predictHand(prev, last, 33)).toBe(last.hand);
    expect(predictHand(prev, last, 10)).toBe(last.hand);
  });

  it('returns the raw last sample for non-ordered samples', () => {
    const a = sample(50, hand(0.0, 0.5));
    const b = sample(50, hand(0.1, 0.5));
    expect(predictHand(a, b, 100)).toBe(b.hand);
  });

  it('passes world landmarks through untouched from the last sample', () => {
    const prev = sample(0, hand(0.0, 0.5));
    const last = sample(33, hand(0.1, 0.5));
    const world: Vec3[] = Array.from({ length: HAND_LANDMARK_COUNT }, (_, i) => ({
      x: i,
      y: i,
      z: i,
    }));
    last.hand.world = world;
    const out = predictHand(prev, last, 66);
    expect(out.world).toBe(world);
    expect(out.confidence).toBe(last.hand.confidence);
  });

  it('reuses the provided out buffer without touching the source', () => {
    const prev = sample(0, hand(0.0, 0.5));
    const last = sample(33, hand(0.1, 0.5));
    const out: HandFrame = { landmarks: [], confidence: 0 };
    const result = predictHand(prev, last, 66, out);
    expect(result).toBe(out);
    expect(out.landmarks).toHaveLength(HAND_LANDMARK_COUNT);
    // Source sample untouched by the write.
    expect(last.hand.landmarks[LM.WRIST]!.x).toBeCloseTo(0.1, 12);
  });
});

describe('HandPredictor', () => {
  it('returns null for a side never seen', () => {
    const p = new HandPredictor();
    expect(p.predict(0)).toEqual({ left: null, right: null });
  });

  it('returns the raw last sample when only one sample exists', () => {
    const p = new HandPredictor();
    const h = hand(0.3, 0.5);
    p.feed(0, h, null);
    const out = p.predict(50);
    expect(out.left).toBe(h);
    expect(out.right).toBeNull();
  });

  it('extrapolates from the last two samples per side', () => {
    const p = new HandPredictor();
    p.feed(0, hand(0.3, 0.5), hand(0.7, 0.5));
    p.feed(33, hand(0.35, 0.5), hand(0.7, 0.45));
    const out = p.predict(66);
    // Left wrist moved +0.05 over 33 ms; 33 ms ahead adds another +0.05.
    expect(out.left!.landmarks[LM.WRIST]!.x).toBeCloseTo(0.4, 10);
    // Right wrist moved -0.05 y.
    expect(out.right!.landmarks[LM.WRIST]!.y).toBeCloseTo(0.4, 10);
  });

  it('drops a side unseen for longer than the stale window', () => {
    const p = new HandPredictor();
    p.feed(0, hand(0.3, 0.5), null);
    p.feed(33, hand(0.35, 0.5), null);
    expect(p.predict(66).left).not.toBeNull();
    expect(p.predict(33 + HandPredictor.STALE_MS + 1).left).toBeNull();
  });

  it('a side absent from a feed keeps its previous samples (no reset)', () => {
    const p = new HandPredictor();
    p.feed(0, hand(0.3, 0.5), null);
    p.feed(33, hand(0.35, 0.5), null);
    p.feed(66, null, hand(0.7, 0.5)); // left missing this frame
    const out = p.predict(80);
    expect(out.left).not.toBeNull(); // still predicted from t=0/33
    expect(out.right).not.toBeNull();
  });

  it('reset forgets everything', () => {
    const p = new HandPredictor();
    p.feed(0, hand(0.3, 0.5), hand(0.7, 0.5));
    p.reset();
    expect(p.predict(10)).toEqual({ left: null, right: null });
  });
});
