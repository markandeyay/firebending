/**
 * PhaseMoveEngine: the 7-move detector rebuilt as FRAMERATE-INDEPENDENT
 * POSITION STATE MACHINES (2026-07-31 rebuild). Drop-in for the MoveEngine
 * surface that src/screens/arena.ts consumes (update / breath / spend /
 * activeSustain / debugEnabled and the constructor config shape); event
 * consumers are untouched because MoveEvent/MoveName are imported from
 * moves.ts, which stays in-tree as the legacy velocity baseline.
 *
 * WHY THE REBUILD: the player's machine captures at ~14 fps and cannot do
 * better. Five rounds of velocity-threshold detection failed because
 * velocity is a derivative that degrades as fps drops. Positions survive
 * dropped frames; here time enters only as sanity windows measured on frame
 * timestamps (frame.t), so the same trajectory sampled at 10 or 30 fps
 * fires the same events.
 *
 * SIGNAL SOURCES (from the user's recorded drills, fixtures/recorded/
 * firebending-drill-2026-07-31.json): the hand tracker loses the hand
 * during every fast punch, but the pose tracker keeps tracking (pose
 * presence measured at 100 percent in every take). The PRIMARY positional
 * signal is therefore the POSE wrist inside the slowly-drifting body frame
 * (bodyFrame.ts); hand landmarks contribute only the finger-pose gates
 * (breath-charge fist, whip grip), and those gates are confidence-aware:
 * an absent hand HOLDS the last debounced state instead of passing or
 * failing (hands are trackable during the static holds that need them).
 *
 * THE 7 MOVES as compositions of the per-arm phase machine (extension.ts)
 * and body zones (zones.ts):
 *   jab-blast:    one arm completes a fast RETRACTED -> EXTENDED traversal,
 *                 zone-gated (see below), debounced per arm.
 *   fire-stream:  the arm dwells EXTENDED past EXTEND_HOLD_MS after a fast
 *                 thrust; sustained with Breath drain; ends when the arm
 *                 leaves EXTENDED (below the re-arm level).
 *   cross-combo:  three alternating-arm jab completions within
 *                 COMBO_WINDOW_MS.
 *   twin-cannon:  both wrists held together in the CHEST zone, then both
 *                 arms enter EXTENDED within PAIR_WINDOW_MS of each other.
 *                 The together chamber sits ABOVE the retracted threshold
 *                 (hands at the sternum are ~0.5 sw from each shoulder), so
 *                 twin pairs on the ENTERED-EXTENDED edge rather than the
 *                 full retracted traversal; the hold + grace window is the
 *                 chamber that keeps a slow drift from firing it.
 *   rising-flame: both wrists transit HIP zone -> ABOVE_SHOULDER, each
 *                 within MAX_SWEEP_MS and the pair within PAIR_WINDOW_MS.
 *                 Pure position sequence, no velocity anywhere.
 *   breath-charge: both wrists dwell in the HIP zone for BREATH_HOLD_MS
 *                 with the data-derived fist gate active and a POSITIONAL
 *                 stillness check (wrists stay within BREATH_STILL_RADIUS
 *                 of their dwell anchors; the legacy speed cap was a
 *                 velocity and had to go).
 *   fire-whip:    grip pose held (legacy hysteresis) with the wrist static
 *                 (stays within one zone) for WHIP_HOLD_MS, then the wrist
 *                 CROSSES from the inner lateral band to the outer band.
 *
 * HANGING-ARM ZONE GATE (drill-measured): dropping the arms from guard to
 * the sides sweeps extension ~0.15 -> ~2.0 within the thrust window, which
 * completes a machine traversal. The completion ZONE is what separates it
 * from a punch: a completion whose wrist sits in the HIP zone never fires,
 * and an ABOVE_SHOULDER completion belongs to rising-flame, not the jab
 * family. Zones feed the logic as EDGES (enter/exit), never per-frame
 * levels.
 *
 * AIM is deterministic from POSITION only: the 2D body-frame shoulder-to-
 * wrist direction of the firing arm (averaged for two-hand moves), with
 * forward depth from extension magnitude (z = -extension; more extended
 * aims more at the enemy), normalized. Body coords keep the screen y-down
 * convention (bodyFrame.ts) so the planar part maps straight into screen
 * aim; screen -z is toward the camera, so world-forward is negative z
 * exactly like the legacy AIM_FORWARD. No MediaPipe z anywhere, no
 * velocity anywhere: punching at the same position twice produces the
 * identical aim vector. MoveEvent.origin is the pose wrist (midpoint for
 * two-hand moves), screen space, as legacy.
 *
 * Breath economy, priority order (two-hand > grip > thrust), lockouts and
 * per-move cooldowns are the legacy values imported from moves.ts.
 */

import type { HandFrame, LandmarkFrame, PoseArm, PoseFrame, Vec3 } from '../tracking/types';
import { Hysteresis } from '../tracking/filters';
import type { Handedness } from './poses';
import {
  fistScore,
  gripScore,
  normalize,
  HANDS_TOGETHER_THRESHOLD,
} from './poses';
import {
  AIM_FORWARD,
  BREATH_CHARGE_COST,
  BREATH_FIST_ENTER,
  BREATH_FIST_EXIT,
  BREATH_HOLD_MS,
  BREATH_MAX,
  BREATH_REGEN_PER_SEC,
  COMBO_WINDOW_MS,
  CONFIDENCE_FLOOR,
  EMPOWER_WINDOW_MS,
  GRIP_ENTER_SCORE,
  GRIP_EXIT_SCORE,
  GRIP_SMOOTH_FRAMES,
  LOCKOUT_MS,
  RISING_COOLDOWN_MS,
  RISING_COST,
  STREAM_COST_PER_SEC,
  SUSTAIN_MIN_SEC,
  THRUST_CONSUME_MS,
  TWIN_COOLDOWN_MS,
  TWIN_COST,
  TWIN_GRACE_MS,
  TWIN_HOLD_MS,
  WHIP_COOLDOWN_MS,
  WHIP_COST,
  WHIP_HOLD_MS,
} from './moves';
import type { MoveEvent, MoveName } from './moves';
import { BodyFrameTracker, POSE_CONFIDENCE_FLOOR, type BodyPoint } from './bodyFrame';
import {
  ArmPhaseMachine,
  ReachLearner,
  armExtension,
  type ArmPhase,
  type ArmTransition,
} from './extension';
import { lateralBandOf, zoneOf, type LateralBand, type ZoneName } from './zones';
import type { MotionProfile } from './profile';

// ---------------------------------------------------------------------------
// Tuning constants (new to the phase engine; legacy values import above)
// ---------------------------------------------------------------------------

/**
 * Two-hand pairing window: twin-cannon extended edges and rising-flame arm
 * completions must land within this of each other. At ~14 fps this is ~3
 * frames of slack between the arms, generous for a deliberate two-hand
 * move, tight enough that two unrelated one-arm motions rarely pair.
 */
export const PAIR_WINDOW_MS = 250;

/**
 * Rising-flame per-arm sweep budget: the wrist must go from the HIP zone to
 * ABOVE_SHOULDER within this. A position sequence with a time sanity cap,
 * not a velocity: at 14 fps the drill's rising reps span 4..9 samples.
 */
export const MAX_SWEEP_MS = 600;

/**
 * A pose sample older than this (vs frame time) counts as a tracking stall
 * and PAUSES the machines: a stuck sample-and-held pose must not accumulate
 * dwell timers or hold a stream alive forever. Normal held/interpolated
 * cadence between ~14 Hz detections stays far below this.
 */
export const POSE_STALE_PAUSE_MS = 500;

/**
 * Positional stillness radius for the breath-charge dwell, shoulder-width
 * units: both wrists must stay within this of their dwell-start anchors.
 * Replaces the legacy speed cap (a velocity) with a pure position bound;
 * 0.25 sw of wander over a full second is a deliberate hold, more is
 * fidgeting.
 */
export const BREATH_STILL_RADIUS = 0.25;

/**
 * Jab settle window: a completed fast traversal is HELD this long before it
 * releases as a jab, and the zone/overdrive gates run on the WRIST'S
 * POSITION AT RELEASE, not at the crossing instant. WHY: the drill-measured
 * hanging-arm drop (guard -> arms at the sides) sweeps extension 0.15 -> 2.0
 * within the thrust window, and at the instant it crosses the extended
 * threshold the wrist is still at CHEST height, so an instant zone check
 * cannot tell it from a punch. 150 ms later the two have diverged
 * completely: a punch is still out in the chest band at ~1.0 extension,
 * the drop has plunged into the HIP zone past the overdrive cap. The cost
 * is ~150 ms plus one frame of jab latency (deliberate trade after five
 * failed velocity rounds: a spurious fireball on every arms-drop reads
 * broken; a small uniform delay reads snappy-enough). Tunable.
 */
export const JAB_SETTLE_MS = 150;

/**
 * Extension overdrive cap at jab release: forward punches normalize to
 * ~0.7..1.1 (drill-measured peaks over the calibrated punch reach), while a
 * dropping or hanging arm blows past 1.5. A release measuring beyond this
 * is not a punch no matter its zone.
 */
export const EXT_OVERDRIVE_MAX = 1.35;

// ---------------------------------------------------------------------------
// Public config and debug types
// ---------------------------------------------------------------------------

export interface PhaseMoveEngineConfig {
  /**
   * ACCEPTED FOR DROP-IN CONSTRUCTION, UNUSED: the legacy engine scaled
   * measured velocities by this; the phase engine has no velocities and its
   * body frame is scale-invariant by construction, so the field is ignored.
   * Kept in the config type so arena's `new MoveEngine({ velocityScale,
   * profile })` call site works unchanged against this class.
   */
  velocityScale?: number;
  /**
   * Wrist-to-wrist distance for the twin-cannon together chamber, screen
   * units (the calibrated handsTogether threshold). Converted to body units
   * per frame by dividing by the live shoulder width, so the calibrated
   * value keeps meaning at any player distance.
   */
  handsTogetherThreshold?: number;
  /** Starting Breath, for tests and debug scenes. Defaults to BREATH_MAX. */
  initialBreath?: number;
  /**
   * Per-player motion profile. The phase engine reads only the OPTIONAL
   * additive reach seeds (maxReachLeftSw/maxReachRightSw); absent fields
   * fall back to the anatomical forward-punch prior in extension.ts.
   */
  profile?: MotionProfile;
}

/** Debug view of one arm for the HUD (agent B). Objects are REUSED in
 *  place across debugState reads: read, never retain. */
export interface ArmDebugState {
  state: ArmPhase;
  extension: number;
  /** Current zone label, or 'NONE' before the body frame is ready. */
  zone: ZoneName | 'NONE';
  paused: boolean;
  lastTransition: Readonly<ArmTransition> | null;
}

/** Engine-level debug surface, pulled at HUD rate only. */
export interface PhaseEngineDebug {
  left: ArmDebugState;
  right: ArmDebugState;
  /** Aim of the last emitted event (any kind), null before any. */
  lastAim: Readonly<Vec3> | null;
  /** Move of the last emitted event, null before any. */
  lastMove: MoveName | null;
}

// ---------------------------------------------------------------------------
// Internal per-arm state
// ---------------------------------------------------------------------------

/** A machine completion awaiting move-level resolution (twin pairing may
 *  hold a jab briefly; everything else resolves on the same frame). */
interface PendingCompletion {
  t: number;
  completedAt: number;
  zone: ZoneName;
}

class ArmState {
  readonly machine = new ArmPhaseMachine();
  readonly learner: ReachLearner;
  /** Latest normalized extension (raw, unsmoothed by design). */
  extension = 0;
  /** Latest raw reach, shoulder-width units (feeds the learner). */
  reachSw = 0;
  /** Peak reach of the current away-from-RETRACTED excursion. */
  peakReachSw = 0;
  /** This frame's pose-landmark confidence verdict for this arm. */
  confident = false;
  /** Latest confident pose wrist (screen space); null before any. */
  wrist: Vec3 | null = null;
  /** Latest confident body point of the pose wrist. */
  readonly bp: BodyPoint = { x: 0, y: 0 };
  hasBody = false;
  zone: ZoneName | null = null;
  /** Zone edge flag for this frame (edge-triggered consumers only). */
  zoneChanged = false;
  /** Last frame time the wrist was in the HIP zone. */
  lastHipT = -Infinity;
  band: LateralBand = 'center';
  /** Inner -> outer lateral crossing edge, this frame. */
  crossedOutward = false;
  /** Rising-flame arm completion time (HIP -> ABOVE_SHOULDER transit). */
  riseCompletedT = -Infinity;
  /** Entered-EXTENDED edge bookkeeping for twin pairing. */
  extendedEdgeT = -Infinity;
  extendedEdgeZone: ZoneName | null = null;
  pendingFire: PendingCompletion | null = null;
  pendingHold: PendingCompletion | null = null;
  suppressThrustUntil = -Infinity;
  /** Breath-charge fist gate at the data-derived chamber level; holds its
   *  last debounced state while the hand is untracked. */
  readonly chamberH = new Hysteresis(BREATH_FIST_ENTER, 4, BREATH_FIST_EXIT, 6);
  /** Whip grip gate, legacy hysteresis; holds state while hand untracked. */
  readonly gripH = new Hysteresis(GRIP_ENTER_SCORE, 4, GRIP_EXIT_SCORE, 6);
  readonly gripRecent: number[] = [];
  gripStaticMs = 0;
  whipArmed = false;
  /** Breath-charge dwell anchor (body units) for the stillness check. */
  readonly dwellAnchor: BodyPoint = { x: 0, y: 0 };

  constructor(reachSeed?: number) {
    this.learner = new ReachLearner(reachSeed);
  }
}

interface SustainState {
  move: MoveName;
  hand: Handedness;
  costPerSec: number;
  aim: Vec3;
  lastOrigin: Vec3;
}

interface EmitRequest {
  move: MoveName;
  hand: Handedness | 'both';
  kind: 'trigger' | 'sustain-start';
  aim: Vec3;
  origin: Vec3;
  completedAt: number;
  cost: number;
  minBreath?: number;
  cooldownMs: number;
  lockoutMs: number;
  /** Bypass the animation lockout: ONLY for the jab -> stream upgrade of
   *  one continuous motion (see the fire-stream emit site). */
  ignoreLockout?: boolean;
}

// ---------------------------------------------------------------------------
// PhaseMoveEngine
// ---------------------------------------------------------------------------

export class PhaseMoveEngine {
  private readonly togetherThreshold: number;
  private readonly body = new BodyFrameTracker();
  private readonly left: ArmState;
  private readonly right: ArmState;

  /**
   * Diagnostics switch, kept for constructor/keybinding parity with the
   * legacy engine (arena's D key flips it). The phase engine's debug
   * surface (debugState) is always safe to read; this flag exists so an
   * integrating HUD can gate any future heavier tracing.
   */
  debugEnabled = false;

  private breathValue: number;
  private lockoutUntil = -Infinity;
  private readonly cooldowns = new Map<MoveName, number>();
  private sustain: SustainState | null = null;
  private combo: Array<{ hand: Handedness; t: number }> = [];
  private empowerUntil = -Infinity;

  private chargeHoldMs = 0;
  private chargeFired = false;
  private dwellAnchored = false;
  private twinHoldMs = 0;
  private twinArmedUntil = -Infinity;
  private risingSuppressUntil = -Infinity;

  private prevT: number | null = null;

  // Debug surface scratch (reused in place; HUD-rate reads only).
  private readonly debugScratch: PhaseEngineDebug = {
    left: { state: 'RETRACTED', extension: 0, zone: 'NONE', paused: false, lastTransition: null },
    right: { state: 'RETRACTED', extension: 0, zone: 'NONE', paused: false, lastTransition: null },
    lastAim: null,
    lastMove: null,
  };
  private lastAim: Vec3 | null = null;
  private lastMove: MoveName | null = null;

  // Aim scratch (body-space projections; fire-rate allocation avoided).
  private readonly scratchA: BodyPoint = { x: 0, y: 0 };
  private readonly scratchB: BodyPoint = { x: 0, y: 0 };

  constructor(config: PhaseMoveEngineConfig = {}) {
    this.togetherThreshold = config.handsTogetherThreshold ?? HANDS_TOGETHER_THRESHOLD;
    this.breathValue = config.initialBreath ?? BREATH_MAX;
    this.left = new ArmState(config.profile?.maxReachLeftSw);
    this.right = new ArmState(config.profile?.maxReachRightSw);
  }

  /** Current Breath stamina, 0..BREATH_MAX. */
  get breath(): number {
    return this.breathValue;
  }

  /** Spend Breath from outside the engine (player-hit penalties). Same
   *  contract as the legacy engine: clamps at 0, ignores junk amounts. */
  spend(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.breathValue = Math.max(0, this.breathValue - amount);
  }

  /** The sustained move currently active, if any. */
  get activeSustain(): MoveName | null {
    return this.sustain ? this.sustain.move : null;
  }

  /** Debug: the frame time of the last processed frame (null before any). */
  get lastFrameT(): number | null {
    return this.prevT;
  }

  /**
   * The live learned per-arm reach (shoulder-width units), for calibration
   * to persist into the profile's optional maxReach*Sw fields.
   */
  get learnedReach(): { left: number; right: number } {
    return { left: this.left.learner.maxReach, right: this.right.learner.maxReach };
  }

  /**
   * Debug preview: the aim vector this arm WOULD emit if a move fired on
   * this frame, computed by the exact positional armAim math the emit path
   * uses, so the arena's debug ray shows precisely where fire will go
   * before the punch commits. Writes into `out` and returns it (the out
   * object is caller-owned, safe to retain). Falls back to straight ahead
   * (AIM_FORWARD) before the body frame is ready or while the arm's wrist
   * is untracked, exactly like the emit path. HUD-open call rates only.
   */
  previewAim(hand: Handedness, out: Vec3): Vec3 {
    const aim = this.armAim(hand);
    out.x = aim.x;
    out.y = aim.y;
    out.z = aim.z;
    return out;
  }

  /**
   * Typed debug surface for the HUD. Allocation-conscious: the returned
   * object and its children are REUSED in place, so callers read fields,
   * never retain the object. HUD-rate calls only.
   */
  get debugState(): Readonly<PhaseEngineDebug> {
    const d = this.debugScratch;
    this.fillArmDebug(d.left, this.left);
    this.fillArmDebug(d.right, this.right);
    d.lastAim = this.lastAim;
    d.lastMove = this.lastMove;
    return d;
  }

  private fillArmDebug(out: ArmDebugState, a: ArmState): void {
    out.state = a.machine.phase;
    out.extension = a.extension;
    out.zone = a.zone ?? 'NONE';
    out.paused = a.machine.paused;
    out.lastTransition = a.machine.lastTransition;
  }

  /** Process one frame. Returns every MoveEvent emitted on this frame. */
  update(frame: LandmarkFrame): MoveEvent[] {
    const events: MoveEvent[] = [];
    const t = frame.t;
    const dtMs = this.prevT === null ? 0 : Math.max(0, t - this.prevT);
    this.prevT = t;
    const dtSec = dtMs / 1000;

    // Body frame maintenance (learns only from confident real samples).
    const pose = frame.pose ?? null;
    if (pose !== null) this.body.update(pose);

    // Per-arm confidence verdicts: pose present, frame ready, sample not
    // stalled, overall confidence AND the side's wrist visibility above the
    // per-landmark floor. Anything less freezes that arm's machinery.
    const poseUsable =
      pose !== null &&
      this.body.ready &&
      t - pose.t <= POSE_STALE_PAUSE_MS &&
      pose.confidence >= POSE_CONFIDENCE_FLOOR;
    const visL = pose?.wristVisibility?.left ?? 1;
    const visR = pose?.wristVisibility?.right ?? 1;

    // Finger-pose gates first (they hold state through hand loss).
    this.updateHandGates(this.left, frame.left);
    this.updateHandGates(this.right, frame.right);

    this.updateArm(this.left, 'left', pose, poseUsable && visL >= POSE_CONFIDENCE_FLOOR, t, dtMs);
    this.updateArm(this.right, 'right', pose, poseUsable && visR >= POSE_CONFIDENCE_FLOOR, t, dtMs);

    // Reach decay is wall-clock-slow bookkeeping, safe every frame.
    this.left.learner.decay(dtSec);
    this.right.learner.decay(dtSec);

    // Breath regenerates whenever no sustained move is active.
    if (!this.sustain) {
      this.breathValue = Math.min(BREATH_MAX, this.breathValue + BREATH_REGEN_PER_SEC * dtSec);
    }

    if (this.sustain) {
      // An active sustained move locks out every other trigger; drop any
      // completions the machines produced during it so they cannot fire
      // stale after the stream ends.
      this.left.pendingFire = null;
      this.left.pendingHold = null;
      this.right.pendingFire = null;
      this.right.pendingHold = null;
      this.updateSustain(events, t, dtSec);
      return this.stampCapture(events, frame);
    }

    // Priority order: two-hand > grip > thrusts.
    this.evalBreathCharge(events, t, dtMs);
    this.evalTwinCannon(events, t, dtMs);
    this.evalRisingFlame(events, t);
    this.evalWhip(events, t, 'left');
    this.evalWhip(events, t, 'right');
    this.evalThrust(events, t, 'left');
    this.evalThrust(events, t, 'right');

    return this.stampCapture(events, frame);
  }

  /** Stamp events with the frame's captureTs (live frames only). */
  private stampCapture(events: MoveEvent[], frame: LandmarkFrame): MoveEvent[] {
    if (frame.captureTs !== undefined) {
      for (const e of events) e.captureTs = frame.captureTs;
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Per-arm tracking
  // -------------------------------------------------------------------------

  /**
   * Hand-landmark finger gates. Only PRESENT hands advance the hysteresis;
   * an absent or low-confidence hand leaves both gates holding their last
   * debounced state (the confidence-aware rule: absence neither passes nor
   * fails a gate, because the hand vanishing is a tracking artifact of fast
   * motion, not evidence about the fingers).
   */
  private updateHandGates(a: ArmState, raw: HandFrame | null): void {
    const present =
      raw !== null && raw.confidence >= CONFIDENCE_FLOOR && raw.landmarks.length >= 21;
    if (!present || raw === null) return;
    a.chamberH.update(fistScore(raw));
    // Grip runs on the legacy short moving average (raw per-frame grip
    // scores are noisy; see GRIP_SMOOTH_FRAMES in moves.ts).
    a.gripRecent.push(gripScore(raw));
    if (a.gripRecent.length > GRIP_SMOOTH_FRAMES) a.gripRecent.shift();
    let sum = 0;
    for (const g of a.gripRecent) sum += g;
    a.gripH.update(sum / a.gripRecent.length);
  }

  /**
   * Advance one arm: extension, phase machine, zone and lateral-band edges,
   * whip static hold, reach learning. Unconfident frames freeze the machine
   * and leave every position-derived field holding its last value.
   */
  private updateArm(
    a: ArmState,
    side: Handedness,
    pose: PoseFrame | null,
    confident: boolean,
    t: number,
    dtMs: number,
  ): void {
    a.zoneChanged = false;
    a.crossedOutward = false;
    a.confident = confident;

    if (!confident || pose === null) {
      a.machine.update(a.extension, t, false);
      return;
    }

    const arm: PoseArm = side === 'left' ? pose.left : pose.right;
    const anchor = this.body.shoulderAnchor(side);
    a.wrist = arm.wrist;
    a.reachSw =
      Math.hypot(arm.wrist.x - anchor.x, arm.wrist.y - anchor.y) / this.body.scale;
    a.extension = armExtension(anchor, arm.wrist, this.body.scale, a.learner.maxReach);

    // Zone and lateral band, edge-triggered.
    this.body.toBody(arm.wrist, a.bp);
    a.hasBody = true;
    const zone = zoneOf(a.bp, this.body.hipY);
    if (zone !== a.zone) {
      const prev = a.zone;
      a.zone = zone;
      a.zoneChanged = true;
      // Rising-flame arm completion: entered ABOVE_SHOULDER recently enough
      // after last touching the HIP zone. Position sequence, no velocity.
      if (
        zone === 'ABOVE_SHOULDER' &&
        prev !== null &&
        t - a.lastHipT <= MAX_SWEEP_MS
      ) {
        a.riseCompletedT = t;
      }
    }
    if (zone === 'HIP') a.lastHipT = t;
    const band = lateralBandOf(a.bp, side);
    if (band !== a.band) {
      a.crossedOutward = a.band === 'inner' && band === 'outer';
      a.band = band;
    }

    // Phase machine (raw extension, no smoothing by design).
    const u = a.machine.update(a.extension, t, true);

    // Punch-context reach learning: track the peak of the excursion since
    // RETRACTED; only a completed FAST traversal teaches the learner (a
    // hanging arm's 2.2 sw plateau never reaches here, see extension.ts).
    if (a.machine.phase === 'RETRACTED') a.peakReachSw = 0;
    else if (a.reachSw > a.peakReachSw) a.peakReachSw = a.reachSw;

    if (u.enteredExtended) {
      a.extendedEdgeT = t;
      a.extendedEdgeZone = zone;
    }
    if (u.fired) {
      a.learner.learn(a.peakReachSw);
      a.pendingFire = { t, completedAt: u.completedAt, zone };
    }
    if (u.holdPromoted) {
      a.pendingHold = { t, completedAt: u.completedAt, zone };
    }

    // Whip static hold: grip active and the wrist staying within one zone.
    // "Static" is positional (one zone), not a speed cap. Unconfident
    // frames skip this whole block, freezing the accumulator.
    if (a.gripH.isActive) {
      if (a.zoneChanged) a.gripStaticMs = 0;
      else a.gripStaticMs += dtMs;
      if (a.gripStaticMs >= WHIP_HOLD_MS) a.whipArmed = true;
    } else {
      a.gripStaticMs = 0;
      a.whipArmed = false;
    }
  }

  // -------------------------------------------------------------------------
  // Two-hand moves
  // -------------------------------------------------------------------------

  /**
   * Breath charge: both wrists dwell in the HIP zone for BREATH_HOLD_MS
   * with the chamber fist gate active and positional stillness (wrists
   * within BREATH_STILL_RADIUS of their dwell anchors). Unconfident frames
   * FREEZE the dwell (no accumulation, no reset), per the pause rule.
   */
  private evalBreathCharge(events: MoveEvent[], t: number, dtMs: number): void {
    const L = this.left;
    const R = this.right;
    if (!L.confident || !R.confident) return; // freeze, hold accumulated dwell

    const chambered =
      L.zone === 'HIP' &&
      R.zone === 'HIP' &&
      L.chamberH.isActive &&
      R.chamberH.isActive;
    if (!chambered) {
      this.chargeHoldMs = 0;
      this.chargeFired = false;
      this.dwellAnchored = false;
      return;
    }

    if (!this.dwellAnchored) {
      this.dwellAnchored = true;
      L.dwellAnchor.x = L.bp.x;
      L.dwellAnchor.y = L.bp.y;
      R.dwellAnchor.x = R.bp.x;
      R.dwellAnchor.y = R.bp.y;
      this.chargeHoldMs = 0;
    } else if (
      Math.hypot(L.bp.x - L.dwellAnchor.x, L.bp.y - L.dwellAnchor.y) > BREATH_STILL_RADIUS ||
      Math.hypot(R.bp.x - R.dwellAnchor.x, R.bp.y - R.dwellAnchor.y) > BREATH_STILL_RADIUS
    ) {
      // Wandered: restart the dwell around the new resting spot.
      L.dwellAnchor.x = L.bp.x;
      L.dwellAnchor.y = L.bp.y;
      R.dwellAnchor.x = R.bp.x;
      R.dwellAnchor.y = R.bp.y;
      this.chargeHoldMs = 0;
      this.chargeFired = false;
      return;
    }

    this.chargeHoldMs += dtMs;
    if (this.chargeHoldMs < BREATH_HOLD_MS || this.chargeFired) return;
    this.chargeFired = true; // one charge per continuous hold
    const emitted = this.emit(events, t, {
      move: 'breath-charge',
      hand: 'both',
      kind: 'trigger',
      aim: { ...AIM_FORWARD },
      origin: this.midOrigin(),
      completedAt: t - (this.chargeHoldMs - BREATH_HOLD_MS),
      cost: BREATH_CHARGE_COST,
      cooldownMs: 0,
      lockoutMs: LOCKOUT_MS['breath-charge'],
    });
    if (emitted) {
      this.empowerUntil = t + EMPOWER_WINDOW_MS;
      // The charge claims the at-hips posture: its release (both fists
      // rising off the hips) is geometrically a rising sweep and must not
      // read as one. Same consume-window idea as the legacy engine.
      L.riseCompletedT = -Infinity;
      R.riseCompletedT = -Infinity;
      this.risingSuppressUntil = t + THRUST_CONSUME_MS;
    }
  }

  /**
   * Twin cannon: chest-together chamber (hold TWIN_HOLD_MS, then armed for
   * TWIN_GRACE_MS after the hold breaks), then both arms enter EXTENDED
   * within PAIR_WINDOW_MS of each other, completion zones gated like jabs.
   */
  private evalTwinCannon(events: MoveEvent[], t: number, dtMs: number): void {
    const L = this.left;
    const R = this.right;
    const bothConf = L.confident && R.confident;

    if (bothConf && L.hasBody && R.hasBody) {
      const togetherBody = this.togetherThreshold / this.body.scale;
      const chamber =
        L.zone === 'CHEST' &&
        R.zone === 'CHEST' &&
        Math.hypot(L.bp.x - R.bp.x, L.bp.y - R.bp.y) < togetherBody;
      if (chamber) {
        this.twinHoldMs += dtMs;
        if (this.twinHoldMs >= TWIN_HOLD_MS) this.twinArmedUntil = t + TWIN_GRACE_MS;
      } else {
        this.twinHoldMs = 0;
      }
    }
    // Unconfident frames freeze the hold accumulator (no reset).

    const armed = this.twinHoldMs >= TWIN_HOLD_MS || t <= this.twinArmedUntil;
    if (!armed) return;
    const lE = L.extendedEdgeT;
    const rE = R.extendedEdgeT;
    const jointThrust =
      Number.isFinite(lE) &&
      Number.isFinite(rE) &&
      Math.abs(lE - rE) <= PAIR_WINDOW_MS &&
      t - Math.max(lE, rE) <= PAIR_WINDOW_MS &&
      this.thrustZoneOk(L.extendedEdgeZone) &&
      this.thrustZoneOk(R.extendedEdgeZone);
    if (!jointThrust) return;

    // The joint thrust belongs to Twin Cannon whether or not it fires:
    // consume both arms so the same motion cannot fall through as jabs.
    this.consumeThrust(L, t);
    this.consumeThrust(R, t);
    this.twinHoldMs = 0;
    this.twinArmedUntil = -Infinity;

    this.emit(events, t, {
      move: 'twin-cannon',
      hand: 'both',
      kind: 'trigger',
      aim: this.twoHandAim(),
      origin: this.midOrigin(),
      completedAt: Math.max(lE, rE),
      cost: TWIN_COST,
      cooldownMs: TWIN_COOLDOWN_MS,
      lockoutMs: LOCKOUT_MS['twin-cannon'],
    });
  }

  /**
   * Rising flame: both arms completed a HIP -> ABOVE_SHOULDER transit (each
   * within MAX_SWEEP_MS, recorded as edges in updateArm), pair within
   * PAIR_WINDOW_MS. Suppressed briefly after a breath charge fires.
   */
  private evalRisingFlame(events: MoveEvent[], t: number): void {
    if (t < this.risingSuppressUntil) return;
    const L = this.left;
    const R = this.right;
    const lT = L.riseCompletedT;
    const rT = R.riseCompletedT;
    const pair =
      Number.isFinite(lT) &&
      Number.isFinite(rT) &&
      Math.abs(lT - rT) <= PAIR_WINDOW_MS &&
      t - Math.max(lT, rT) <= PAIR_WINDOW_MS;
    if (!pair) return;

    L.riseCompletedT = -Infinity;
    R.riseCompletedT = -Infinity;
    // The sweep belongs to Rising Flame: claim both arms' motion.
    this.consumeThrust(L, t);
    this.consumeThrust(R, t);

    this.emit(events, t, {
      move: 'rising-flame',
      hand: 'both',
      kind: 'trigger',
      aim: this.twoHandAim(),
      origin: this.midOrigin(),
      completedAt: Math.max(lT, rT),
      cost: RISING_COST,
      cooldownMs: RISING_COOLDOWN_MS,
      lockoutMs: LOCKOUT_MS['rising-flame'],
    });
  }

  // -------------------------------------------------------------------------
  // Grip family
  // -------------------------------------------------------------------------

  /**
   * Fire whip: after the static grip hold armed the arm (updateArm), the
   * wrist crossing from the inner lateral band to the outer band fires.
   * Pure position crossing; the band edge is computed in updateArm.
   */
  private evalWhip(events: MoveEvent[], t: number, hand: Handedness): void {
    const a = this.armState(hand);
    if (!a.confident || !a.whipArmed || !a.gripH.isActive) return;
    if (!a.crossedOutward || a.wrist === null) return;

    // The swing consumes the arm whether or not the move fires, and claims
    // the arm's motion so the thrust family cannot reinterpret it.
    a.whipArmed = false;
    a.gripStaticMs = 0;
    this.consumeThrust(a, t);

    this.emit(events, t, {
      move: 'fire-whip',
      hand,
      kind: 'trigger',
      aim: this.armAim(hand),
      origin: a.wrist,
      completedAt: t,
      cost: WHIP_COST,
      cooldownMs: WHIP_COOLDOWN_MS,
      lockoutMs: LOCKOUT_MS['fire-whip'],
    });
  }

  // -------------------------------------------------------------------------
  // Thrust family (jab / cross-combo / fire-stream)
  // -------------------------------------------------------------------------

  /** Completion zones that may fire the thrust family: never the HIP zone
   *  (hanging-arm drop) and never ABOVE_SHOULDER (rising territory). */
  private thrustZoneOk(zone: ZoneName | null): boolean {
    return zone === 'CHEST' || zone === 'LATERAL_INNER' || zone === 'LATERAL_OUTER';
  }

  private evalThrust(events: MoveEvent[], t: number, hand: Handedness): void {
    const a = this.armState(hand);
    const gripClaim = a.gripH.isActive || a.whipArmed;

    // Stream promotion: the dwell signal from the machine, gated like a jab
    // (zone at the dwell, CURRENT zone, overdrive, grip claim, consume
    // windows). A fast hanging-arm drop also dwells "extended", but it
    // dwells in the HIP zone far past the overdrive cap, so it cannot
    // start a stream.
    const hold = a.pendingHold;
    if (hold !== null) {
      a.pendingHold = null;
      if (
        t >= a.suppressThrustUntil &&
        !gripClaim &&
        this.thrustZoneOk(hold.zone) &&
        this.thrustZoneOk(a.zone) &&
        a.extension <= EXT_OVERDRIVE_MAX &&
        a.wrist !== null &&
        this.sustain === null
      ) {
        const aim = this.armAim(hand);
        const emitted = this.emit(events, t, {
          move: 'fire-stream',
          hand,
          kind: 'sustain-start',
          aim,
          origin: a.wrist,
          completedAt: hold.completedAt,
          cost: 0,
          minBreath: STREAM_COST_PER_SEC * SUSTAIN_MIN_SEC,
          cooldownMs: 0,
          lockoutMs: 0,
          // The dwell is the SAME physical motion that already fired this
          // arm's jab at release; the jab's animation lockout must not
          // refuse the deliberate upgrade to a stream (mirrors the legacy
          // extend-hold path, where one motion resolved to one of the two).
          ignoreLockout: true,
        });
        if (emitted) {
          this.sustain = {
            move: 'fire-stream',
            hand,
            costPerSec: STREAM_COST_PER_SEC,
            aim,
            lastOrigin: a.wrist,
          };
          return; // the new sustain claims the frame
        }
      }
    }

    const fire = a.pendingFire;
    if (fire === null) return;
    if (t < a.suppressThrustUntil || gripClaim || !this.thrustZoneOk(fire.zone)) {
      a.pendingFire = null;
      return;
    }

    // Settle-then-release (see JAB_SETTLE_MS): hold the completion so the
    // wrist can show where it was really going. While the twin chamber is
    // armed the hold stretches to the pairing window so the partner arm can
    // join; a lone completion then releases as a jab (its latency reflects
    // the wait, which is a deliberate posture, not detector lag). An
    // unconfident arm keeps the completion pending: release gates need a
    // live position.
    const twinArmed = this.twinHoldMs >= TWIN_HOLD_MS || t <= this.twinArmedUntil;
    const settleMs = twinArmed ? Math.max(JAB_SETTLE_MS, PAIR_WINDOW_MS) : JAB_SETTLE_MS;
    if (t - fire.t < settleMs) return;
    if (!a.confident) return;

    a.pendingFire = null;
    // Release gates on the CURRENT position: a punch is still out in the
    // chest band near ~1.0 extension; a hanging-arm drop is in the HIP zone
    // past the overdrive cap (see the constants above).
    if (!this.thrustZoneOk(a.zone) || a.extension > EXT_OVERDRIVE_MAX) return;
    this.emitJab(events, t, hand, a, fire);
  }

  private emitJab(
    events: MoveEvent[],
    t: number,
    hand: Handedness,
    a: ArmState,
    fire: PendingCompletion,
  ): void {
    if (a.wrist === null) return;

    // Cross Combo: three alternating-hand jabs inside the rolling window
    // (same modeling as legacy: the third hit upgrades instead of stacking).
    this.combo = this.combo.filter((e) => t - e.t <= COMBO_WINDOW_MS).slice(-2);
    const last = this.combo[this.combo.length - 1];
    const secondLast = this.combo[this.combo.length - 2];
    const isCombo =
      last !== undefined &&
      secondLast !== undefined &&
      last.hand !== hand &&
      secondLast.hand === hand;
    const move: MoveName = isCombo ? 'cross-combo' : 'jab-blast';

    const emitted = this.emit(events, t, {
      move,
      hand,
      kind: 'trigger',
      aim: this.armAim(hand),
      origin: a.wrist,
      completedAt: fire.completedAt,
      cost: 0,
      cooldownMs: 0,
      lockoutMs: LOCKOUT_MS[move],
    });
    if (emitted) {
      if (isCombo) this.combo = []; // third hit resets the combo window
      else this.combo.push({ hand, t });
    }
  }

  // -------------------------------------------------------------------------
  // Sustained move lifecycle
  // -------------------------------------------------------------------------

  private updateSustain(events: MoveEvent[], t: number, dtSec: number): void {
    const su = this.sustain;
    if (su === null) return;
    const a = this.armState(su.hand);

    if (a.machine.paused) {
      // FREEZE, not end: tracking blinked, the player likely still holds
      // the pose. No drain while frozen; the stream resumes or ends on the
      // player's real state once confidence returns.
      events.push({
        move: su.move,
        hand: su.hand,
        t,
        aim: su.aim,
        origin: su.lastOrigin,
        empowered: false,
        kind: 'sustain-tick',
        triggerLatencyMs: 0,
      });
      return;
    }

    this.breathValue -= su.costPerSec * dtSec;
    if (a.wrist !== null) su.lastOrigin = a.wrist;

    // The stream ends when the arm leaves EXTENDED (drops below the re-arm
    // level, phase machine's transition) or Breath runs out. Position and
    // Breath only: no retract velocity anywhere.
    const ended = this.breathValue <= 0 || a.machine.phase !== 'EXTENDED';
    if (ended) {
      this.breathValue = Math.max(0, this.breathValue);
      this.sustain = null;
      events.push({
        move: su.move,
        hand: su.hand,
        t,
        aim: su.aim,
        origin: su.lastOrigin,
        empowered: false,
        kind: 'sustain-end',
        triggerLatencyMs: 0,
      });
      return;
    }

    // Positional steering: the tick aim is recomputed from the CURRENT arm
    // position, so pointing the extended arm sweeps the stream. Same
    // position, same aim, at any frame rate.
    su.aim = this.armAim(su.hand);
    events.push({
      move: su.move,
      hand: su.hand,
      t,
      aim: su.aim,
      origin: su.lastOrigin,
      empowered: false,
      kind: 'sustain-tick',
      triggerLatencyMs: 0,
    });
  }

  // -------------------------------------------------------------------------
  // Emission core (lockout, cooldown, Breath, empowerment; legacy contract)
  // -------------------------------------------------------------------------

  private emit(events: MoveEvent[], t: number, req: EmitRequest): boolean {
    if (req.ignoreLockout !== true && t < this.lockoutUntil) return false;
    const cdUntil = this.cooldowns.get(req.move) ?? -Infinity;
    if (t < cdUntil) return false;
    const minBreath = req.minBreath ?? req.cost;
    if (this.breathValue < minBreath) return false;

    this.breathValue -= req.cost;
    if (req.cooldownMs > 0) this.cooldowns.set(req.move, t + req.cooldownMs);
    if (req.lockoutMs > 0) this.lockoutUntil = t + req.lockoutMs;

    let empowered = false;
    if (req.move !== 'breath-charge' && t <= this.empowerUntil) {
      empowered = true;
      this.empowerUntil = -Infinity; // the charge is consumed by this move
    }

    events.push({
      move: req.move,
      hand: req.hand,
      t,
      aim: req.aim,
      origin: req.origin,
      empowered,
      kind: req.kind,
      triggerLatencyMs: Math.max(0, t - req.completedAt),
    });
    this.lastAim = req.aim;
    this.lastMove = req.move;
    return true;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private armState(hand: Handedness): ArmState {
    return hand === 'left' ? this.left : this.right;
  }

  private consumeThrust(a: ArmState, t: number): void {
    a.pendingFire = null;
    a.pendingHold = null;
    a.extendedEdgeT = -Infinity;
    a.suppressThrustUntil = t + THRUST_CONSUME_MS;
  }

  /**
   * One-arm positional aim: unit 2D body-frame shoulder-to-wrist direction
   * with forward depth from extension (z = -extension, clamped to 1; screen
   * -z is toward the camera i.e. world-forward at the enemy), normalized.
   * Deterministic in position alone: no velocity, no MediaPipe z.
   */
  private armAim(hand: Handedness): Vec3 {
    const a = this.armState(hand);
    if (!a.hasBody || a.wrist === null) return { ...AIM_FORWARD };
    const anchor = this.body.shoulderAnchor(hand);
    const bpW = this.body.toBody(a.wrist, this.scratchA);
    const bpS = this.body.toBody(
      { x: anchor.x, y: anchor.y, z: 0 },
      this.scratchB,
    );
    const dx = bpW.x - bpS.x;
    const dy = bpW.y - bpS.y;
    const planar = Math.hypot(dx, dy);
    if (planar < 1e-6) return { ...AIM_FORWARD };
    const ext = Math.min(1, Math.max(0, a.extension));
    const aim = normalize({ x: dx / planar, y: dy / planar, z: -ext });
    if (aim.x === 0 && aim.y === 0 && aim.z === 0) return { ...AIM_FORWARD };
    return aim;
  }

  /** Two-hand aim: mean of both arms' planar directions, forward depth from
   *  the mean extension. Falls back to one arm, then straight ahead. */
  private twoHandAim(): Vec3 {
    const l = this.armAim('left');
    const r = this.armAim('right');
    const aim = normalize({
      x: (l.x + r.x) / 2,
      y: (l.y + r.y) / 2,
      z: (l.z + r.z) / 2,
    });
    if (aim.x === 0 && aim.y === 0 && aim.z === 0) return { ...AIM_FORWARD };
    return aim;
  }

  /** Midpoint of the pose wrists, screen space (legacy origin contract). */
  private midOrigin(): Vec3 {
    const lw = this.left.wrist;
    const rw = this.right.wrist;
    if (lw !== null && rw !== null) {
      return { x: (lw.x + rw.x) / 2, y: (lw.y + rw.y) / 2, z: (lw.z + rw.z) / 2 };
    }
    const one = lw ?? rw;
    return one !== null ? { ...one } : { x: 0.5, y: 0.5, z: 0 };
  }
}
