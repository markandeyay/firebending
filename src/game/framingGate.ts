/**
 * Framing gate (Round 3 Phase 3): a hard, pose-driven check that the player
 * is framed well enough to play - whole torso in view, head top visible,
 * both hands tracked, standing. PURE state machines and evaluators only; the
 * DOM guide lives in src/ui/pip.ts and the wiring in the calibration and
 * arena screens. The recording studio (next phase) runs evaluateFraming /
 * FramingGate unchanged on recorded frames.
 *
 * REQUIREMENTS (each must hold CONTINUOUSLY for FRAMING_HOLD_SEC; any dip
 * resets the timer):
 * - body pose present with confidence >= FRAMING_CONFIDENCE_FLOOR
 * - estimated head top (eyes extrapolated upward by an ear-distance margin)
 *   below the frame top edge: headTopY > HEAD_TOP_MIN_Y
 * - both shoulders and both hips inside the frame
 * - shoulder width inside [SHOULDER_WIDTH_MIN, SHOULDER_WIDTH_MAX]
 * - both hands tracked (HandFrame non-null, confidence >= floor)
 * - standingScore >= STANDING_SCORE_MIN
 *
 * FAILURE DISCRIMINATION (priority order; the TOP failure is what the player
 * sees, each with its exact corrective text - never generic):
 *   step-back    shoulder width > 0.55, or head top AND hips both clipped,
 *                or hips clipped with almost no head room (subject too large)
 *   step-closer  shoulder width < 0.18 (subject too small)
 *   raise-camera head top clipped (or head landmarks missing) while the hips
 *                are still in frame low in the image (room below, none above)
 *   lower-camera hips clipped at the frame bottom while the head has clear
 *                room above (headTopY >= HEAD_ROOM_Y)
 *   stand-up     standingScore < 0.6
 *   show-hands   a hand missing while the body framing is fine
 *   more-light   pose absent or overall confidence < 0.5 (evaluated first
 *                and returned alone: nothing else is judgeable)
 */

import type { HandFrame, PoseFrame } from '../tracking/types';
import { shoulderLine, standingScore } from '../tracking/body';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Every requirement must hold this long, continuously, to pass the gate. */
export const FRAMING_HOLD_SEC = 2.0;
/** Pose / hand confidence floor for every requirement. */
export const FRAMING_CONFIDENCE_FLOOR = 0.5;
/** The estimated head top must sit below the frame top edge by this much. */
export const HEAD_TOP_MIN_Y = 0.03;
/** Shoulder width above this reads as "subject too large": step back. */
export const SHOULDER_WIDTH_MAX = 0.55;
/** Shoulder width below this reads as "subject too small": step closer. */
export const SHOULDER_WIDTH_MIN = 0.18;
/** standingScore at or above this counts as standing. */
export const STANDING_SCORE_MIN = 0.6;
/** A joint within this margin of the frame edge counts as clipped. */
export const FRAME_EDGE_MARGIN = 0.02;
/** "Head has room": estimated top at or below this y allows lower-camera. */
export const HEAD_ROOM_Y = 0.12;
/** Head-top extrapolation: eyes minus this fraction of the ear distance. */
export const HEAD_TOP_EAR_RATIO = 0.9;
/** Extrapolation floor when the ears read degenerate (profile/glitch). */
export const HEAD_TOP_MIN_MARGIN = 0.06;
/** Mid-game: framing must fail continuously this long to pause the arena. */
export const FRAMING_LOSS_SEC = 2.0;

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type FramingFailureId =
  | 'step-back'
  | 'step-closer'
  | 'raise-camera'
  | 'lower-camera'
  | 'stand-up'
  | 'show-hands'
  | 'more-light';

/** Exact user-facing corrective line per failure. NEVER generic text. */
export const FRAMING_TEXT: Readonly<Record<FramingFailureId, string>> = {
  'step-back': 'Step back',
  'step-closer': 'Step closer',
  'raise-camera': 'Raise your camera',
  'lower-camera': 'Lower your camera',
  'stand-up': 'Stand up',
  'show-hands': 'Show both hands',
  'more-light': 'More light on your hands',
};

export interface FramingFailure {
  id: FramingFailureId;
  text: string;
}

/** Per-region satisfaction, driving the PIP silhouette tinting. */
export interface FramingRegions {
  head: boolean;
  shoulders: boolean;
  hips: boolean;
  hands: boolean;
  standing: boolean;
}

/** Structural subset of LandmarkFrame the evaluator needs. */
export interface FramingFrame {
  left: HandFrame | null;
  right: HandFrame | null;
  pose?: PoseFrame | null;
}

export interface FramingEval {
  /** All requirements hold on this frame. */
  ok: boolean;
  /** Applicable failures, priority order (worst first). Empty when ok. */
  failures: FramingFailure[];
  regions: FramingRegions;
  /** Estimated head-top y (null when head landmarks are missing). */
  headTopY: number | null;
  shoulderWidth: number;
  standing: number;
}

const fail = (id: FramingFailureId): FramingFailure => ({ id, text: FRAMING_TEXT[id] });

const NO_REGIONS: FramingRegions = {
  head: false,
  shoulders: false,
  hips: false,
  hands: false,
  standing: false,
};

/**
 * Estimated head-top y from the pose head landmarks: the higher eye,
 * extrapolated upward (y grows down) by HEAD_TOP_EAR_RATIO of the ear-to-ear
 * distance (the eyes sit at mid-face; the crown is roughly one ear-width
 * above them), floored at HEAD_TOP_MIN_MARGIN when the ears collapse
 * (profile view). Null without head landmarks. Pure; exported for tests and
 * the studio.
 */
export function estimateHeadTopY(pose: PoseFrame): number | null {
  const head = pose.head;
  if (!head) return null;
  const earDist = Math.hypot(
    head.leftEar.x - head.rightEar.x,
    head.leftEar.y - head.rightEar.y,
  );
  const margin = Math.max(HEAD_TOP_EAR_RATIO * earDist, HEAD_TOP_MIN_MARGIN);
  const eyeTopY = Math.min(head.leftEye.y, head.rightEye.y, head.nose.y);
  return eyeTopY - margin;
}

function inFrame(p: { x: number; y: number }): boolean {
  return (
    p.x > FRAME_EDGE_MARGIN &&
    p.x < 1 - FRAME_EDGE_MARGIN &&
    p.y > FRAME_EDGE_MARGIN &&
    p.y < 1 - FRAME_EDGE_MARGIN
  );
}

/**
 * Evaluate all framing requirements on one frame. Pure; the single source of
 * truth for the calibration gate, the mid-game watch and the studio.
 */
export function evaluateFraming(frame: FramingFrame): FramingEval {
  const pose = frame.pose ?? null;
  if (!pose || pose.confidence < FRAMING_CONFIDENCE_FLOOR) {
    return {
      ok: false,
      failures: [fail('more-light')],
      regions: { ...NO_REGIONS },
      headTopY: null,
      shoulderWidth: 0,
      standing: 0,
    };
  }

  const shoulders = shoulderLine(pose);
  const width = shoulders.width;
  const headTopY = estimateHeadTopY(pose);
  const standing = standingScore(pose);

  const headClipped = headTopY === null || headTopY <= HEAD_TOP_MIN_Y;
  const shouldersOut =
    !inFrame(pose.left.shoulder) || !inFrame(pose.right.shoulder);
  const hipsOut = !inFrame(pose.left.hip) || !inFrame(pose.right.hip);
  const headRoom = headTopY !== null && headTopY >= HEAD_ROOM_Y;
  const handsOk =
    frame.left !== null &&
    frame.left.confidence >= FRAMING_CONFIDENCE_FLOOR &&
    frame.right !== null &&
    frame.right.confidence >= FRAMING_CONFIDENCE_FLOOR;
  const standingOk = standing >= STANDING_SCORE_MIN;

  // Discriminator (see module header for the id -> geometry table).
  const tooLarge =
    width > SHOULDER_WIDTH_MAX ||
    (headClipped && hipsOut) ||
    (hipsOut && !headRoom) ||
    shouldersOut;
  const failures: FramingFailure[] = [];
  if (tooLarge) failures.push(fail('step-back'));
  if (!tooLarge && width < SHOULDER_WIDTH_MIN) failures.push(fail('step-closer'));
  if (!tooLarge && headClipped && !hipsOut) failures.push(fail('raise-camera'));
  if (!tooLarge && hipsOut && headRoom) failures.push(fail('lower-camera'));
  if (!standingOk) failures.push(fail('stand-up'));
  if (!handsOk) failures.push(fail('show-hands'));

  const regions: FramingRegions = {
    head: !headClipped,
    shoulders: !shouldersOut && width >= SHOULDER_WIDTH_MIN && width <= SHOULDER_WIDTH_MAX,
    hips: !hipsOut,
    hands: handsOk,
    standing: standingOk,
  };

  return {
    ok: failures.length === 0,
    failures,
    regions,
    headTopY,
    shoulderWidth: width,
    standing,
  };
}

// ---------------------------------------------------------------------------
// Gate (continuous hold)
// ---------------------------------------------------------------------------

export interface FramingGateState {
  /** All requirements have held for FRAMING_HOLD_SEC continuously. */
  passed: boolean;
  /** Seconds of continuous hold still required (FRAMING_HOLD_SEC on a dip). */
  remainingSec: number;
  /** Current failures, priority order (empty while requirements hold). */
  failures: FramingFailure[];
  /** The single failure the player should fix first (null when none). */
  top: FramingFailure | null;
  regions: FramingRegions;
}

/**
 * The gate proper: requirements must hold continuously for FRAMING_HOLD_SEC;
 * any dip resets the timer (and un-passes). Frame-driven via dtSec, so
 * replayed or synthetic frame streams evaluate deterministically.
 */
export class FramingGate {
  private heldSec = 0;

  reset(): void {
    this.heldSec = 0;
  }

  update(frame: FramingFrame, dtSec: number): FramingGateState {
    const ev = evaluateFraming(frame);
    if (ev.ok) this.heldSec += Math.max(0, dtSec);
    else this.heldSec = 0;
    const passed = ev.ok && this.heldSec >= FRAMING_HOLD_SEC;
    return {
      passed,
      remainingSec: ev.ok
        ? Math.max(0, FRAMING_HOLD_SEC - this.heldSec)
        : FRAMING_HOLD_SEC,
      failures: ev.failures,
      top: ev.failures[0] ?? null,
      regions: ev.regions,
    };
  }
}

// ---------------------------------------------------------------------------
// Mid-game watch (arena)
// ---------------------------------------------------------------------------

/**
 * Arena-side framing monitor: while play runs, POSE-CARRYING frames whose
 * framing fails accumulate a bad timer (pose-absent frames are the hand
 * tracking-loss FSM's business and reset it); past FRAMING_LOSS_SEC the
 * watch declares the framing lost, which the arena maps onto the existing
 * TrackingLoss pause flow. While lost, the full FramingGate must pass again
 * (2 s continuous hold) before the watch clears and the normal resume
 * countdown runs.
 */
export class FramingLossWatch {
  private badSec = 0;
  private readonly gate = new FramingGate();
  private lostFlag = false;
  private state: FramingGateState | null = null;

  get lost(): boolean {
    return this.lostFlag;
  }

  /** Latest gate state while lost (drives the PIP guide); null in play. */
  get gateState(): FramingGateState | null {
    return this.lostFlag ? this.state : null;
  }

  /** Advance one frame; returns the (possibly new) lost flag. */
  update(frame: FramingFrame, dtSec: number): boolean {
    if (!this.lostFlag) {
      const pose = frame.pose ?? null;
      if (pose) {
        const ev = evaluateFraming(frame);
        this.badSec = ev.ok ? 0 : this.badSec + Math.max(0, dtSec);
      } else {
        this.badSec = 0;
      }
      if (this.badSec > FRAMING_LOSS_SEC) {
        this.lostFlag = true;
        this.badSec = 0;
        this.gate.reset();
        this.state = this.gate.update(frame, 0);
      }
    } else {
      this.state = this.gate.update(frame, dtSec);
      if (this.state.passed) {
        this.lostFlag = false;
        this.badSec = 0;
        this.state = null;
      }
    }
    return this.lostFlag;
  }
}
