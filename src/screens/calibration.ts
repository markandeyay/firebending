/**
 * Calibration ritual (spec Section 8). Shows a dimmed mirrored webcam feed
 * (or a plain dark backdrop in replay mode), two ink-outline hands, and the
 * prompt "Raise your hands." Frames come from a provided LandmarkSource;
 * per-hand ConfidenceGates decide when tracking is stable (Section 5 gating:
 * 10 consecutive frames above 0.7). When both hands are tracked the outlines
 * snap to the player's wrists and ignite, the prompt swaps to "Bender
 * recognized.", and a 2 second window of frames is captured and reduced to
 * CalibrationStats.
 *
 * FRAMING GATE (R3 Phase 3, live path only): after the stats capture and
 * BEFORE the motion steps, the ritual holds at a hard framing gate
 * (src/game/framingGate.ts): whole body framed, head top visible, both
 * hands tracked, standing, all continuously for 2 s. The webcam PIP panel
 * (src/ui/pip.ts) is mounted for the whole ritual and shows the silhouette
 * guide plus the corrective line while the gate runs. A device whose pose
 * tracker never yields a sample skips the gate after FRAMING_POSE_WAIT_MS.
 * Replay/test paths (motionSteps unset) skip the gate entirely.
 *
 * MOTION STEPS (live path only, ctx.motionSteps === true): after the stats
 * capture the ritual continues into two motion-capture steps that build a
 * per-player MotionProfile v2 (src/gestures/profile.ts):
 *   1. "Throw three punches."     peak punch speed + bbox growth + peak
 *                                 elbow-extension angular velocity (median
 *                                 of 3), plus the neutral elbow velocity
 *                                 from the still lead-in. The punch step
 *                                 ALSO measures the per-arm forward-punch
 *                                 REACH peak (dist(pose shoulder, pose
 *                                 wrist) / shoulder width, sampled inside
 *                                 each punch's +-250 ms pairing window so a
 *                                 hanging arm between punches cannot
 *                                 register) and persists it into the
 *                                 profile's optional maxReachLeftSw /
 *                                 maxReachRightSw seeds for the phase
 *                                 engine's extension normalizer, clamped to
 *                                 the plausible forward band (see
 *                                 reachSeedSw in gestures/calibrationStats)
 *   2. "Push your palms forward." peak palm speed + bbox growth
 * A live ink-brush meter shows the three fusion signals (windowed wrist
 * speed, bbox growth, elbow angular velocity) with peak markers and a
 * "1 of 3" counter. The step works with or without body pose: when pose
 * never appears the elbow fields fall back to DEFAULT_PROFILE values. A
 * stored profile skips both steps (fast reload); pressing R clears it and
 * runs them (a stale v1 profile fails validation and forces the steps). A
 * step that detects nothing for 20 seconds falls back to DEFAULT_PROFILE so
 * the player is never trapped. Replay/test paths (motionSteps unset) keep
 * the classic behavior and promise semantics exactly: complete right after
 * the capture.
 *
 * The screen then resolves its `calibrated` promise and calls ctx.onComplete
 * with the stats and the profile; the orchestrator transitions out with the
 * flame wipe. Timing is frame-driven (LandmarkFrame.t), so replay fixtures
 * stepped synchronously calibrate deterministically.
 */

import type { Screen } from './screenManager';
import type { HandFrame, LandmarkFrame, LandmarkSource } from '../tracking/types';
import { LM } from '../tracking/types';
import { ConfidenceGate } from '../tracking/filters';
import {
  captureCalibration,
  poseReachSw,
  reachSeedSw,
  type CalibrationStats,
} from '../gestures/calibrationStats';
import { handSpeed } from '../gestures/poses';
import { bboxGrowthRate } from '../gestures/motion';
import { elbowAngle, elbowAngularVelocity } from '../tracking/poseSource';
import {
  DEFAULT_PROFILE,
  clearProfile,
  loadProfile,
  saveProfile,
  type MotionProfile,
} from '../gestures/profile';
import { handOutline } from '../ui/handOutlines';
import { HelpPanel } from '../ui/helpPanel';
import { WebcamPip } from '../ui/pip';
import { FramingGate } from '../game/framingGate';
import '../ui/theme.css';

export interface CalibrationContext {
  /** Frame stream. Pass the raw (ungated) source; this screen gates itself. */
  source: LandmarkSource;
  /** Optional live preview: an existing video element showing the camera. */
  video?: HTMLVideoElement;
  /** Or the raw camera stream; a video element is created around it. */
  stream?: MediaStream;
  /**
   * Called once with the captured stats and the motion profile (null when
   * the motion steps did not run). The `calibrated` promise also resolves.
   */
  onComplete?: (stats: CalibrationStats, profile: MotionProfile | null) => void;
  /**
   * Called once when both hands gate in and the outlines ignite (the whoosh
   * moment). Added at T062 integration so the flow can fire engine.ignite().
   */
  onIgnite?: () => void;
  /**
   * Run the punch/push motion-capture steps after the stats capture. Live
   * camera path only; replay and test paths leave this unset and complete
   * immediately after the capture, exactly as before.
   */
  motionSteps?: boolean;
}

/** Length of the stat capture window after ignition, in frame time. */
export const CAPTURE_WINDOW_MS = 2000;

// ---------------------------------------------------------------------------
// Motion step tuning (frame-time milliseconds unless noted)
// ---------------------------------------------------------------------------

/** Windowed-speed window, matching the move engine's AIM_WINDOW_FRAMES. */
const MOTION_WINDOW_FRAMES = 6;
/** Neutral baseline sampling time at the start of the punch step. */
export const NEUTRAL_SAMPLE_MS = 800;
/** A punch must exceed max(this, 4x neutral speed) windowed speed. */
export const PUNCH_SPEED_FLOOR = 0.6;
/** A push must exceed max(this, 4x neutral growth) windowed bbox growth. */
export const PUSH_GROWTH_FLOOR = 0.8;
/** Multiplier over the measured neutral baseline for event detection. */
export const DETECT_NEUTRAL_MULT = 4;
/** Peaks are paired with the other signal's max inside this half-window. */
export const PEAK_PAIR_WINDOW_MS = 250;
/** Punches required in step 1. */
export const PUNCHES_REQUIRED = 3;
/** Pushes required in step 2 (either hand; two total). */
export const PUSHES_REQUIRED = 2;
/** A step that detects nothing for this long falls back to DEFAULT_PROFILE. */
export const STEP_TIMEOUT_MS = 20000;
/**
 * Framing step (R3 Phase 3): if NO body pose sample arrives within this long
 * of entering the step, the device has no working pose tracker and the gate
 * is skipped (poseless live play stays supported). Once any pose has been
 * seen the gate is hard: it must hold FRAMING_HOLD_SEC to continue.
 */
export const FRAMING_POSE_WAIT_MS = 10000;
/** How long the "Profile loaded" / fallback notices stay up. */
export const NOTICE_MS = 2000;

/** Meter display scales: full bar at these values. */
const METER_SPEED_FULL = 3.0; // normalized units/sec
const METER_GROWTH_FULL = 5.0; // 1/sec
const METER_ELBOW_FULL = 12.0; // rad/s
/** A pose-sample gap beyond this re-baselines the elbow differencing. */
const ELBOW_GAP_MS = 500;

/** Resting positions for the hand outlines before tracking locks on. */
const REST_LEFT = { x: 0.32, y: 0.55 };
const REST_RIGHT = { x: 0.68, y: 0.55 };

// The ink hand outline moved to src/ui/handOutlines.ts (T070) so the
// tracking-loss overlay shares the same asset style.

type Phase =
  | 'waiting'
  | 'capturing'
  | 'framing' // R3 P3: hard framing gate (live path), before the motion steps
  | 'profile-note' // stored profile found: brief notice, then done
  | 'punches'
  | 'pushes'
  | 'fallback-note' // step timed out: brief notice, then done
  | 'done';

/** One detected motion event: the local peak and its paired other signal. */
interface PeakPending {
  /** Frame time of the local peak. */
  tPeak: number;
  /** The keyed signal's local peak (speed for punches, growth for pushes). */
  keyPeak: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export class CalibrationScreen implements Screen {
  private readonly leftGate = new ConfidenceGate();
  private readonly rightGate = new ConfidenceGate();
  private phase: Phase = 'waiting';
  private captureStartT = 0;
  private captured: LandmarkFrame[] = [];
  private stats: CalibrationStats | null = null;

  private detachFrames: (() => void) | null = null;
  private ctx: CalibrationContext | null = null;
  private ownVideo: HTMLVideoElement | null = null;
  private leftHandEl: HTMLElement | null = null;
  private rightHandEl: HTMLElement | null = null;
  private textEl: HTMLElement | null = null;
  private help: HelpPanel | null = null;
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;

  // Meter DOM (built when motionSteps is set; shown during the steps).
  private meterEl: HTMLElement | null = null;
  private speedFillEl: HTMLElement | null = null;
  private speedPeakEl: HTMLElement | null = null;
  private growthFillEl: HTMLElement | null = null;
  private growthPeakEl: HTMLElement | null = null;
  private elbowFillEl: HTMLElement | null = null;
  private elbowPeakEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;

  // Motion step state (frame-driven).
  private stepStartT = 0;
  private lastDetectionT = 0;
  private noticeUntilT = 0;
  private readonly leftWindow: HandFrame[] = [];
  private readonly rightWindow: HandFrame[] = [];
  private prevFrameT: number | null = null;
  private neutralSpeedSamples: number[] = [];
  private neutralGrowthSamples: number[] = [];
  private neutralElbowSamples: number[] = [];
  private neutralSpeed = 0;
  private neutralGrowth = 0;
  private neutralElbowVel = 0;
  private baselineDone = false;
  /** Recent (t, speed, growth, elbow, per-arm reach) samples for the
   *  +-250 ms peak pairing. reachL/reachR are shoulder-width units, 0 while
   *  no pose is available (a zero can never become a reach seed). */
  private recent: Array<{
    t: number;
    speed: number;
    growth: number;
    elbow: number;
    reachL: number;
    reachR: number;
  }> = [];
  private tracking = false; // inside a candidate event (above threshold)
  private localPeak = 0;
  private localPeakT = 0;
  private pending: PeakPending[] = [];
  private keyPeaks: number[] = [];
  private pairPeaks: number[] = [];
  private elbowPeaks: number[] = [];
  /** Per finalized event: each arm's reach max inside the pairing window. */
  private reachPeaksL: number[] = [];
  private reachPeaksR: number[] = [];
  private punchSpeeds: number[] = [];
  private punchGrowths: number[] = [];
  private punchElbows: number[] = [];
  /** Per-arm reach maxima of the finalized PUNCH events (carried past the
   *  push step's state reset, like punchSpeeds and friends). */
  private punchReachL: number[] = [];
  private punchReachR: number[] = [];
  private stepPeakSpeed = 0;
  private stepPeakGrowth = 0;
  private stepPeakElbow = 0;
  // Elbow-extension tracking from body pose (works without pose: all zeros).
  private lastPoseSampleT: number | null = null;
  private prevElbowAngleL = 0;
  private prevElbowAngleR = 0;
  private elbowVelL = 0;
  private elbowVelR = 0;
  private sawPose = false;
  /** Set by the R key: ignore any stored profile this run. */
  private recalibrateRequested = false;

  // Framing gate step (R3 Phase 3, live path only).
  private pip: WebcamPip | null = null;
  private framingGate: FramingGate | null = null;
  private framingStartT = 0;
  private framingPrevT: number | null = null;
  private framingSawPose = false;
  private framingText = '';

  private resolveStats: ((stats: CalibrationStats) => void) | null = null;
  private completion: Promise<CalibrationStats>;

  constructor() {
    this.completion = new Promise((resolve) => {
      this.resolveStats = resolve;
    });
  }

  /** Resolves with the captured stats once the ritual completes. */
  get calibrated(): Promise<CalibrationStats> {
    return this.completion;
  }

  enter(root: HTMLElement, ctx?: unknown): void {
    const c = ctx as CalibrationContext | undefined;
    if (!c || !c.source) {
      throw new Error('CalibrationScreen requires a ctx with a LandmarkSource');
    }
    this.ctx = c;

    // Reset for re-entry (a fresh promise if the last run already finished).
    this.leftGate.reset();
    this.rightGate.reset();
    this.captured = [];
    this.stats = null;
    if (this.phase === 'done') {
      this.completion = new Promise((resolve) => {
        this.resolveStats = resolve;
      });
    }
    this.phase = 'waiting';
    this.resetMotionState();
    this.punchSpeeds = [];
    this.punchGrowths = [];
    this.punchElbows = [];
    this.punchReachL = [];
    this.punchReachR = [];
    this.sawPose = false;
    this.recalibrateRequested = false;
    this.framingGate = null;
    this.framingSawPose = false;
    this.framingPrevT = null;
    this.framingText = '';

    root.classList.add('fb-cal');

    // Dimmed mirrored camera feed when available; replay mode shows only the
    // dark lacquer backdrop and the ritual still works.
    const video = c.video ?? (c.stream ? this.makeVideo(c.stream) : null);
    if (video) {
      video.classList.add('fb-cal-video');
      root.appendChild(video);
      void video.play?.().catch(() => undefined);
    }

    const shade = document.createElement('div');
    shade.className = 'fb-cal-shade';
    root.appendChild(shade);

    this.leftHandEl = handOutline('left');
    this.rightHandEl = handOutline('right');
    this.placeHand(this.leftHandEl, REST_LEFT.x, REST_LEFT.y);
    this.placeHand(this.rightHandEl, REST_RIGHT.x, REST_RIGHT.y);
    root.appendChild(this.leftHandEl);
    root.appendChild(this.rightHandEl);

    this.textEl = document.createElement('div');
    this.textEl.className = 'fb-cal-text';
    this.textEl.textContent = 'Raise your hands.';
    root.appendChild(this.textEl);

    // Lighting help, calibration only (T070).
    this.help = new HelpPanel(root);

    if (c.motionSteps) {
      // Webcam PIP mirror during the ritual (R3 Phase 3): hosts the framing
      // silhouette guide; frame-driven render (no rAF loop on this screen).
      this.pip = new WebcamPip(root, c.stream);
      this.buildMeter(root);
      // R during any phase: forget the stored profile and run the steps.
      this.onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'r' || e.key === 'R') this.requestRecalibrate();
      };
      window.addEventListener('keydown', this.onKeyDown);
    }

    this.detachFrames = c.source.onFrame((frame) => this.handleFrame(frame));
  }

  exit(): void {
    this.detachFrames?.();
    this.detachFrames = null;
    this.help?.dispose();
    this.help = null;
    if (this.onKeyDown) {
      window.removeEventListener('keydown', this.onKeyDown);
      this.onKeyDown = null;
    }
    if (this.ownVideo) {
      this.ownVideo.srcObject = null;
      this.ownVideo = null;
    }
    this.pip?.dispose();
    this.pip = null;
    this.framingGate = null;
    this.ctx = null;
    this.leftHandEl = null;
    this.rightHandEl = null;
    this.textEl = null;
    this.meterEl = null;
    this.speedFillEl = null;
    this.speedPeakEl = null;
    this.growthFillEl = null;
    this.growthPeakEl = null;
    this.elbowFillEl = null;
    this.elbowPeakEl = null;
    this.countEl = null;
  }

  private makeVideo(stream: MediaStream): HTMLVideoElement {
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.srcObject = stream;
    this.ownVideo = video;
    return video;
  }

  // -------------------------------------------------------------------------
  // Frame routing
  // -------------------------------------------------------------------------

  private handleFrame(frame: LandmarkFrame): void {
    // PIP mirror keeps drawing through every phase (frame-driven; there is
    // no rAF loop on this screen).
    if (this.pip) {
      this.pip.setFrame(frame);
      this.pip.render();
    }
    switch (this.phase) {
      case 'done':
        return;
      case 'waiting': {
        const leftTracked = this.leftGate.update(
          frame.left ? frame.left.confidence : null,
        );
        const rightTracked = this.rightGate.update(
          frame.right ? frame.right.confidence : null,
        );
        if (leftTracked && rightTracked) this.ignite(frame);
        return;
      }
      case 'capturing': {
        // Frames missing a hand still get recorded;
        // captureCalibration filters them per hand.
        this.captured.push(frame);
        this.followWrists(frame);
        if (frame.t - this.captureStartT >= CAPTURE_WINDOW_MS) {
          this.finishCapture(frame.t);
        }
        return;
      }
      case 'framing':
        this.followWrists(frame);
        this.updateFramingStep(frame);
        return;
      case 'profile-note': {
        this.followWrists(frame);
        if (frame.t >= this.noticeUntilT) {
          const stored = loadProfile();
          this.complete(stored ?? DEFAULT_PROFILE);
        }
        return;
      }
      case 'punches':
      case 'pushes':
        this.followWrists(frame);
        this.updateMotionStep(frame);
        return;
      case 'fallback-note': {
        this.followWrists(frame);
        if (frame.t >= this.noticeUntilT) this.complete(DEFAULT_PROFILE);
        return;
      }
    }
  }

  private ignite(frame: LandmarkFrame): void {
    this.ctx?.onIgnite?.();
    this.phase = 'capturing';
    this.captureStartT = frame.t;
    this.captured = [frame];
    this.followWrists(frame);
    this.leftHandEl?.classList.add('ignited');
    this.rightHandEl?.classList.add('ignited');
    this.setText('Bender recognized.');
  }

  /** Stats capture done: complete now, or continue into the framing gate
   *  and motion steps (live path). */
  private finishCapture(t: number): void {
    this.stats = captureCalibration(this.captured);
    this.captured = [];

    if (!this.ctx?.motionSteps) {
      // Replay/test paths: classic behavior, no framing gate, done now.
      this.complete(null);
      return;
    }
    this.startFramingStep(t);
  }

  // -------------------------------------------------------------------------
  // Framing gate step (R3 Phase 3, live path only)
  // -------------------------------------------------------------------------

  private startFramingStep(t: number): void {
    this.phase = 'framing';
    this.framingGate = new FramingGate();
    this.framingStartT = t;
    this.framingPrevT = null;
    this.framingSawPose = false;
    this.framingText = '';
    this.setText('Frame your whole body.');
  }

  /**
   * One frame of the framing gate: the requirements must hold continuously
   * for FRAMING_HOLD_SEC (framingGate.ts) before the ritual continues. The
   * prompt line always shows the gate's TOP corrective text. A device whose
   * pose tracker never produces a sample (FRAMING_POSE_WAIT_MS) skips the
   * gate so poseless play is never trapped.
   */
  private updateFramingStep(frame: LandmarkFrame): void {
    const t = frame.t;
    const dtSec =
      this.framingPrevT !== null && t > this.framingPrevT
        ? (t - this.framingPrevT) / 1000
        : 0;
    this.framingPrevT = t;
    if (frame.pose) this.framingSawPose = true;

    if (!this.framingSawPose) {
      if (t - this.framingStartT >= FRAMING_POSE_WAIT_MS) this.passFraming(t);
      return;
    }

    const gate = this.framingGate;
    if (!gate) return;
    const state = gate.update(frame, dtSec);
    this.pip?.setFramingState(state);
    const text = state.top !== null ? state.top.text : 'Hold your stance.';
    if (text !== this.framingText) {
      this.framingText = text;
      this.setText(text);
    }
    if (state.passed) this.passFraming(t);
  }

  /** Framing gate passed (or skipped): continue into the motion steps. */
  private passFraming(t: number): void {
    this.pip?.setFramingState(null);
    this.framingGate = null;
    const stored = this.recalibrateRequested ? null : loadProfile();
    if (stored) {
      // Fast reload path: keep the stored profile, offer R to redo.
      this.phase = 'profile-note';
      this.noticeUntilT = t + NOTICE_MS;
      this.setText('Profile loaded. Press R to recalibrate.');
      return;
    }
    this.startPunchStep(t);
  }

  private complete(profile: MotionProfile | null): void {
    this.phase = 'done';
    const stats = this.stats ?? captureCalibration([]);
    this.meterEl?.classList.remove('is-on');
    this.resolveStats?.(stats);
    this.ctx?.onComplete?.(stats, profile);
  }

  // -------------------------------------------------------------------------
  // Motion steps
  // -------------------------------------------------------------------------

  private resetMotionState(): void {
    this.leftWindow.length = 0;
    this.rightWindow.length = 0;
    this.prevFrameT = null;
    this.neutralSpeedSamples = [];
    this.neutralGrowthSamples = [];
    this.neutralElbowSamples = [];
    this.baselineDone = false;
    this.recent = [];
    this.tracking = false;
    this.localPeak = 0;
    this.localPeakT = 0;
    this.pending = [];
    this.keyPeaks = [];
    this.pairPeaks = [];
    this.elbowPeaks = [];
    this.reachPeaksL = [];
    this.reachPeaksR = [];
    this.stepPeakSpeed = 0;
    this.stepPeakGrowth = 0;
    this.stepPeakElbow = 0;
    this.lastPoseSampleT = null;
    this.elbowVelL = 0;
    this.elbowVelR = 0;
  }

  private requestRecalibrate(): void {
    this.recalibrateRequested = true;
    clearProfile();
    if (this.phase === 'profile-note') {
      // Jump straight into the steps; the stats are already captured.
      this.startPunchStep(this.noticeUntilT - NOTICE_MS);
    }
  }

  private startPunchStep(t: number): void {
    this.resetMotionState();
    this.phase = 'punches';
    this.stepStartT = t;
    this.lastDetectionT = t;
    this.neutralSpeed = 0;
    this.neutralGrowth = 0;
    this.neutralElbowVel = 0;
    this.setText('Throw three punches.');
    this.meterEl?.classList.add('is-on');
    this.setCount(0, PUNCHES_REQUIRED);
  }

  private startPushStep(t: number): void {
    const nSpeed = this.neutralSpeed;
    const nGrowth = this.neutralGrowth;
    const nElbow = this.neutralElbowVel;
    this.resetMotionState();
    this.phase = 'pushes';
    this.neutralSpeed = nSpeed; // baselines carry over from the punch step
    this.neutralGrowth = nGrowth;
    this.neutralElbowVel = nElbow;
    this.baselineDone = true;
    this.stepStartT = t;
    this.lastDetectionT = t;
    this.setText('Push your palms forward.');
    this.setCount(0, PUSHES_REQUIRED);
  }

  /**
   * Advance the elbow-extension signal from body pose. Differencing runs on
   * RAW pose SAMPLE timestamps only: held frames (same t) and worker-path
   * INTERPOLATED frames (pose.interpolated) are skipped, mirroring the move
   * engine's elbow tracker; between samples the last velocity holds. Without
   * pose everything stays 0 and the profile's elbow fields fall back to
   * defaults in finishSteps.
   */
  private updateElbowSignal(frame: LandmarkFrame): void {
    const pose = frame.pose ?? null;
    if (!pose || pose.interpolated === true || pose.t === this.lastPoseSampleT) return;
    this.sawPose = true;
    const src = pose.world ?? pose;
    const angleL = elbowAngle(src.left.shoulder, src.left.elbow, src.left.wrist);
    const angleR = elbowAngle(src.right.shoulder, src.right.elbow, src.right.wrist);
    if (this.lastPoseSampleT !== null && pose.t - this.lastPoseSampleT <= ELBOW_GAP_MS) {
      const dtSec = (pose.t - this.lastPoseSampleT) / 1000;
      this.elbowVelL = elbowAngularVelocity(this.prevElbowAngleL, angleL, dtSec);
      this.elbowVelR = elbowAngularVelocity(this.prevElbowAngleR, angleR, dtSec);
    } else {
      this.elbowVelL = 0; // first sample or a gap: re-baseline
      this.elbowVelR = 0;
    }
    this.prevElbowAngleL = angleL;
    this.prevElbowAngleR = angleR;
    this.lastPoseSampleT = pose.t;
  }

  /** One frame of a motion step: signals, meter, detection, timeouts. */
  private updateMotionStep(frame: LandmarkFrame): void {
    const t = frame.t;
    const dtSec =
      this.prevFrameT !== null && t > this.prevFrameT
        ? (t - this.prevFrameT) / 1000
        : 1 / 30;
    this.prevFrameT = t;

    // Per-hand windows; the strongest present hand drives the signals.
    const left = this.pushWindow(this.leftWindow, frame.left, dtSec);
    const right = this.pushWindow(this.rightWindow, frame.right, dtSec);
    const speed = Math.max(left.speed, right.speed);
    const growth = Math.max(left.growth, right.growth);
    this.updateElbowSignal(frame);
    // Extension is positive; the stronger arm drives the punch signal.
    const elbow = Math.max(this.elbowVelL, this.elbowVelR, 0);

    // Per-arm screen reach (shoulder-width units) from the CURRENT pose,
    // positional so held/interpolated pose frames are fine. Zero without a
    // pose (or a degenerate shoulder line): zeros never seed a reach.
    const poseReach = frame.pose ? poseReachSw(frame.pose) : null;

    this.recent.push({
      t,
      speed,
      growth,
      elbow,
      reachL: poseReach?.left ?? 0,
      reachR: poseReach?.right ?? 0,
    });
    while (this.recent.length > 0) {
      const oldest = this.recent[0];
      if (oldest && t - oldest.t > 2 * PEAK_PAIR_WINDOW_MS + 200) {
        this.recent.shift();
      } else {
        break;
      }
    }

    const isPunches = this.phase === 'punches';

    // Neutral baseline: medians over the first ~800 ms of the punch step,
    // while the player is still (the prompt only just appeared).
    if (!this.baselineDone) {
      if (t - this.stepStartT <= NEUTRAL_SAMPLE_MS) {
        this.neutralSpeedSamples.push(speed);
        this.neutralGrowthSamples.push(Math.abs(growth));
        // Neutral elbow velocity: the still lead-in, both arms, absolute.
        this.neutralElbowSamples.push(
          Math.max(Math.abs(this.elbowVelL), Math.abs(this.elbowVelR)),
        );
        this.updateMeter(speed, growth, elbow);
        return; // detection starts after the baseline window
      }
      this.neutralSpeed = median(this.neutralSpeedSamples);
      this.neutralGrowth = median(this.neutralGrowthSamples);
      this.neutralElbowVel = median(this.neutralElbowSamples);
      this.neutralSpeedSamples = [];
      this.neutralGrowthSamples = [];
      this.neutralElbowSamples = [];
      this.baselineDone = true;
    }

    // The keyed signal: speed for punches, bbox growth for pushes.
    const key = isPunches ? speed : growth;
    const threshold = isPunches
      ? Math.max(PUNCH_SPEED_FLOOR, DETECT_NEUTRAL_MULT * this.neutralSpeed)
      : Math.max(PUSH_GROWTH_FLOOR, DETECT_NEUTRAL_MULT * this.neutralGrowth);
    const required = isPunches ? PUNCHES_REQUIRED : PUSHES_REQUIRED;

    if (!this.tracking) {
      if (key >= threshold) {
        this.tracking = true;
        this.localPeak = key;
        this.localPeakT = t;
      }
    } else if (key > this.localPeak) {
      this.localPeak = key;
      this.localPeakT = t;
    } else if (key < this.localPeak / 2) {
      // The swing completed: register one event at its local peak.
      this.tracking = false;
      this.lastDetectionT = t;
      this.pending.push({ tPeak: this.localPeakT, keyPeak: this.localPeak });
      this.setCount(
        Math.min(this.keyPeaks.length + this.pending.length, required),
        required,
      );
    }

    // Finalize pending events once their +-250 ms pairing window closed:
    // pair the keyed peak with the other signals' max inside that window
    // (punches also capture the elbow-extension peak and each arm's REACH
    // peak per punch; the window keeps a hanging arm between punches from
    // ever contributing a reach sample).
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (!p || t - p.tPeak < PEAK_PAIR_WINDOW_MS) continue;
      let pairMax = 0;
      let elbowMax = 0;
      let reachLMax = 0;
      let reachRMax = 0;
      for (const sample of this.recent) {
        if (Math.abs(sample.t - p.tPeak) <= PEAK_PAIR_WINDOW_MS) {
          pairMax = Math.max(pairMax, isPunches ? sample.growth : sample.speed);
          elbowMax = Math.max(elbowMax, sample.elbow);
          reachLMax = Math.max(reachLMax, sample.reachL);
          reachRMax = Math.max(reachRMax, sample.reachR);
        }
      }
      this.keyPeaks.push(p.keyPeak);
      this.pairPeaks.push(pairMax);
      this.elbowPeaks.push(elbowMax);
      this.reachPeaksL.push(reachLMax);
      this.reachPeaksR.push(reachRMax);
      this.pending.splice(i, 1);
    }

    this.updateMeter(speed, growth, elbow);

    // Step advancement (after all events finalized, not just registered).
    if (this.keyPeaks.length >= required) {
      if (isPunches) {
        this.punchSpeeds = this.keyPeaks;
        this.punchGrowths = this.pairPeaks;
        this.punchElbows = this.elbowPeaks;
        this.punchReachL = this.reachPeaksL;
        this.punchReachR = this.reachPeaksR;
        this.startPushStep(t);
      } else {
        this.finishSteps();
      }
      return;
    }

    // Timeout guard: never trap the player.
    if (t - this.lastDetectionT >= STEP_TIMEOUT_MS) {
      this.phase = 'fallback-note';
      this.noticeUntilT = t + NOTICE_MS;
      this.meterEl?.classList.remove('is-on');
      this.setText('Using default calibration.');
    }
  }

  /** Build the v2 profile from both steps, persist it, and complete. */
  private finishSteps(): void {
    // Elbow fields need body pose; a poseless capture (older devices, pose
    // model failed to load) falls back to the defaults so the profile stays
    // usable and the engine's no-pose fallback rule carries the play.
    const elbowPeak = median(this.punchElbows);
    const haveElbow = this.sawPose && elbowPeak > 0;
    // Phase-engine reach seeds (ADDITIVE, optional): the largest per-punch
    // reach each arm showed across the three punches, clamped into the
    // plausible forward band. A poseless capture yields all zeros and
    // reachSeedSw returns null, so the fields are simply omitted and older
    // consumers plus the engine's prior stay untouched.
    const seedL = reachSeedSw(
      this.punchReachL.length > 0 ? Math.max(...this.punchReachL) : 0,
    );
    const seedR = reachSeedSw(
      this.punchReachR.length > 0 ? Math.max(...this.punchReachR) : 0,
    );
    const profile: MotionProfile = {
      version: 2,
      peakPunchSpeed: median(this.punchSpeeds),
      peakPunchBboxGrowth: median(this.punchGrowths),
      peakPalmBboxGrowth: median(this.keyPeaks),
      peakPalmSpeed: median(this.pairPeaks),
      peakElbowVel: haveElbow ? elbowPeak : DEFAULT_PROFILE.peakElbowVel,
      neutralElbowVel: haveElbow
        ? this.neutralElbowVel
        : DEFAULT_PROFILE.neutralElbowVel,
      neutralSpeed: this.neutralSpeed,
      neutralBboxGrowth: this.neutralGrowth,
      capturedAt: new Date().toISOString(),
      ...(seedL !== null ? { maxReachLeftSw: seedL } : {}),
      ...(seedR !== null ? { maxReachRightSw: seedR } : {}),
    };
    saveProfile(profile);
    this.complete(profile);
  }

  /** Advance one hand's frame window; returns its windowed speed + growth. */
  private pushWindow(
    window: HandFrame[],
    hand: HandFrame | null,
    dtSec: number,
  ): { speed: number; growth: number } {
    if (!hand || hand.landmarks.length < 21) {
      window.length = 0; // dropout: never smear across an absence
      return { speed: 0, growth: 0 };
    }
    window.push(hand);
    if (window.length > MOTION_WINDOW_FRAMES) window.shift();
    return {
      speed: handSpeed(window, dtSec).speed,
      // Bbox growth, matching the move engine's fusion secondary (palm span
      // collapses under a clenched fist; see gestures/motion.ts).
      growth: bboxGrowthRate(window, dtSec),
    };
  }

  // -------------------------------------------------------------------------
  // Meter DOM (ink-brush bars; styling in ui/theme.css)
  // -------------------------------------------------------------------------

  private buildMeter(root: HTMLElement): void {
    const meter = document.createElement('div');
    meter.className = 'fb-cal-meter';

    const row = (label: string): { fill: HTMLElement; peak: HTMLElement } => {
      const rowEl = document.createElement('div');
      rowEl.className = 'fb-cal-meter-row';
      const labelEl = document.createElement('span');
      labelEl.className = 'fb-cal-meter-label';
      labelEl.textContent = label;
      const track = document.createElement('div');
      track.className = 'fb-cal-meter-track';
      const fill = document.createElement('div');
      fill.className = 'fb-cal-meter-fill';
      const peak = document.createElement('div');
      peak.className = 'fb-cal-meter-peak';
      track.append(fill, peak);
      rowEl.append(labelEl, track);
      meter.appendChild(rowEl);
      return { fill, peak };
    };

    const speedRow = row('SPEED');
    const growthRow = row('GROWTH');
    const elbowRow = row('ELBOW');
    this.speedFillEl = speedRow.fill;
    this.speedPeakEl = speedRow.peak;
    this.growthFillEl = growthRow.fill;
    this.growthPeakEl = growthRow.peak;
    this.elbowFillEl = elbowRow.fill;
    this.elbowPeakEl = elbowRow.peak;

    const count = document.createElement('div');
    count.className = 'fb-cal-meter-count';
    meter.appendChild(count);
    this.countEl = count;

    root.appendChild(meter);
    this.meterEl = meter;
  }

  /**
   * Live fusion meter: all three signals with peak markers; the strongest
   * (largest normalized fill) is what the player sees surge on a punch.
   */
  private updateMeter(speed: number, growth: number, elbow: number): void {
    this.stepPeakSpeed = Math.max(this.stepPeakSpeed, speed);
    this.stepPeakGrowth = Math.max(this.stepPeakGrowth, growth);
    this.stepPeakElbow = Math.max(this.stepPeakElbow, elbow);
    const pct = (value: number, full: number): string =>
      `${(Math.min(Math.max(value, 0) / full, 1) * 100).toFixed(1)}%`;
    if (this.speedFillEl) {
      this.speedFillEl.style.width = pct(speed, METER_SPEED_FULL);
    }
    if (this.speedPeakEl) {
      this.speedPeakEl.style.left = pct(this.stepPeakSpeed, METER_SPEED_FULL);
    }
    if (this.growthFillEl) {
      this.growthFillEl.style.width = pct(growth, METER_GROWTH_FULL);
    }
    if (this.growthPeakEl) {
      this.growthPeakEl.style.left = pct(this.stepPeakGrowth, METER_GROWTH_FULL);
    }
    if (this.elbowFillEl) {
      this.elbowFillEl.style.width = pct(elbow, METER_ELBOW_FULL);
    }
    if (this.elbowPeakEl) {
      this.elbowPeakEl.style.left = pct(this.stepPeakElbow, METER_ELBOW_FULL);
    }
  }

  /** Counter text: the event the player is currently on, "1 of 3" style. */
  private setCount(done: number, required: number): void {
    if (!this.countEl) return;
    const current = Math.min(done + 1, required);
    this.countEl.textContent =
      done >= required ? `${required} of ${required}` : `${current} of ${required}`;
  }

  private setText(text: string): void {
    if (!this.textEl) return;
    this.textEl.textContent = text;
    // Restart the entry animation for the swapped line.
    this.textEl.style.animation = 'none';
    void this.textEl.offsetWidth;
    this.textEl.style.animation = '';
  }

  /** Snap the outlines to the tracked wrists. Coordinates are normalized. */
  private followWrists(frame: LandmarkFrame): void {
    const lw = frame.left?.landmarks[LM.WRIST];
    if (lw && this.leftHandEl) this.placeHand(this.leftHandEl, lw.x, lw.y);
    const rw = frame.right?.landmarks[LM.WRIST];
    if (rw && this.rightHandEl) this.placeHand(this.rightHandEl, rw.x, rw.y);
  }

  private placeHand(el: HTMLElement, nx: number, ny: number): void {
    el.style.left = `${(nx * 100).toFixed(2)}%`;
    el.style.top = `${(ny * 100).toFixed(2)}%`;
  }
}
