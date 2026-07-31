/**
 * Capture-rate helpers (Phase 1 hard gate): the rolling arrival-rate
 * meter, gate classification, per-take instantaneous fps stats, the
 * export-level capture-health summary, and export back-compat for stored
 * takes recorded before the gate existed (no fpsMean/fpsMin). DOM-free.
 */

import { describe, expect, it } from 'vitest';
import {
  RATE_GATE_FPS,
  RATE_WINDOW,
  RollingRateMeter,
  TARGET_CAPTURE_FPS,
  captureHealthOf,
  classifyRate,
  takeFpsStats,
} from '../src/studio/captureRate';
import {
  buildExport,
  buildTakeExport,
  takeKey,
  type StoredTake,
} from '../src/studio/exportBuild';
import type { StudioFrame } from '../src/studio/exportSchema';
import { DEFAULT_PROFILE, thresholdsFrom } from '../src/gestures/profile';

// ---------------------------------------------------------------------------
// Constants and classification
// ---------------------------------------------------------------------------

describe('capture gate constants and classification', () => {
  it('targets 30 fps with a 28 fps jitter-absorbing gate', () => {
    expect(TARGET_CAPTURE_FPS).toBe(30);
    expect(RATE_GATE_FPS).toBe(28);
    expect(RATE_GATE_FPS).toBeLessThan(TARGET_CAPTURE_FPS);
  });

  it('classifies at the gate boundary', () => {
    expect(classifyRate(60)).toBe('good');
    expect(classifyRate(29.8)).toBe('good');
    expect(classifyRate(28)).toBe('good'); // at the gate is good
    expect(classifyRate(27.99)).toBe('warn');
    expect(classifyRate(14)).toBe('warn');
    expect(classifyRate(0)).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// Rolling rate meter
// ---------------------------------------------------------------------------

describe('rolling rate meter', () => {
  it('needs two arrivals before reporting a rate', () => {
    const m = new RollingRateMeter();
    expect(m.fps()).toBeNull();
    m.push(1000);
    expect(m.fps()).toBeNull();
    m.push(1033.3);
    expect(m.fps()).not.toBeNull();
  });

  it('measures a steady 30 Hz stream as ~30 fps', () => {
    const m = new RollingRateMeter();
    for (let i = 0; i < 90; i++) m.push(i * (1000 / 30));
    expect(m.fps() ?? 0).toBeCloseTo(30, 3);
  });

  it('rolls: only the most recent window counts', () => {
    const m = new RollingRateMeter();
    // 100 slow arrivals at 10 Hz...
    let t = 0;
    for (let i = 0; i < 100; i++) {
      m.push(t);
      t += 100;
    }
    expect(m.fps() ?? 0).toBeCloseTo(10, 3);
    // ...then a full window of 30 Hz arrivals: the slow past is forgotten.
    for (let i = 0; i < RATE_WINDOW; i++) {
      t += 1000 / 30;
      m.push(t);
    }
    expect(m.count()).toBe(RATE_WINDOW);
    expect(m.fps() ?? 0).toBeCloseTo(30, 3);
  });

  it('fpsAt reads LOW when the stream stalls', () => {
    const m = new RollingRateMeter();
    for (let i = 0; i < 60; i++) m.push(i * (1000 / 30));
    const last = 59 * (1000 / 30);
    // Healthy at the moment of the last arrival.
    expect(m.fpsAt(last) ?? 0).toBeCloseTo(30, 3);
    // Two stalled seconds later the same window reads far under the gate.
    expect(m.fpsAt(last + 2000) ?? 0).toBeLessThan(RATE_GATE_FPS);
  });

  it('reset clears the window', () => {
    const m = new RollingRateMeter();
    m.push(0);
    m.push(33);
    m.reset();
    expect(m.count()).toBe(0);
    expect(m.fps()).toBeNull();
  });

  it('handles degenerate zero-span pushes', () => {
    const m = new RollingRateMeter();
    m.push(500);
    m.push(500);
    expect(m.fps()).toBeNull();
    expect(m.fpsAt(500)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-take fps stats
// ---------------------------------------------------------------------------

describe('per-take fps stats', () => {
  it('uniform 30 fps frames yield mean == min == 30', () => {
    const times = Array.from({ length: 61 }, (_, i) => i * (1000 / 30));
    const s = takeFpsStats(times);
    expect(s.meanFps).toBeCloseTo(30, 6);
    expect(s.minFps).toBeCloseTo(30, 6);
  });

  it('min tracks the single worst gap', () => {
    // Mostly 30 fps with one 100 ms dropout gap (10 fps instantaneous).
    const times = [0, 33.3333, 66.6667, 166.6667, 200.0];
    const s = takeFpsStats(times);
    expect(s.minFps).toBeCloseTo(10, 3);
    expect(s.meanFps).toBeGreaterThan(s.minFps);
    expect(s.meanFps).toBeLessThan(30.01);
  });

  it('returns zeros without at least one positive gap', () => {
    expect(takeFpsStats([])).toEqual({ meanFps: 0, minFps: 0 });
    expect(takeFpsStats([100])).toEqual({ meanFps: 0, minFps: 0 });
    expect(takeFpsStats([100, 100])).toEqual({ meanFps: 0, minFps: 0 });
  });

  it('skips duplicate timestamps instead of dividing by zero', () => {
    const s = takeFpsStats([0, 50, 50, 100]);
    expect(s.meanFps).toBeCloseTo(20, 6);
    expect(s.minFps).toBeCloseTo(20, 6);
  });
});

// ---------------------------------------------------------------------------
// Capture-health summary
// ---------------------------------------------------------------------------

describe('capture-health summary', () => {
  it('summarizes min, median and takes under the gate', () => {
    const h = captureHealthOf([31, 14, 29]);
    expect(h.minFps).toBe(14);
    expect(h.medianFps).toBe(29);
    expect(h.takesUnderGate).toBe(1);
  });

  it('even-count median averages the middle pair', () => {
    const h = captureHealthOf([30, 32, 28, 26]);
    expect(h.medianFps).toBe(29);
    expect(h.takesUnderGate).toBe(1); // only 26 is under 28
  });

  it('empty input yields all zeros', () => {
    expect(captureHealthOf([])).toEqual({ minFps: 0, medianFps: 0, takesUnderGate: 0 });
  });
});

// ---------------------------------------------------------------------------
// Export back-compat: old takes without the new fields
// ---------------------------------------------------------------------------

function bareFrame(t: number): StudioFrame {
  const side = {
    elbowAngle: 0,
    elbowVel: 0,
    wristSpeed: 0,
    velX: 0,
    velY: 0,
    bboxGrowth: 0,
    fist: 0,
    palm: 0,
    grip: 0,
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
        present: false,
        shoulderCenterY: 0,
        shoulderWidth: 0,
        shoulderTiltRad: 0,
        hipCenterY: 0,
        hipWidth: 0,
        hipTiltRad: 0,
        standingScore: 0,
      },
    },
  };
}

/** A StoredTake WITHOUT fpsMean/fpsMin: the pre-gate persisted shape. */
function oldStoredTake(fps: number, takeIndex = 1): StoredTake {
  return {
    key: takeKey('jab-left-x5', takeIndex),
    id: 'jab-left-x5',
    takeIndex,
    starred: takeIndex === 1,
    status: 'recorded',
    recordedAt: '2026-07-29T09:00:00.000Z',
    fps,
    durationMs: 2000,
    cameraWidth: 640,
    cameraHeight: 480,
    frameClockOffset: 0,
    thresholds: thresholdsFrom(DEFAULT_PROFILE),
    trimmedRange: [0, 2000],
    frames: [0, 500, 1000, 1500, 2000].map(bareFrame),
    reps: [],
    quality: [],
  };
}

describe('export back-compat with pre-gate takes', () => {
  it('a stored take without fpsMean/fpsMin exports without the keys', () => {
    const out = buildTakeExport(oldStoredTake(30));
    expect('fpsMean' in out).toBe(false);
    expect('fpsMin' in out).toBe(false);
    expect(out.fps).toBe(30);
  });

  it('a stored take WITH the stats carries them into the export', () => {
    const stored = oldStoredTake(29.7);
    stored.fpsMean = 29.9;
    stored.fpsMin = 21.4;
    const out = buildTakeExport(stored);
    expect(out.fpsMean).toBeCloseTo(29.9, 9);
    expect(out.fpsMin).toBeCloseTo(21.4, 9);
  });

  it('buildExport derives captureHealth from per-take measured fps', () => {
    const out = buildExport({
      takes: [oldStoredTake(31, 1), oldStoredTake(14, 2), oldStoredTake(29, 3)],
      lightingNote: '',
      cameraWidth: 640,
      cameraHeight: 480,
      motionProfile: null,
      exportedAt: '2026-07-31T10:00:00.000Z',
    });
    expect(out.captureHealth).toEqual({ minFps: 14, medianFps: 29, takesUnderGate: 1 });
    // The envelope (old takes included) survives JSON round-tripping.
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});
