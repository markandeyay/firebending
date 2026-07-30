/**
 * Pure-logic tests for the calibration stats and the screen state machine.
 * No DOM, no camera. The ScreenManager is exercised headlessly through its
 * createLayer stub; the DOM-heavy parts (title visuals, calibration DOM,
 * flame wipe drawing) are intentionally thin and covered only by the
 * headless fallback paths.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALIBRATION,
  REFERENCE_SHOULDER_WIDTH,
  REFERENCE_WRIST_SPAN,
  VELOCITY_SCALE_MAX,
  VELOCITY_SCALE_MIN,
  captureCalibration,
  velocityScaleFor,
} from '../src/gestures/calibrationStats';
import {
  ScreenManager,
  flameWipe,
  type Screen,
} from '../src/screens/screenManager';
import {
  HAND_LANDMARK_COUNT,
  LM,
  type HandFrame,
  type LandmarkFrame,
  type PoseFrame,
  type Vec3,
} from '../src/tracking/types';

// ---------------------------------------------------------------------------
// Synthetic frame builders
// ---------------------------------------------------------------------------

/** Symmetric jitter cycle so medians land exactly on the nominal values. */
const JITTERS = [-0.006, -0.004, -0.002, 0, 0.002, 0.004, 0.006] as const;

function jitterAt(i: number): number {
  return JITTERS[i % JITTERS.length] ?? 0;
}

/** 21 landmarks at known positions: wrist exact, middle MCP `size` above. */
function makeHand(wrist: Vec3, size: number, j = 0): HandFrame {
  const landmarks: Vec3[] = [];
  for (let i = 0; i < HAND_LANDMARK_COUNT; i++) {
    landmarks.push({
      x: wrist.x + j + i * 0.001,
      y: wrist.y + j + i * 0.0005,
      z: wrist.z,
    });
  }
  landmarks[LM.WRIST] = { x: wrist.x + j, y: wrist.y - j, z: wrist.z };
  landmarks[LM.MIDDLE_MCP] = {
    x: wrist.x + j,
    y: wrist.y - j - (size + j * 0.5),
    z: wrist.z,
  };
  return { landmarks, confidence: 0.95 };
}

function frame(
  t: number,
  left: HandFrame | null,
  right: HandFrame | null,
): LandmarkFrame {
  return { t, left, right, face: null };
}

const LEFT_WRIST: Vec3 = { x: 0.3, y: 0.6, z: -0.02 };
const RIGHT_WRIST: Vec3 = { x: 0.7, y: 0.62, z: -0.02 };
const HAND_SIZE = 0.1;

function bothHandFrames(count: number): LandmarkFrame[] {
  const frames: LandmarkFrame[] = [];
  for (let i = 0; i < count; i++) {
    const j = jitterAt(i);
    frames.push(
      frame(
        i * 33,
        makeHand(LEFT_WRIST, HAND_SIZE, j),
        makeHand(RIGHT_WRIST, HAND_SIZE, -j),
      ),
    );
  }
  return frames;
}

// ---------------------------------------------------------------------------
// captureCalibration
// ---------------------------------------------------------------------------

describe('captureCalibration', () => {
  it('returns median wrists, span, and hand size from jittered frames', () => {
    const stats = captureCalibration(bothHandFrames(35));

    expect(stats.neutralLeftWrist.x).toBeCloseTo(LEFT_WRIST.x, 2);
    expect(stats.neutralLeftWrist.y).toBeCloseTo(LEFT_WRIST.y, 2);
    expect(stats.neutralLeftWrist.z).toBeCloseTo(LEFT_WRIST.z, 3);
    expect(stats.neutralRightWrist.x).toBeCloseTo(RIGHT_WRIST.x, 2);
    expect(stats.neutralRightWrist.y).toBeCloseTo(RIGHT_WRIST.y, 2);

    const expectedSpan = Math.hypot(
      RIGHT_WRIST.x - LEFT_WRIST.x,
      RIGHT_WRIST.y - LEFT_WRIST.y,
    );
    expect(stats.wristSpan).toBeCloseTo(expectedSpan, 2);
    expect(stats.handSize).toBeCloseTo(HAND_SIZE, 2);
    expect(stats.sampleCount).toBe(35);
  });

  it('filters frames with missing hands without skewing the medians', () => {
    const clean = bothHandFrames(35);
    const noisy: LandmarkFrame[] = [];
    for (let i = 0; i < clean.length; i++) {
      const f = clean[i];
      if (!f) continue;
      noisy.push(f);
      if (i % 4 === 0) {
        // Left hand drops out at an absurd position that would wreck a mean.
        noisy.push(frame(f.t + 10, null, makeHand({ x: 0.99, y: 0.01, z: 0 }, 0.4)));
      }
      if (i % 9 === 0) noisy.push(frame(f.t + 20, null, null));
    }

    const stats = captureCalibration(noisy);
    expect(stats.neutralLeftWrist.x).toBeCloseTo(LEFT_WRIST.x, 2);
    expect(stats.neutralLeftWrist.y).toBeCloseTo(LEFT_WRIST.y, 2);
    const expectedSpan = Math.hypot(
      RIGHT_WRIST.x - LEFT_WRIST.x,
      RIGHT_WRIST.y - LEFT_WRIST.y,
    );
    expect(stats.wristSpan).toBeCloseTo(expectedSpan, 2);
    // Span samples only come from frames with both hands present.
    expect(stats.sampleCount).toBe(35);
  });

  it('falls back to DEFAULT_CALIBRATION when no frame has both hands', () => {
    expect(captureCalibration([])).toEqual(DEFAULT_CALIBRATION);

    const oneHanded = [
      frame(0, makeHand(LEFT_WRIST, HAND_SIZE), null),
      frame(33, null, makeHand(RIGHT_WRIST, HAND_SIZE)),
      frame(66, null, null),
    ];
    expect(captureCalibration(oneHanded)).toEqual(DEFAULT_CALIBRATION);
  });

  it('scales velocity thresholds by distance from the camera', () => {
    // A near player (wide span) needs a smaller multiplier than a far one.
    const near = captureCalibration([
      frame(
        0,
        makeHand({ x: 0.1, y: 0.6, z: 0 }, HAND_SIZE),
        makeHand({ x: 0.9, y: 0.6, z: 0 }, HAND_SIZE),
      ),
    ]);
    const far = captureCalibration([
      frame(
        0,
        makeHand({ x: 0.4, y: 0.6, z: 0 }, HAND_SIZE),
        makeHand({ x: 0.6, y: 0.6, z: 0 }, HAND_SIZE),
      ),
    ]);

    expect(near.velocityScale).toBeLessThan(far.velocityScale);
    for (const s of [near, far]) {
      expect(Number.isFinite(s.velocityScale)).toBe(true);
      expect(s.velocityScale).toBeGreaterThanOrEqual(VELOCITY_SCALE_MIN);
      expect(s.velocityScale).toBeLessThanOrEqual(VELOCITY_SCALE_MAX);
    }
  });
});

describe('velocityScaleFor', () => {
  it('is 1 at the reference span and inversely proportional otherwise', () => {
    expect(velocityScaleFor(REFERENCE_WRIST_SPAN)).toBe(1);
    expect(velocityScaleFor(REFERENCE_WRIST_SPAN / 2)).toBeCloseTo(2, 5);
  });

  it('clamps degenerate spans instead of exploding thresholds', () => {
    expect(velocityScaleFor(0.01)).toBe(VELOCITY_SCALE_MAX);
    expect(velocityScaleFor(10)).toBe(VELOCITY_SCALE_MIN);
    expect(velocityScaleFor(0)).toBe(1);
    expect(velocityScaleFor(-1)).toBe(1);
    expect(velocityScaleFor(Number.NaN)).toBe(1);
  });

  it('prefers the real shoulder width over the wrist-span proxy', () => {
    expect(velocityScaleFor(REFERENCE_WRIST_SPAN, REFERENCE_SHOULDER_WIDTH)).toBe(1);
    // A far player: half-size shoulders double the scale even when the
    // wrist span would have said 1.
    expect(
      velocityScaleFor(REFERENCE_WRIST_SPAN, REFERENCE_SHOULDER_WIDTH / 2),
    ).toBeCloseTo(2, 5);
    // Degenerate shoulder measurements fall back to the span.
    expect(velocityScaleFor(REFERENCE_WRIST_SPAN, null)).toBe(1);
    expect(velocityScaleFor(REFERENCE_WRIST_SPAN / 2, 0)).toBeCloseTo(2, 5);
    expect(velocityScaleFor(REFERENCE_WRIST_SPAN / 2, Number.NaN)).toBeCloseTo(2, 5);
    // Shoulder scaling clamps like the span path.
    expect(velocityScaleFor(1, 0.001)).toBe(VELOCITY_SCALE_MAX);
  });
});

describe('shoulder width capture', () => {
  function withPose(frame: LandmarkFrame, width: number): LandmarkFrame {
    const arm = (x: number): PoseFrame['left'] => ({
      shoulder: { x, y: 0.32, z: 0 },
      elbow: { x, y: 0.48, z: 0 },
      wrist: { x, y: 0.6, z: 0 },
      hip: { x, y: 0.66, z: 0 },
    });
    const pose: PoseFrame = {
      t: frame.t,
      left: arm(0.5 - width / 2),
      right: arm(0.5 + width / 2),
      world: null,
      confidence: 1,
    };
    return { ...frame, pose };
  }

  it('records the median pose shoulder width and uses it for the scale', () => {
    const frames = bothHandFrames(35).map((f, i) =>
      withPose(f, 0.3 + (i % 2 === 0 ? 0.02 : -0.02)),
    );
    const stats = captureCalibration(frames);
    expect(stats.shoulderWidth).not.toBeNull();
    expect(stats.shoulderWidth ?? 0).toBeCloseTo(0.3, 1);
    expect(stats.velocityScale).toBeCloseTo(
      REFERENCE_SHOULDER_WIDTH / (stats.shoulderWidth ?? 1),
      5,
    );
  });

  it('leaves shoulderWidth null without pose (wrist-span scale)', () => {
    const stats = captureCalibration(bothHandFrames(35));
    expect(stats.shoulderWidth).toBeNull();
    expect(stats.velocityScale).toBeCloseTo(
      velocityScaleFor(stats.wristSpan),
      10,
    );
  });
});

describe('DEFAULT_CALIBRATION', () => {
  it('has a sane shape for replay and testing', () => {
    const d = DEFAULT_CALIBRATION;
    for (const w of [d.neutralLeftWrist, d.neutralRightWrist]) {
      expect(w.x).toBeGreaterThanOrEqual(0);
      expect(w.x).toBeLessThanOrEqual(1);
      expect(w.y).toBeGreaterThanOrEqual(0);
      expect(w.y).toBeLessThanOrEqual(1);
      expect(Number.isFinite(w.z)).toBe(true);
    }
    expect(d.neutralLeftWrist.x).toBeLessThan(d.neutralRightWrist.x);
    expect(d.wristSpan).toBeGreaterThan(0);
    expect(d.handSize).toBeGreaterThan(0);
    expect(d.velocityScale).toBe(1);
    expect(d.sampleCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ScreenManager (headless: stubbed layers, no DOM)
// ---------------------------------------------------------------------------

function stubLayer(): HTMLElement {
  return { remove(): void {} } as unknown as HTMLElement;
}

class LogScreen implements Screen {
  lastCtx: unknown = null;

  constructor(
    private readonly id: string,
    private readonly log: string[],
  ) {}

  enter(_root: HTMLElement, ctx?: unknown): void {
    this.lastCtx = ctx;
    this.log.push(`enter:${this.id}`);
  }

  exit(_root: HTMLElement): void {
    this.log.push(`exit:${this.id}`);
  }
}

describe('ScreenManager', () => {
  it('shows a registered screen and passes ctx to enter', async () => {
    const log: string[] = [];
    const title = new LogScreen('title', log);
    const m = new ScreenManager({ createLayer: stubLayer });
    m.register('title', title);

    expect(m.current).toBeNull();
    const ctx = { hello: true };
    await m.show('title', ctx);

    expect(m.current).toBe('title');
    expect(log).toEqual(['enter:title']);
    expect(title.lastCtx).toBe(ctx);
  });

  it('rejects when showing an unregistered screen', async () => {
    const m = new ScreenManager({ createLayer: stubLayer });
    await expect(m.show('arena')).rejects.toThrow('Screen not registered');
  });

  it('exits the old screen before entering the new one', async () => {
    const log: string[] = [];
    const m = new ScreenManager({ createLayer: stubLayer });
    m.register('title', new LogScreen('title', log));
    m.register('calibration', new LogScreen('calibration', log));

    await m.show('title');
    await m.show('calibration');

    expect(log).toEqual(['enter:title', 'exit:title', 'enter:calibration']);
    expect(m.current).toBe('calibration');
  });

  it('runs the transition around the swap, but not on the first show', async () => {
    const log: string[] = [];
    const m = new ScreenManager({
      createLayer: stubLayer,
      transition: async (_host, swap) => {
        log.push('wipe:cover');
        await swap();
        log.push('wipe:reveal');
      },
    });
    m.register('title', new LogScreen('title', log));
    m.register('calibration', new LogScreen('calibration', log));

    await m.show('title');
    expect(log).toEqual(['enter:title']);

    await m.show('calibration');
    expect(log).toEqual([
      'enter:title',
      'wipe:cover',
      'exit:title',
      'enter:calibration',
      'wipe:reveal',
    ]);
  });

  it('treats showing the active screen as a no-op', async () => {
    const log: string[] = [];
    const m = new ScreenManager({ createLayer: stubLayer });
    m.register('title', new LogScreen('title', log));

    await m.show('title');
    await m.show('title');
    expect(log).toEqual(['enter:title']);
  });

  it('serializes overlapping show calls', async () => {
    const log: string[] = [];
    const m = new ScreenManager({ createLayer: stubLayer });
    m.register('title', new LogScreen('title', log));
    m.register('calibration', new LogScreen('calibration', log));
    m.register('arena', new LogScreen('arena', log));

    await m.show('title');
    const a = m.show('calibration');
    const b = m.show('arena');
    await Promise.all([a, b]);

    expect(log).toEqual([
      'enter:title',
      'exit:title',
      'enter:calibration',
      'exit:calibration',
      'enter:arena',
    ]);
    expect(m.current).toBe('arena');
  });

  it('supports async enter and exit hooks', async () => {
    const log: string[] = [];
    const slow: Screen = {
      async enter() {
        await Promise.resolve();
        log.push('enter:slow');
      },
      async exit() {
        await Promise.resolve();
        log.push('exit:slow');
      },
    };
    const m = new ScreenManager({ createLayer: stubLayer });
    m.register('title', slow);
    m.register('arena', new LogScreen('arena', log));

    await m.show('title');
    await m.show('arena');
    expect(log).toEqual(['enter:slow', 'exit:slow', 'enter:arena']);
  });
});

describe('flameWipe (headless fallback)', () => {
  it('still runs atCover and resolves without a DOM', async () => {
    let covered = false;
    await flameWipe({} as HTMLElement, () => {
      covered = true;
    });
    expect(covered).toBe(true);
  });
});
