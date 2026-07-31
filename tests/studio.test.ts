/**
 * Recording-studio pure modules: clock mapping (frame clock <-> video
 * clock, trim math), peak detection (prominence vs the take median, min
 * spacing, boundaries), primary-signal evaluation, the SignalTracker's
 * MoveEngine-consistent windows, and export assembly from an in-memory
 * take (shape, trimming, rep filtering, meta derivation). DOM-free.
 */

import { describe, expect, it } from 'vitest';
import {
  clampTrimRange,
  frameClockOffset,
  frameTimeOf,
  lowerBound,
  nearestFrameIndex,
  trimByTime,
  trimIndexRange,
  upperBound,
  videoTimeOf,
} from '../src/studio/clock';
import {
  MIN_PEAK_SPACING_MS,
  detectReps,
  median,
  prominenceAt,
  type SignalSample,
} from '../src/studio/peaks';
import { SignalTracker, bodySignalsOf } from '../src/studio/signals';
import { TAKES, primarySignalValue, takeDef } from '../src/studio/takes';
import { TAKE_IDS, type StudioFrame } from '../src/studio/exportSchema';
import {
  buildExport,
  buildTakeExport,
  exportFilename,
  framingSummaryOf,
  medianShoulderWidth,
  takeKey,
  type StoredTake,
} from '../src/studio/exportBuild';
import { DEFAULT_PROFILE, thresholdsFrom } from '../src/gestures/profile';
import type { HandFrame, LandmarkFrame, PoseFrame, Vec3 } from '../src/tracking/types';
import { STICK_ANIMS, samplePose } from '../src/studio/stickfigure';

// ---------------------------------------------------------------------------
// Clock mapping
// ---------------------------------------------------------------------------

describe('studio clock mapping', () => {
  it('derives the offset so videoTime = frameT + offset', () => {
    // Source started at perf 1000 (frame.t = perf - 1000); recorder started
    // at perf 5000. A frame captured at perf 6234 has frameT 5234.
    const offset = frameClockOffset(5000, 6234, 5234);
    expect(offset).toBe(-4000);
    expect(videoTimeOf(5234, offset)).toBe(1234);
    expect(frameTimeOf(1234, offset)).toBe(5234);
  });

  it('round-trips arbitrary times through the mapping', () => {
    const offset = frameClockOffset(123.4, 987.6, 500.5);
    for (const t of [0, 1, 250.25, 99999]) {
      expect(frameTimeOf(videoTimeOf(t, offset), offset)).toBeCloseTo(t, 9);
    }
  });

  it('frames before recorder start map to negative video time', () => {
    const offset = frameClockOffset(2000, 2100, 1600); // source epoch 500
    expect(videoTimeOf(1400, offset)).toBeLessThan(0);
    expect(videoTimeOf(1500, offset)).toBe(0);
  });

  it('clamps trim ranges into the take and keeps a minimum span', () => {
    expect(clampTrimRange(100, 900, 1000)).toEqual([100, 900]);
    expect(clampTrimRange(900, 100, 1000)).toEqual([100, 900]); // swapped
    expect(clampTrimRange(-50, 2000, 1000)).toEqual([0, 1000]); // clamped
    const [a, b] = clampTrimRange(500, 505, 1000, 100);
    expect(b - a).toBe(100);
    // Degenerate near the end pushes the span backward, not past the end.
    const [c, d] = clampTrimRange(990, 995, 1000, 100);
    expect(d).toBe(1000);
    expect(c).toBe(900);
  });

  it('trims time-carrying records inclusively', () => {
    const items = [0, 100, 200, 300, 400].map((t) => ({ t }));
    expect(trimByTime(items, 100, 300).map((i) => i.t)).toEqual([100, 200, 300]);
    expect(trimByTime(items, 101, 299).map((i) => i.t)).toEqual([200]);
    expect(trimByTime(items, 500, 600)).toEqual([]);
  });

  it('binary-search helpers agree with the filter-based trim', () => {
    const times = [0, 100, 200, 300, 400];
    expect(lowerBound(times, 100)).toBe(1);
    expect(lowerBound(times, 101)).toBe(2);
    expect(upperBound(times, 300)).toBe(4);
    expect(trimIndexRange(times, 100, 300)).toEqual([1, 4]);
    expect(trimIndexRange(times, 401, 999)).toEqual([5, 5]);
  });

  it('nearestFrameIndex picks the closest frame for scrubbing', () => {
    const times = [0, 33, 66, 100];
    expect(nearestFrameIndex(times, -10)).toBe(0);
    expect(nearestFrameIndex(times, 16)).toBe(0);
    expect(nearestFrameIndex(times, 17)).toBe(1);
    expect(nearestFrameIndex(times, 90)).toBe(3);
    expect(nearestFrameIndex(times, 500)).toBe(3);
    expect(nearestFrameIndex([], 10)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Peak detection
// ---------------------------------------------------------------------------

/** Synthetic signal: quiet floor with triangular bumps at given times. */
function bumpySignal(
  peakTimes: number[],
  peakValue: number,
  durationMs = 10000,
  stepMs = 33,
  floor = 0.05,
): SignalSample[] {
  const out: SignalSample[] = [];
  for (let t = 0; t <= durationMs; t += stepMs) {
    let v = floor;
    for (const pt of peakTimes) {
      const d = Math.abs(t - pt);
      if (d < 180) v = Math.max(v, peakValue * (1 - d / 180));
    }
    out.push({ t, v });
  }
  return out;
}

describe('studio peak detection', () => {
  it('finds exactly the five jab-like peaks', () => {
    const times = [1000, 2500, 4000, 5500, 7000];
    const reps = detectReps(bumpySignal(times, 4));
    expect(reps.length).toBe(5);
    reps.forEach((r, i) => {
      expect(Math.abs(r.peakMs - (times[i] ?? 0))).toBeLessThanOrEqual(40);
      expect(r.startMs).toBeLessThan(r.peakMs);
      expect(r.endMs).toBeGreaterThan(r.peakMs);
    });
  });

  it('merges peaks closer than the minimum spacing (taller wins)', () => {
    const samples = bumpySignal([1000], 4);
    // Add a slightly lower peak 300 ms later.
    for (const s of samples) {
      const d = Math.abs(s.t - 1300);
      if (d < 180) s.v = Math.max(s.v, 3 * (1 - d / 180));
    }
    const reps = detectReps(samples);
    expect(reps.length).toBe(1);
    expect(Math.abs((reps[0]?.peakMs ?? 0) - 1000)).toBeLessThanOrEqual(40);
    expect(MIN_PEAK_SPACING_MS).toBe(600);
  });

  it('ignores wiggles without prominence relative to the median', () => {
    // A noisy but flat signal: no candidate should survive.
    const samples: SignalSample[] = [];
    for (let t = 0; t <= 5000; t += 33) {
      samples.push({ t, v: 1 + 0.1 * Math.sin(t / 90) });
    }
    expect(detectReps(samples).length).toBe(0);
  });

  it('handles empty, constant and all-zero signals', () => {
    expect(detectReps([])).toEqual([]);
    expect(detectReps([{ t: 0, v: 0 }, { t: 33, v: 0 }, { t: 66, v: 0 }])).toEqual([]);
    const constant = Array.from({ length: 50 }, (_, i) => ({ t: i * 33, v: 2 }));
    expect(detectReps(constant)).toEqual([]);
  });

  it('caps rep boundaries at the midpoint toward neighbors', () => {
    // Two wide overlapping bumps: boundaries must not cross the midpoint.
    const reps = detectReps(bumpySignal([1000, 1800], 4));
    expect(reps.length).toBe(2);
    const [a, b] = reps;
    expect(a && b).toBeTruthy();
    if (a && b) {
      expect(a.endMs).toBeLessThanOrEqual(1400 + 1);
      expect(b.startMs).toBeGreaterThanOrEqual(1400 - 1);
    }
  });

  it('median and prominence primitives behave', () => {
    expect(median([])).toBe(0);
    expect(median([3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(prominenceAt([0, 5, 0], 1)).toBe(5);
    // Key col is the higher valley (4.5 on the right): prominence 0.5.
    expect(prominenceAt([4, 5, 4.5, 6], 1)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Signals + primary evaluation
// ---------------------------------------------------------------------------

const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

/** A 21-landmark open-hand-ish blob centered at (cx, cy) with scale s. */
function handAt(cx: number, cy: number, s = 0.1): HandFrame {
  const landmarks: Vec3[] = [];
  for (let i = 0; i < 21; i++) {
    landmarks.push(v(cx + ((i % 5) - 2) * 0.2 * s, cy + (Math.floor(i / 5) - 2) * 0.2 * s));
  }
  return { landmarks, confidence: 0.95 };
}

function poseAt(t: number, wristY = 0.5): PoseFrame {
  const arm = (side: -1 | 1) => ({
    shoulder: v(0.5 + side * 0.12, 0.3),
    elbow: v(0.5 + side * 0.2, 0.42),
    wrist: v(0.5 + side * 0.24, wristY),
    hip: v(0.5 + side * 0.07, 0.58),
  });
  return { t, left: arm(-1), right: arm(1), world: null, confidence: 0.9 };
}

function frameAt(t: number, wristX: number): LandmarkFrame {
  return {
    t,
    left: handAt(wristX, 0.5),
    right: null,
    face: null,
    pose: poseAt(t),
  };
}

describe('studio signal tracker', () => {
  it('produces windowed wrist velocity consistent with motion', () => {
    const tracker = new SignalTracker();
    let last = tracker.update(frameAt(0, 0.2));
    for (let i = 1; i <= 8; i++) {
      last = tracker.update(frameAt(i * 33, 0.2 + i * 0.02)); // ~0.6 u/s right
    }
    expect(last.left.wristSpeed).toBeGreaterThan(0.4);
    expect(last.left.velX).toBeGreaterThan(0.4);
    expect(Math.abs(last.left.velY)).toBeLessThan(0.1);
    // The absent right hand reads zero.
    expect(last.right.wristSpeed).toBe(0);
  });

  it('differences elbow velocity on real pose samples only', () => {
    const tracker = new SignalTracker();
    const mk = (t: number, poseT: number, wristY: number, interpolated?: boolean): LandmarkFrame => {
      const pose = poseAt(poseT, wristY);
      if (interpolated) pose.interpolated = true;
      return { t, left: handAt(0.3, 0.5), right: null, face: null, pose };
    };
    tracker.update(mk(0, 0, 0.55));
    // Interpolated frame with a wildly different angle must be skipped.
    tracker.update(mk(33, 33, 0.2, true));
    // Held frame (same pose.t) also skipped.
    tracker.update(mk(66, 0, 0.55));
    const out = tracker.update(mk(100, 100, 0.4)); // arm opening upward
    expect(out.left.elbowVel).not.toBe(0);
    // A >500 ms gap re-baselines to zero velocity.
    const out2 = tracker.update(mk(700, 700, 0.6));
    expect(out2.left.elbowVel).toBe(0);
  });

  it('bodySignalsOf reports shoulder and hip lines and standing score', () => {
    const body = bodySignalsOf(poseAt(0));
    expect(body.present).toBe(true);
    expect(body.shoulderWidth).toBeCloseTo(0.24, 5);
    expect(body.hipWidth).toBeCloseTo(0.14, 5);
    expect(body.shoulderCenterY).toBeCloseTo(0.3, 5);
    expect(body.hipCenterY).toBeCloseTo(0.58, 5);
    expect(body.standingScore).toBeGreaterThanOrEqual(0);
    expect(bodySignalsOf(null).present).toBe(false);
  });
});

describe('studio takes + primary signals', () => {
  it('defines exactly the 16 required takes in board order', () => {
    expect(TAKES.map((t) => t.id)).toEqual([...TAKE_IDS]);
    expect(TAKE_IDS.length).toBe(16);
  });

  it('every card carries real instruction copy', () => {
    for (const t of TAKES) {
      expect(t.howTo.length).toBeGreaterThan(80);
      expect(t.mistakes.length).toBeGreaterThan(30);
      expect(t.pacing.length).toBeGreaterThan(15);
      // No em dashes in user-facing text.
      expect(t.howTo).not.toContain('—');
      expect(t.mistakes).not.toContain('—');
      expect(t.pacing).not.toContain('—');
    }
    expect(TAKES.filter((t) => t.negative).length).toBe(3);
  });

  it('evaluates each primary signal kind on the right channel', () => {
    const sig = {
      left: {
        elbowAngle: 1,
        elbowVel: 5,
        wristSpeed: 1.2,
        velX: -1.1,
        velY: -2.0,
        bboxGrowth: 0.5,
        fist: 0.9,
        palm: 0.2,
        grip: 0.1,
      },
      right: {
        elbowAngle: 1,
        elbowVel: -3,
        wristSpeed: 0.4,
        velX: 0.3,
        velY: 0.2,
        bboxGrowth: 0,
        fist: 0.1,
        palm: 0.8,
        grip: 0.2,
      },
      body: bodySignalsOf(null),
    };
    expect(primarySignalValue(sig, takeDef('jab-left-x5').primary)).toBe(5);
    // Negative extension clamps to 0 (a folding right arm is not a jab).
    expect(primarySignalValue(sig, takeDef('jab-right-x5').primary)).toBe(0);
    expect(primarySignalValue(sig, takeDef('alt-jab-combo-x3').primary)).toBe(5);
    expect(primarySignalValue(sig, takeDef('palm-strike-right-x5').primary)).toBe(0.8);
    expect(primarySignalValue(sig, takeDef('fire-whip-left-x3').primary)).toBeCloseTo(1.1);
    expect(primarySignalValue(sig, takeDef('rising-flame-x3').primary)).toBeCloseTo(2.0);
    expect(primarySignalValue(sig, takeDef('neg-idle-20s').primary)).toBeCloseTo(1.2);
  });
});

// ---------------------------------------------------------------------------
// Stick figure sampling
// ---------------------------------------------------------------------------

describe('stick figure animations', () => {
  it('has an animation for every take and loops continuously', () => {
    for (const t of TAKES) {
      const anim = STICK_ANIMS[t.anim];
      expect(anim.durationMs).toBeGreaterThan(1000);
      const first = anim.frames[0];
      const last = anim.frames[anim.frames.length - 1];
      expect(first?.t).toBe(0);
      expect(last?.t).toBe(anim.durationMs);
      // Sampling anywhere yields finite joints.
      for (const tm of [0, anim.durationMs / 3, anim.durationMs, anim.durationMs * 2.5]) {
        const p = samplePose(anim, tm);
        for (const arm of [p.l, p.r]) {
          expect(Number.isFinite(arm.e[0])).toBe(true);
          expect(Number.isFinite(arm.w[1])).toBe(true);
        }
      }
    }
  });

  it('jab animations extend toward the viewer (z channel) and mirror', () => {
    const right = STICK_ANIMS['jab-right'];
    const left = STICK_ANIMS['jab-left'];
    // At the strike keyframe the z channel is hot on the striking arm.
    const strikeR = samplePose(right, 1090);
    expect(strikeR.r.z ?? 0).toBeGreaterThan(0.8);
    expect(strikeR.l.z ?? 0).toBeLessThan(0.1);
    const strikeL = samplePose(left, 1090);
    expect(strikeL.l.z ?? 0).toBeGreaterThan(0.8);
    // Mirrored x positions.
    expect(strikeL.l.w[0]).toBeCloseTo(1 - strikeR.r.w[0], 6);
  });
});

// ---------------------------------------------------------------------------
// Export assembly
// ---------------------------------------------------------------------------

function studioFrame(t: number, shoulderWidth: number): StudioFrame {
  const side = {
    elbowAngle: 1.5,
    elbowVel: 0,
    wristSpeed: 0.1,
    velX: 0,
    velY: 0,
    bboxGrowth: 0,
    fist: 0.5,
    palm: 0.1,
    grip: 0.1,
  };
  return {
    t,
    left: null,
    right: null,
    pose: null,
    signals: {
      left: { ...side },
      right: { ...side },
      body: {
        present: true,
        shoulderCenterY: 0.3,
        shoulderWidth,
        shoulderTiltRad: 0,
        hipCenterY: 0.58,
        hipWidth: 0.14,
        hipTiltRad: 0,
        standingScore: 0.8,
      },
    },
  };
}

function inMemoryTake(): StoredTake {
  return {
    key: takeKey('jab-left-x5', 1),
    id: 'jab-left-x5',
    takeIndex: 1,
    starred: true,
    status: 'confirmed',
    recordedAt: '2026-07-30T09:00:00.000Z',
    fps: 30,
    durationMs: 5000,
    cameraWidth: 640,
    cameraHeight: 480,
    frameClockOffset: -1234,
    thresholds: thresholdsFrom(DEFAULT_PROFILE),
    trimmedRange: [1000, 4000],
    frames: [0, 500, 1000, 1500, 2500, 3500, 4000, 4500].map((t, i) =>
      studioFrame(t, 0.2 + i * 0.01),
    ),
    reps: [
      { startMs: 200, endMs: 700, confirmed: true, manual: false }, // outside trim
      { startMs: 1200, endMs: 1800, confirmed: true, manual: false },
      { startMs: 2200, endMs: 2800, confirmed: null, manual: false }, // pending
      { startMs: 3000, endMs: 3400, confirmed: false, manual: false }, // rejected
      { startMs: 3600, endMs: 4400, confirmed: true, manual: true }, // clipped
    ],
    quality: [
      { tMs: 500, kind: 'framing' }, // outside trim
      { tMs: 2000, kind: 'confidence' },
      { tMs: 3800, kind: 'hand-lost' },
    ],
  };
}

describe('studio export assembly', () => {
  it('exports only trimmed frames, reps and quality events', () => {
    const out = buildTakeExport(inMemoryTake());
    expect(out.frames.map((f) => f.t)).toEqual([1000, 1500, 2500, 3500, 4000]);
    // Rejected dropped; outside-trim dropped; clipped rep clamped to range.
    expect(out.reps).toEqual([
      { startMs: 1200, endMs: 1800, confirmed: true, manual: false },
      { startMs: 2200, endMs: 2800, confirmed: false, manual: false },
      { startMs: 3600, endMs: 4000, confirmed: true, manual: true },
    ]);
    expect(out.quality.map((q) => q.tMs)).toEqual([2000, 3800]);
    expect(out.trimmedRange).toEqual([1000, 4000]);
    expect(out.id).toBe('jab-left-x5');
    expect(out.frameClockOffset).toBe(-1234);
  });

  it('assembles the full versioned envelope with derived meta', () => {
    const take = inMemoryTake();
    const out = buildExport({
      takes: [take],
      lightingNote: 'two lamps',
      cameraWidth: 640,
      cameraHeight: 480,
      motionProfile: DEFAULT_PROFILE,
      exportedAt: '2026-07-30T10:00:00.000Z',
    });
    expect(out.version).toBe(1);
    expect(out.exportedAt).toBe('2026-07-30T10:00:00.000Z');
    expect(out.meta.cameraWidth).toBe(640);
    expect(out.meta.lightingNote).toBe('two lamps');
    expect(out.meta.motionProfile).toBe(DEFAULT_PROFILE);
    // Median shoulder width over the 5 trimmed frames (0.22..0.26).
    expect(out.meta.distanceEstimate).toBeCloseTo(0.24, 6);
    expect(out.meta.framingSummary).toContain('2 quality warnings');
    expect(out.takes.length).toBe(1);
    // The whole envelope survives JSON round-tripping unchanged.
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it('summarizes clean takes without warnings', () => {
    const take = inMemoryTake();
    take.quality = [];
    const takes = [buildTakeExport(take)];
    expect(framingSummaryOf(takes)).toContain('No framing');
    expect(medianShoulderWidth([])).toBe(0);
  });

  it('exportFilename formats the date as yyyy-mm-dd', () => {
    expect(exportFilename(new Date(2026, 6, 30))).toBe('firebending-drill-2026-07-30.json');
    expect(exportFilename(new Date(2026, 0, 5))).toBe('firebending-drill-2026-01-05.json');
  });
});
