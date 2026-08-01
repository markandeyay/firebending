/**
 * BodyFrameTracker (src/gestures/bodyFrame.ts): body-local coordinates must
 * be translation and scale invariant, the frame must drift only SLOWLY
 * (EMA + per-sample clamp), and garbage input (interpolated frames, held
 * samples, low confidence, collapsed shoulders) must be a no-op. These
 * invariances are what make every downstream position threshold portable
 * across players and camera distances.
 */

import { describe, expect, it } from 'vitest';
import {
  BodyFrameTracker,
  FRAME_ORIGIN_MAX_STEP,
  POSE_CONFIDENCE_FLOOR,
} from '../src/gestures/bodyFrame';
import type { BodyPoint } from '../src/gestures/bodyFrame';
import type { PoseArm, PoseFrame, Vec3 } from '../src/tracking/types';

interface Pt {
  x: number;
  y: number;
}

function armOf(shoulder: Pt, hip: Pt, wrist: Pt): PoseArm {
  return {
    shoulder: { x: shoulder.x, y: shoulder.y, z: 0 },
    elbow: { x: (shoulder.x + wrist.x) / 2, y: (shoulder.y + wrist.y) / 2, z: 0 },
    wrist: { x: wrist.x, y: wrist.y, z: 0 },
    hip: { x: hip.x, y: hip.y, z: 0 },
  };
}

/** Standard squarely-facing body: shoulders y 0.35 and 0.32 apart. */
function makePose(
  t: number,
  transform: (p: Pt) => Pt = (p) => p,
  confidence = 1,
): PoseFrame {
  const T = transform;
  return {
    t,
    left: armOf(T({ x: 0.34, y: 0.35 }), T({ x: 0.4, y: 0.72 }), T({ x: 0.38, y: 0.55 })),
    right: armOf(T({ x: 0.66, y: 0.35 }), T({ x: 0.6, y: 0.72 }), T({ x: 0.62, y: 0.55 })),
    world: null,
    confidence,
  };
}

function body(tracker: BodyFrameTracker, p: Pt): BodyPoint {
  const v: Vec3 = { x: p.x, y: p.y, z: 0 };
  return tracker.toBody(v, { x: 0, y: 0 });
}

describe('toBody invariance', () => {
  it('translating and scaling the whole pose leaves body coords unchanged', () => {
    const plain = new BodyFrameTracker();
    plain.update(makePose(0));

    // Scale 1.3 about frame center, then translate: a smaller/closer player
    // standing somewhere else entirely.
    const T = (p: Pt): Pt => ({
      x: 0.5 + (p.x - 0.5) * 1.3 + 0.05,
      y: 0.5 + (p.y - 0.5) * 1.3 - 0.03,
    });
    const moved = new BodyFrameTracker();
    moved.update(makePose(0, T));

    const probes: Pt[] = [
      { x: 0.38, y: 0.55 }, // a wrist
      { x: 0.5, y: 0.72 }, // hip center
      { x: 0.62, y: 0.2 }, // overhead
    ];
    for (const p of probes) {
      const a = body(plain, p);
      const b = body(moved, T(p));
      expect(b.x).toBeCloseTo(a.x, 9);
      expect(b.y).toBeCloseTo(a.y, 9);
    }
  });

  it('seeds the hip line near its anatomical body-space position', () => {
    const tracker = new BodyFrameTracker();
    tracker.update(makePose(0));
    // (0.72 - 0.35) / 0.32
    expect(tracker.hipY).toBeCloseTo(1.15625, 5);
    expect(tracker.scale).toBeCloseTo(0.32, 5);
    expect(tracker.ready).toBe(true);
  });
});

describe('slow drift with per-sample clamp', () => {
  it('a single violent sample cannot yank the frame (punch/lean rejection)', () => {
    const tracker = new BodyFrameTracker();
    tracker.update(makePose(0));
    const before = body(tracker, { x: 0.5, y: 0.35 });

    // One sample with the whole torso jumped 0.2 to the right: far beyond
    // anything real drift produces between two samples.
    tracker.update(makePose(70, (p) => ({ x: p.x + 0.2, y: p.y })));
    const after = body(tracker, { x: 0.5, y: 0.35 });

    // Origin may move at most the clamp step (plus tiny axis/scale effects).
    const movedSw = Math.abs(after.x - before.x);
    expect(movedSw).toBeLessThanOrEqual(FRAME_ORIGIN_MAX_STEP + 0.02);
  });

  it('sustained drift converges over a couple of seconds (EMA follows)', () => {
    const tracker = new BodyFrameTracker();
    tracker.update(makePose(0));
    const shift = (p: Pt): Pt => ({ x: p.x + 0.1, y: p.y });
    for (let i = 1; i <= 100; i++) tracker.update(makePose(i * 200, shift));
    // The shifted shoulder midpoint should now be (near) the origin.
    const mid = body(tracker, { x: 0.6, y: 0.35 });
    expect(Math.abs(mid.x)).toBeLessThan(0.05);
    expect(Math.abs(mid.y)).toBeLessThan(0.05);
  });
});

describe('garbage rejection', () => {
  it('interpolated frames, held samples and low confidence are no-ops', () => {
    const tracker = new BodyFrameTracker();
    tracker.update(makePose(0));
    const before = body(tracker, { x: 0.38, y: 0.55 });

    // Interpolated frame with a wild pose.
    const interp = makePose(50, (p) => ({ x: p.x + 0.3, y: p.y + 0.3 }));
    interp.interpolated = true;
    tracker.update(interp);

    // Same-timestamp (sample-and-held) repeat of a wild pose.
    const held = makePose(0, (p) => ({ x: p.x + 0.3, y: p.y }));
    tracker.update(held);

    // Low-confidence detection.
    tracker.update(makePose(100, (p) => ({ x: p.x + 0.3, y: p.y }), POSE_CONFIDENCE_FLOOR - 0.1));

    const after = body(tracker, { x: 0.38, y: 0.55 });
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
  });

  it('a collapsed shoulder line cannot seed or poison the frame', () => {
    const tracker = new BodyFrameTracker();
    const collapsed = makePose(0, () => ({ x: 0.5, y: 0.35 }));
    tracker.update(collapsed);
    expect(tracker.ready).toBe(false);
    // A sane sample afterwards seeds normally.
    tracker.update(makePose(100));
    expect(tracker.ready).toBe(true);
    expect(tracker.scale).toBeCloseTo(0.32, 5);
  });
});
