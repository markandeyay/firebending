/**
 * Signal conditioning for the tracking pipeline (spec Sections 5 and 6):
 * - OneEuroFilter / OneEuroVec3: One Euro filtering (Casiez et al. 2012) for
 *   per-landmark smoothing with low lag on fast motion.
 * - HandFilterBank: 21 Vec3 filters for a whole hand, with stale-reset so a
 *   reacquired hand never smears from its old position.
 * - Hysteresis: pose enter/exit debouncing (never flips on a single frame).
 * - ConfidenceGate: a hand is "tracked" only after sustained confidence,
 *   "lost" only after sustained absence. No flicker.
 * - FilteredSource: a LandmarkSource decorator that applies gating and
 *   smoothing so gameplay code only ever sees clean frames.
 */

import type {
  FaceFrame,
  FrameListener,
  HandFrame,
  LandmarkFrame,
  LandmarkSource,
  Vec3,
} from './types';
import { HAND_LANDMARK_COUNT, LM } from './types';

// ---------------------------------------------------------------------------
// One Euro filter (scalar)
// ---------------------------------------------------------------------------

export interface OneEuroOptions {
  /** Minimum cutoff frequency in Hz. Lower = smoother at rest. */
  minCutoff?: number;
  /** Speed coefficient. Higher = less lag during fast motion. */
  beta?: number;
  /** Cutoff frequency for the derivative lowpass, in Hz. */
  dCutoff?: number;
}

/**
 * Hand-landmark tuning. The spec Section 5 starting values (beta 0.007,
 * dCutoff 1.0) were tuned for pixel-scale signals; in normalized [0..1]
 * coordinates a punch derivative is only ~3 units/sec, so beta 0.007 barely
 * raised the adaptive cutoff and a 3-frame punch spike lost ~44% of its
 * windowed speed through the filter (the reason the repo carried
 * REPLAY_VELOCITY_SCALE 1.8). beta 4.0 with dCutoff 4.0 lets the cutoff
 * follow fast motion (spike attenuation ~1.5%, measured in
 * tests/oneEuroResponse.test.ts) while rest jitter stays within ~1.25x of
 * the old tuning's smoothing.
 */
export const ONE_EURO_DEFAULTS: Required<OneEuroOptions> = {
  minCutoff: 1.0,
  beta: 4.0,
  dCutoff: 4.0,
};

/** Guard against zero or negative dt from duplicate/reordered timestamps. */
const MIN_DT_SEC = 1e-4;

/** Lowpass smoothing factor for a given cutoff frequency and time step. */
function smoothingAlpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

/**
 * Standard One Euro filter for a scalar signal. Call filter(value, tSec) with
 * a monotonic timestamp in seconds; irregular frame intervals are handled by
 * recomputing alpha from the actual dt each call.
 */
export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;

  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(options: OneEuroOptions = {}) {
    this.minCutoff = options.minCutoff ?? ONE_EURO_DEFAULTS.minCutoff;
    this.beta = options.beta ?? ONE_EURO_DEFAULTS.beta;
    this.dCutoff = options.dCutoff ?? ONE_EURO_DEFAULTS.dCutoff;
  }

  filter(value: number, tSec: number): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = value;
      this.tPrev = tSec;
      this.dxPrev = 0;
      return value;
    }

    const dt = Math.max(tSec - this.tPrev, MIN_DT_SEC);

    // Filtered derivative drives the adaptive cutoff.
    const dx = (value - this.xPrev) / dt;
    const alphaD = smoothingAlpha(this.dCutoff, dt);
    const dxHat = alphaD * dx + (1 - alphaD) * this.dxPrev;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const alpha = smoothingAlpha(cutoff, dt);
    const xHat = alpha * value + (1 - alpha) * this.xPrev;

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = tSec;
    return xHat;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

// ---------------------------------------------------------------------------
// One Euro filter (Vec3)
// ---------------------------------------------------------------------------

/** Three independent scalar One Euro filters, one per axis. */
export class OneEuroVec3 {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;
  private readonly fz: OneEuroFilter;

  constructor(options: OneEuroOptions = {}) {
    this.fx = new OneEuroFilter(options);
    this.fy = new OneEuroFilter(options);
    this.fz = new OneEuroFilter(options);
  }

  filter(v: Vec3, tSec: number): Vec3 {
    return {
      x: this.fx.filter(v.x, tSec),
      y: this.fy.filter(v.y, tSec),
      z: this.fz.filter(v.z, tSec),
    };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
}

// ---------------------------------------------------------------------------
// Hand filter bank
// ---------------------------------------------------------------------------

/**
 * If a hand goes unfiltered for longer than this, its filters are stale
 * (tracking dropout, hand left frame) and must reset rather than smear the
 * old position into the reacquired one.
 */
export const HAND_FILTER_RESET_GAP_SEC = 0.5;

/**
 * One OneEuroVec3 per hand landmark. filter() returns a new HandFrame with
 * smoothed landmarks and the confidence passed through untouched. If more
 * than HAND_FILTER_RESET_GAP_SEC elapsed since the last filtered frame, the
 * bank resets first, so the first frame after reacquisition passes through
 * unsmoothed at the new position.
 */
export class HandFilterBank {
  private readonly filters: OneEuroVec3[];
  private lastTSec: number | null = null;

  constructor(options: OneEuroOptions = {}) {
    this.filters = Array.from(
      { length: HAND_LANDMARK_COUNT },
      () => new OneEuroVec3(options)
    );
  }

  filter(hand: HandFrame, tSec: number): HandFrame {
    if (this.lastTSec !== null && tSec - this.lastTSec > HAND_FILTER_RESET_GAP_SEC) {
      this.reset();
    }
    this.lastTSec = tSec;

    const landmarks = hand.landmarks.map((lm, i) => {
      const f = this.filters[i];
      return f ? f.filter(lm, tSec) : { x: lm.x, y: lm.y, z: lm.z };
    });

    return { landmarks, confidence: hand.confidence };
  }

  reset(): void {
    for (const f of this.filters) f.reset();
    this.lastTSec = null;
  }
}

// ---------------------------------------------------------------------------
// Hysteresis (pose enter/exit debouncing, spec Section 6)
// ---------------------------------------------------------------------------

/**
 * Debounced boolean over a 0..1 score. Entering requires score above the
 * enter threshold for enterFrames consecutive frames; leaving requires score
 * below the exit threshold for exitFrames consecutive frames. A single frame
 * can never flip the state.
 */
export class Hysteresis {
  private active = false;
  private enterCount = 0;
  private exitCount = 0;

  constructor(
    private readonly enterThreshold = 0.75,
    private readonly enterFrames = 4,
    private readonly exitThreshold = 0.55,
    private readonly exitFrames = 6
  ) {}

  update(score: number): boolean {
    if (!this.active) {
      if (score > this.enterThreshold) {
        this.enterCount++;
        if (this.enterCount >= this.enterFrames) {
          this.active = true;
          this.enterCount = 0;
          this.exitCount = 0;
        }
      } else {
        this.enterCount = 0;
      }
    } else {
      if (score < this.exitThreshold) {
        this.exitCount++;
        if (this.exitCount >= this.exitFrames) {
          this.active = false;
          this.enterCount = 0;
          this.exitCount = 0;
        }
      } else {
        this.exitCount = 0;
      }
    }
    return this.active;
  }

  get isActive(): boolean {
    return this.active;
  }

  reset(): void {
    this.active = false;
    this.enterCount = 0;
    this.exitCount = 0;
  }
}

// ---------------------------------------------------------------------------
// Confidence gate (spec Section 5)
// ---------------------------------------------------------------------------

/**
 * A hand counts as "tracked" only after acquireFrames consecutive frames with
 * confidence above the threshold, and as "lost" only after loseFrames
 * consecutive frames at or below it (a null confidence means the hand is
 * absent and counts as below). Flicker around the threshold resets the
 * in-progress counter and never toggles the state.
 */
export class ConfidenceGate {
  private tracked = false;
  private aboveCount = 0;
  private belowCount = 0;

  constructor(
    private readonly threshold = 0.7,
    private readonly acquireFrames = 10,
    private readonly loseFrames = 15
  ) {}

  update(confidence: number | null): boolean {
    const above = confidence !== null && confidence > this.threshold;
    if (!this.tracked) {
      if (above) {
        this.aboveCount++;
        if (this.aboveCount >= this.acquireFrames) {
          this.tracked = true;
          this.aboveCount = 0;
          this.belowCount = 0;
        }
      } else {
        this.aboveCount = 0;
      }
    } else {
      if (!above) {
        this.belowCount++;
        if (this.belowCount >= this.loseFrames) {
          this.tracked = false;
          this.aboveCount = 0;
          this.belowCount = 0;
        }
      } else {
        this.belowCount = 0;
      }
    }
    return this.tracked;
  }

  get isTracked(): boolean {
    return this.tracked;
  }

  reset(): void {
    this.tracked = false;
    this.aboveCount = 0;
    this.belowCount = 0;
  }
}

// ---------------------------------------------------------------------------
// FilteredSource
// ---------------------------------------------------------------------------

/**
 * Light smoothing for head pose: higher minCutoff than the hand default so
 * face lag stays low; heavy parallax smoothing belongs to the camera rig.
 */
export const FACE_FILTER_DEFAULTS: Required<OneEuroOptions> = {
  minCutoff: 1.5,
  beta: 0.007,
  dCutoff: 1.0,
};

export interface FilteredSourceOptions {
  /** One Euro tuning for hand landmarks. Defaults to ONE_EURO_DEFAULTS. */
  hand?: OneEuroOptions;
  /** One Euro tuning for face yaw/pitch/position. Defaults to FACE_FILTER_DEFAULTS. */
  face?: OneEuroOptions;
}

/**
 * LandmarkSource decorator: wraps any inner source (live or replay) and
 * emits gated, smoothed frames.
 *
 * - Per-hand ConfidenceGate: a hand that is not gated in emits as null even
 *   if the raw frame contains it. Gate state advances every frame.
 * - Gated-in hands are smoothed by a HandFilterBank (confidence untouched).
 *   Because gated-out hands are never fed to the bank, the bank's stale-reset
 *   handles reacquisition without smearing.
 * - Face yaw/pitch/position get a light One Euro; face filters reset after a
 *   face absence longer than HAND_FILTER_RESET_GAP_SEC.
 *
 * start()/stop() delegate to the inner source. The subscription to the inner
 * source is made at construction; call dispose() to detach entirely.
 */
export class FilteredSource implements LandmarkSource {
  private readonly listeners = new Set<FrameListener>();

  private readonly leftGate = new ConfidenceGate();
  private readonly rightGate = new ConfidenceGate();
  private readonly leftBank: HandFilterBank;
  private readonly rightBank: HandFilterBank;

  private readonly faceYaw: OneEuroFilter;
  private readonly facePitch: OneEuroFilter;
  private readonly facePosition: OneEuroVec3;
  private lastFaceTSec: number | null = null;

  private readonly detach: () => void;

  constructor(
    private readonly inner: LandmarkSource,
    options: FilteredSourceOptions = {}
  ) {
    const handOptions = options.hand ?? ONE_EURO_DEFAULTS;
    const faceOptions = options.face ?? FACE_FILTER_DEFAULTS;
    this.leftBank = new HandFilterBank(handOptions);
    this.rightBank = new HandFilterBank(handOptions);
    this.faceYaw = new OneEuroFilter(faceOptions);
    this.facePitch = new OneEuroFilter(faceOptions);
    this.facePosition = new OneEuroVec3(faceOptions);
    this.detach = inner.onFrame((frame) => this.process(frame));
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  stop(): void {
    this.inner.stop();
  }

  /** Unsubscribe from the inner source. The instance is dead afterward. */
  dispose(): void {
    this.detach();
    this.listeners.clear();
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private process(frame: LandmarkFrame): void {
    const tSec = frame.t / 1000;
    const out: LandmarkFrame = {
      t: frame.t,
      left: this.processHand(frame.left, this.leftGate, this.leftBank, tSec),
      right: this.processHand(frame.right, this.rightGate, this.rightBank, tSec),
      face: this.processFace(frame.face, tSec),
    };
    for (const l of this.listeners) l(out);
  }

  private processHand(
    hand: HandFrame | null,
    gate: ConfidenceGate,
    bank: HandFilterBank,
    tSec: number
  ): HandFrame | null {
    const tracked = gate.update(hand ? hand.confidence : null);
    if (!tracked || !hand) return null;
    return bank.filter(hand, tSec);
  }

  private processFace(face: FaceFrame | null, tSec: number): FaceFrame | null {
    if (!face) return null;
    if (this.lastFaceTSec !== null && tSec - this.lastFaceTSec > HAND_FILTER_RESET_GAP_SEC) {
      this.faceYaw.reset();
      this.facePitch.reset();
      this.facePosition.reset();
    }
    this.lastFaceTSec = tSec;
    return {
      yaw: this.faceYaw.filter(face.yaw, tSec),
      pitch: this.facePitch.filter(face.pitch, tSec),
      position: this.facePosition.filter(face.position, tSec),
      confidence: face.confidence,
    };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Wrist velocity between two hand frames, in normalized screen units per
 * second. The gesture layer owns multi-frame velocity windows (spec: filtered
 * over the last 6 frames); this is the single-step building block.
 */
export function wristVelocity(prev: HandFrame, curr: HandFrame, dtSec: number): Vec3 {
  const a = prev.landmarks[LM.WRIST];
  const b = curr.landmarks[LM.WRIST];
  if (!a || !b) return { x: 0, y: 0, z: 0 };
  const dt = Math.max(dtSec, MIN_DT_SEC);
  return {
    x: (b.x - a.x) / dt,
    y: (b.y - a.y) / dt,
    z: (b.z - a.z) / dt,
  };
}
