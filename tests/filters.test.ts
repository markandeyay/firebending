import { describe, expect, it } from 'vitest';
import {
  ConfidenceGate,
  FilteredSource,
  HandFilterBank,
  Hysteresis,
  OneEuroFilter,
  wristVelocity,
} from '../src/tracking/filters';
import { ReplaySource } from '../src/tracking/replaySource';
import type {
  HandFrame,
  LandmarkFrame,
  LandmarkRecording,
  Vec3,
} from '../src/tracking/types';
import { HAND_LANDMARK_COUNT, LM } from '../src/tracking/types';

const FPS = 30;
const DT = 1 / FPS;
const FRAME_MS = 1000 / FPS;

/** Synthetic 21-landmark hand: wrist at the given position, the rest fanned out deterministically. */
function makeHand(wrist: Vec3, confidence = 0.9): HandFrame {
  const landmarks: Vec3[] = [];
  for (let i = 0; i < HAND_LANDMARK_COUNT; i++) {
    landmarks.push({
      x: wrist.x + i * 0.01,
      y: wrist.y - i * 0.005,
      z: wrist.z,
    });
  }
  return { landmarks, confidence };
}

function makeRecording(
  label: string,
  hands: Array<HandFrame | null>
): LandmarkRecording {
  const frames: LandmarkFrame[] = hands.map((right, i) => ({
    t: i * FRAME_MS,
    left: null,
    right,
    face: null,
  }));
  return { version: 1, label, fps: FPS, frames };
}

function wristX(hand: HandFrame | null): number {
  if (!hand) throw new Error('expected a hand');
  const w = hand.landmarks[LM.WRIST];
  if (!w) throw new Error('expected a wrist landmark');
  return w.x;
}

function rms(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum / values.length);
}

function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let sum = 0;
  for (const v of values) sum += (v - mean) * (v - mean);
  return sum / values.length;
}

describe('OneEuroFilter', () => {
  it('constant input converges to that value', () => {
    const f = new OneEuroFilter();
    let out = 0;
    for (let i = 0; i < 60; i++) out = f.filter(5.0, i * DT);
    expect(out).toBeCloseTo(5.0, 6);
  });

  it('handles irregular dt without breaking on a constant signal', () => {
    const f = new OneEuroFilter();
    const dts = [0.02, 0.05, 0.01, 0.1, 0.033, 0.0, 0.04];
    let t = 0;
    let out = 0;
    for (let i = 0; i < 50; i++) {
      t += dts[i % dts.length] ?? DT;
      out = f.filter(2.5, t);
    }
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeCloseTo(2.5, 6);
  });

  it('step input settles within a bounded number of frames', () => {
    const f = new OneEuroFilter();
    let t = 0;
    for (let i = 0; i < 30; i++) {
      f.filter(0, t);
      t += DT;
    }
    let out = 0;
    for (let i = 0; i < 30; i++) {
      out = f.filter(1.0, t);
      t += DT;
    }
    // 30 frames (1s at 30fps) after the step, the filter must be settled.
    expect(Math.abs(out - 1.0)).toBeLessThan(0.05);
  });

  it('attenuates 15Hz jitter by at least 60% RMS while a slow ramp tracks with small lag', () => {
    // Jitter case: 15Hz sine sampled at 30fps. Sampled at the peaks (cosine
    // phase) so the sequence alternates +/-amplitude instead of aliasing to 0.
    const amplitude = 0.02;
    const base = 0.5;
    const jitterFilter = new OneEuroFilter();
    const inDev: number[] = [];
    const outDev: number[] = [];
    for (let i = 0; i < 120; i++) {
      const t = i * DT;
      const input = base + amplitude * Math.cos(2 * Math.PI * 15 * t);
      const output = jitterFilter.filter(input, t);
      if (i >= 30) {
        inDev.push(input - base);
        outDev.push(output - base);
      }
    }
    expect(rms(outDev)).toBeLessThan(0.4 * rms(inDev));

    // Ramp case: 0.25 units/sec must track within a small lag.
    const rampFilter = new OneEuroFilter();
    let maxLag = 0;
    for (let i = 0; i < 120; i++) {
      const t = i * DT;
      const input = 0.25 * t;
      const output = rampFilter.filter(input, t);
      if (i >= 30) maxLag = Math.max(maxLag, Math.abs(input - output));
    }
    expect(maxLag).toBeLessThan(0.06);
  });
});

describe('Hysteresis', () => {
  it('enters only after 4 consecutive frames above the enter threshold', () => {
    const h = new Hysteresis();
    expect(h.update(0.8)).toBe(false);
    expect(h.update(0.8)).toBe(false);
    expect(h.update(0.8)).toBe(false);
    expect(h.update(0.8)).toBe(true);
  });

  it('exits only after 6 consecutive frames below the exit threshold', () => {
    const h = new Hysteresis();
    for (let i = 0; i < 4; i++) h.update(0.8);
    expect(h.isActive).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(h.update(0.5)).toBe(true);
    }
    expect(h.update(0.5)).toBe(false);
  });

  it('single-frame spikes never activate', () => {
    const h = new Hysteresis();
    for (let i = 0; i < 20; i++) {
      expect(h.update(0.9)).toBe(false);
      expect(h.update(0.1)).toBe(false);
    }
  });

  it('mid-band scores do not advance the exit counter', () => {
    const h = new Hysteresis();
    for (let i = 0; i < 4; i++) h.update(0.8);
    // 0.6 is below enter but above exit: must stay active indefinitely.
    for (let i = 0; i < 30; i++) {
      expect(h.update(0.6)).toBe(true);
    }
  });
});

describe('ConfidenceGate', () => {
  it('acquires after exactly 10 consecutive frames above 0.7', () => {
    const g = new ConfidenceGate();
    for (let i = 0; i < 9; i++) {
      expect(g.update(0.9)).toBe(false);
    }
    expect(g.update(0.9)).toBe(true);
  });

  it('loses after exactly 15 consecutive frames below', () => {
    const g = new ConfidenceGate();
    for (let i = 0; i < 10; i++) g.update(0.9);
    for (let i = 0; i < 14; i++) {
      expect(g.update(0.3)).toBe(true);
    }
    expect(g.update(0.3)).toBe(false);
  });

  it('null confidence counts as below', () => {
    const g = new ConfidenceGate();
    for (let i = 0; i < 10; i++) g.update(0.9);
    for (let i = 0; i < 14; i++) {
      expect(g.update(null)).toBe(true);
    }
    expect(g.update(null)).toBe(false);
  });

  it('flicker around the threshold never toggles the state', () => {
    const g = new ConfidenceGate();
    // Alternating above/below while untracked: acquire counter keeps resetting.
    for (let i = 0; i < 40; i++) {
      expect(g.update(i % 2 === 0 ? 0.9 : 0.5)).toBe(false);
    }
    // Acquire cleanly, then flicker while tracked: lose counter keeps resetting.
    for (let i = 0; i < 10; i++) g.update(0.9);
    expect(g.isTracked).toBe(true);
    for (let i = 0; i < 40; i++) {
      expect(g.update(i % 2 === 0 ? 0.5 : 0.9)).toBe(true);
    }
  });

  it('exactly 0.7 does not count as above', () => {
    const g = new ConfidenceGate();
    for (let i = 0; i < 30; i++) {
      expect(g.update(0.7)).toBe(false);
    }
  });
});

describe('FilteredSource', () => {
  function run(recording: LandmarkRecording): LandmarkFrame[] {
    const replay = new ReplaySource(recording);
    const filtered = new FilteredSource(replay);
    const out: LandmarkFrame[] = [];
    filtered.onFrame((f) => out.push(f));
    replay.drain();
    filtered.dispose();
    return out;
  }

  it('gates a hand in only after 10 confident frames, confidence passed through', () => {
    const hands = Array.from({ length: 30 }, () =>
      makeHand({ x: 0.5, y: 0.5, z: -0.1 }, 0.85)
    );
    const out = run(makeRecording('gate-in', hands));
    expect(out).toHaveLength(30);
    for (let i = 0; i < 9; i++) {
      expect(out[i]?.right).toBeNull();
    }
    const tenth = out[9]?.right;
    expect(tenth).not.toBeNull();
    expect(tenth?.confidence).toBe(0.85);
    expect(tenth?.landmarks).toHaveLength(HAND_LANDMARK_COUNT);
    expect(wristX(tenth ?? null)).toBeCloseTo(0.5, 6);
  });

  it('smooths jittered positions: output variance below input variance', () => {
    const base = 0.5;
    const hands: Array<HandFrame | null> = [];
    for (let i = 0; i < 90; i++) {
      const jitter = (i % 2 === 0 ? 1 : -1) * 0.02;
      hands.push(makeHand({ x: base + jitter, y: 0.5, z: -0.1 }, 0.9));
    }
    const recording = makeRecording('jitter', hands);
    const out = run(recording);

    const inXs: number[] = [];
    const outXs: number[] = [];
    for (let i = 20; i < 90; i++) {
      const rawHand = recording.frames[i]?.right ?? null;
      const outHand = out[i]?.right ?? null;
      inXs.push(wristX(rawHand));
      outXs.push(wristX(outHand));
    }
    expect(variance(outXs)).toBeLessThan(variance(inXs));
    // Filtering is meaningful, not marginal.
    expect(variance(outXs)).toBeLessThan(0.25 * variance(inXs));
  });

  it('resets filters after a long absence: reacquired hand snaps to the new position within 2 frames', () => {
    const hands: Array<HandFrame | null> = [];
    for (let i = 0; i < 30; i++) hands.push(makeHand({ x: 0.2, y: 0.5, z: -0.1 }, 0.9));
    for (let i = 0; i < 20; i++) hands.push(null);
    for (let i = 0; i < 20; i++) hands.push(makeHand({ x: 0.8, y: 0.5, z: -0.1 }, 0.9));
    const out = run(makeRecording('reacquire', hands));

    // Old position was live before the dropout.
    expect(wristX(out[29]?.right ?? null)).toBeCloseTo(0.2, 2);

    // During absence and re-gating (frames 50..58) the hand stays null.
    for (let i = 30; i < 59; i++) {
      expect(out[i]?.right).toBeNull();
    }

    // Frame 59 is the 10th confident frame after reappearance: gate opens and
    // the filter bank must have reset, snapping to 0.8 immediately.
    expect(wristX(out[59]?.right ?? null)).toBeCloseTo(0.8, 3);
    expect(Math.abs(wristX(out[60]?.right ?? null) - 0.8)).toBeLessThan(0.05);
  });

  it('smooths face yaw and passes face confidence through', () => {
    const frames: LandmarkFrame[] = [];
    for (let i = 0; i < 60; i++) {
      const jitter = (i % 2 === 0 ? 1 : -1) * 0.05;
      frames.push({
        t: i * FRAME_MS,
        left: null,
        right: null,
        face: {
          yaw: 0.1 + jitter,
          pitch: 0,
          position: { x: 0.5, y: 0.3, z: -0.5 },
          confidence: 0.95,
        },
      });
    }
    const replay = new ReplaySource({ version: 1, label: 'face', fps: FPS, frames });
    const filtered = new FilteredSource(replay);
    const out: LandmarkFrame[] = [];
    filtered.onFrame((f) => out.push(f));
    replay.drain();
    filtered.dispose();

    const inYaw: number[] = [];
    const outYaw: number[] = [];
    for (let i = 20; i < 60; i++) {
      inYaw.push(frames[i]?.face?.yaw ?? 0);
      const face = out[i]?.face;
      expect(face).not.toBeNull();
      outYaw.push(face?.yaw ?? 0);
      expect(face?.confidence).toBe(0.95);
    }
    expect(variance(outYaw)).toBeLessThan(variance(inYaw));
  });
});

describe('HandFilterBank', () => {
  it('passes confidence through and returns a new object', () => {
    const bank = new HandFilterBank();
    const hand = makeHand({ x: 0.4, y: 0.4, z: 0 }, 0.77);
    const out = bank.filter(hand, 0);
    expect(out).not.toBe(hand);
    expect(out.landmarks).not.toBe(hand.landmarks);
    expect(out.confidence).toBe(0.77);
  });

  it('resets on a time gap larger than 0.5s', () => {
    const bank = new HandFilterBank();
    for (let i = 0; i < 30; i++) {
      bank.filter(makeHand({ x: 0.1, y: 0.5, z: 0 }, 0.9), i * DT);
    }
    // Reappears 1 second later, far away: first output snaps, no smear.
    const out = bank.filter(makeHand({ x: 0.9, y: 0.5, z: 0 }, 0.9), 30 * DT + 1.0);
    expect(wristX(out)).toBeCloseTo(0.9, 6);
  });
});

describe('wristVelocity', () => {
  it('computes normalized units per second from two frames', () => {
    const a = makeHand({ x: 0.5, y: 0.5, z: -0.1 });
    const b = makeHand({ x: 0.53, y: 0.48, z: -0.15 });
    const v = wristVelocity(a, b, DT);
    expect(v.x).toBeCloseTo(0.03 / DT, 5);
    expect(v.y).toBeCloseTo(-0.02 / DT, 5);
    expect(v.z).toBeCloseTo(-0.05 / DT, 5);
  });
});
