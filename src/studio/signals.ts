/**
 * Per-frame derived-signal sampling for the recording studio. A stateful
 * SignalTracker consumes LandmarkFrame objects (from the SAME
 * FilteredSource stream the game plays on) and emits StudioFrameSignals:
 * elbow angle + angular velocity per side, windowed wrist speed/velocity and
 * bbox growth per side, instantaneous fist/palm/grip scores, and the
 * pose-derived body lines + standing score.
 *
 * The windowing and elbow-sample differencing REPLICATE MoveEngine exactly
 * (AIM_WINDOW_FRAMES-frame windows on frame dt, elbow velocity differenced
 * only on real pose samples, ELBOW_RESET_GAP_MS re-baseline), so recorded
 * signals are the signals the game would have acted on. Pure of DOM;
 * unit-testable headless.
 */

import type { HandFrame, LandmarkFrame, PoseFrame } from '../tracking/types';
import { LM } from '../tracking/types';
import { fistScore, gripScore, handSpeed, palmScore2D } from '../gestures/poses';
import type { Handedness } from '../gestures/poses';
import { bboxGrowthRate } from '../gestures/motion';
import { AIM_WINDOW_FRAMES, CONFIDENCE_FLOOR, ELBOW_RESET_GAP_MS } from '../gestures/moves';
import { elbowAngle, elbowAngularVelocity } from '../tracking/poseSource';
import { hipLine, shoulderLine, standingScore } from '../tracking/body';
import type {
  StudioBodySignals,
  StudioFrameSignals,
  StudioSideSignals,
} from './exportSchema';

const DEFAULT_DT_SEC = 1 / 30;

const ZERO_SIDE: StudioSideSignals = {
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

const ZERO_BODY: StudioBodySignals = {
  present: false,
  shoulderCenterY: 0,
  shoulderWidth: 0,
  shoulderTiltRad: 0,
  hipCenterY: 0,
  hipWidth: 0,
  hipTiltRad: 0,
  standingScore: 0,
};

class SideState {
  window: HandFrame[] = [];
  elbowAngle = 0;
  elbowVel = 0;
  prevElbowAngle = 0;
  lastPoseSampleT: number | null = null;

  resetHand(): void {
    this.window.length = 0;
  }
}

export class SignalTracker {
  private readonly left = new SideState();
  private readonly right = new SideState();
  private prevT: number | null = null;

  reset(): void {
    this.left.resetHand();
    this.right.resetHand();
    this.left.lastPoseSampleT = null;
    this.right.lastPoseSampleT = null;
    this.left.elbowAngle = 0;
    this.right.elbowAngle = 0;
    this.left.elbowVel = 0;
    this.right.elbowVel = 0;
    this.prevT = null;
  }

  /** Consume one frame; returns the sampled signals for that frame. */
  update(frame: LandmarkFrame): StudioFrameSignals {
    const t = frame.t;
    const dtMs = this.prevT === null ? 0 : Math.max(0, t - this.prevT);
    this.prevT = t;
    const dtSec = dtMs > 0 ? dtMs / 1000 : DEFAULT_DT_SEC;

    const pose = frame.pose ?? null;
    if (pose !== null) {
      this.updateElbow(this.left, pose, 'left');
      this.updateElbow(this.right, pose, 'right');
    }

    return {
      left: this.updateSide(this.left, frame.left, 'left', dtSec),
      right: this.updateSide(this.right, frame.right, 'right', dtSec),
      body: bodySignalsOf(pose),
    };
  }

  /** Mirror of MoveEngine.updateElbow: difference real pose samples only. */
  private updateElbow(s: SideState, pose: PoseFrame, hand: Handedness): void {
    if (pose.interpolated === true) return;
    if (s.lastPoseSampleT === pose.t) return;
    const source = pose.world ?? pose;
    const arm = hand === 'left' ? source.left : source.right;
    const angle = elbowAngle(arm.shoulder, arm.elbow, arm.wrist);
    if (s.lastPoseSampleT !== null && pose.t - s.lastPoseSampleT <= ELBOW_RESET_GAP_MS) {
      const dtSec = (pose.t - s.lastPoseSampleT) / 1000;
      s.elbowVel = elbowAngularVelocity(s.prevElbowAngle, angle, dtSec);
    } else {
      s.elbowVel = 0;
    }
    s.elbowAngle = angle;
    s.prevElbowAngle = angle;
    s.lastPoseSampleT = pose.t;
  }

  private updateSide(
    s: SideState,
    raw: HandFrame | null,
    handedness: Handedness,
    dtSec: number,
  ): StudioSideSignals {
    const present =
      raw !== null && raw.confidence >= CONFIDENCE_FLOOR && raw.landmarks.length >= 21;
    if (!present || raw === null) {
      s.resetHand();
      return { ...ZERO_SIDE, elbowAngle: s.elbowAngle, elbowVel: s.elbowVel };
    }
    s.window.push(raw);
    if (s.window.length > AIM_WINDOW_FRAMES) s.window.shift();

    const sp = handSpeed(s.window, dtSec);
    return {
      elbowAngle: s.elbowAngle,
      elbowVel: s.elbowVel,
      wristSpeed: sp.speed,
      velX: sp.velocity.x,
      velY: sp.velocity.y,
      bboxGrowth: bboxGrowthRate(s.window, dtSec),
      fist: fistScore(raw),
      // The LIVE palm scorer (palmScore2D since Round 3 Phase 4f), so the
      // exported signal is the score the game acts on. tools/analyze.ts
      // additionally computes the legacy 3D palmScore from the raw
      // landmarks for the palm-static take comparison.
      palm: palmScore2D(raw, handedness),
      grip: gripScore(raw),
    };
  }
}

/** Pose-derived body block for one frame. Pure. */
export function bodySignalsOf(pose: PoseFrame | null): StudioBodySignals {
  if (pose === null) return { ...ZERO_BODY };
  const sh = shoulderLine(pose);
  const hp = hipLine(pose);
  return {
    present: true,
    shoulderCenterY: sh.center.y,
    shoulderWidth: sh.width,
    shoulderTiltRad: sh.tiltRad,
    hipCenterY: hp.center.y,
    hipWidth: hp.width,
    hipTiltRad: hp.tiltRad,
    standingScore: standingScore(pose),
  };
}

/**
 * Quick wrist presence probe used by the quality watch (a hand "vanished"
 * when it had been reliably present and its slot went null).
 */
export function handPresent(hand: HandFrame | null): boolean {
  return (
    hand !== null &&
    hand.confidence >= CONFIDENCE_FLOOR &&
    hand.landmarks.length > LM.WRIST
  );
}
