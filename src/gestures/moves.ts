/**
 * The 9-move state machine (spec Section 7). Consumes LandmarkFrame objects
 * one per frame via MoveEngine.update() and emits MoveEvent objects.
 * Everything is deterministic and frame-driven: all timing derives from
 * LandmarkFrame.t, never from wall clocks.
 *
 * AIM SEMANTICS (combat layer contract):
 *   MoveEvent.aim is the normalized SCREEN-SPACE hand velocity at the moment
 *   the move triggered (filtered over the last AIM_WINDOW_FRAMES frames).
 *   When body pose is FRESH, thrust-family aims (jab / cross / palm-wave /
 *   stream / fan) blend the forearm direction into the velocity aim (see
 *   thrustAim and AIM_FOREARM_WEIGHT); twin / rising / whip and every
 *   pose-absent path keep the pure velocity aim.
 *   Screen space is player space from tracking/types.ts: x grows to the
 *   player's right, y grows DOWN, z is NEGATIVE toward the camera. A punch
 *   thrown at the camera therefore has aim.z < 0 (dominant), an upward sweep
 *   has aim.y < 0, a rightward whip has aim.x > 0. The combat layer maps
 *   screen space into world space (screen -z toward the camera becomes world
 *   forward into the scene, away from the player). When the hand is moving
 *   too slowly to define a direction (speed below the derived aimMinSpeed
 *   threshold) the aim falls back to AIM_FORWARD = (0, 0, -1), i.e. straight
 *   at the enemy.
 *   MoveEvent.origin is the triggering wrist position (midpoint of both
 *   wrists for two-hand moves) in the same screen space.
 *
 * LATENCY SEMANTICS (spec Section 13: under 120 ms of frame time):
 *   triggerLatencyMs = event emission time minus the time the TRIGGER
 *   condition completed. Pose acquisition hysteresis (enter 0.75 x 4 frames,
 *   Section 6) happens during the wind-up of a move (raising the fist,
 *   holding the grip) and is deliberately NOT counted: at 30 fps, 4 frames
 *   of pose debounce is ~133 ms, but it overlaps the player's own wind-up
 *   motion, so it never delays the felt response. What must be fast is the
 *   final physical criterion: the speed spike / retract onset / hold-timer
 *   expiry. Those are detected on raw per-frame data and emitted on the same
 *   frame they are first observable, so triggerLatencyMs stays within one
 *   frame (~33 ms) and always under the 120 ms budget. For hold-based
 *   triggers, completion is the exact instant the hold crossed its duration
 *   threshold (which can fall between frames), so latency there is bounded
 *   by one frame interval too.
 *
 * PRIORITY (Section 7): two-hand moves > grip moves > palm > fist, evaluated
 * in that order every frame. A triggered move locks out all others for its
 * animation duration (LOCKOUT_MS); an active sustained move locks out
 * everything until it ends. Cooldowns are tracked separately per move (and
 * per hand for the jab family).
 */

import type { HandFrame, LandmarkFrame, PoseFrame, Vec3 } from '../tracking/types';
import { LM } from '../tracking/types';
import { Hysteresis } from '../tracking/filters';
import { elbowAngle, elbowAngularVelocity } from '../tracking/poseSource';
import type { Handedness, HandSpeed } from './poses';
import {
  add,
  dist,
  fistScore,
  gripScore,
  handSpeed,
  lm,
  normalize,
  palmScore,
  scale,
  HANDS_TOGETHER_THRESHOLD,
} from './poses';
import { bboxGrowthRate } from './motion';
import {
  DEFAULT_PROFILE,
  thresholdsFrom,
  type MotionProfile,
  type MotionThresholds,
} from './profile';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MoveName =
  | 'jab-blast'
  | 'fire-stream'
  | 'cross-combo'
  | 'palm-wave'
  | 'flame-fan'
  | 'twin-cannon'
  | 'rising-flame'
  | 'fire-whip'
  | 'breath-charge';

export type MoveEventKind = 'trigger' | 'sustain-start' | 'sustain-tick' | 'sustain-end';

export interface MoveEvent {
  move: MoveName;
  hand: Handedness | 'both';
  /** Frame timestamp (ms since source start) at which the event was emitted. */
  t: number;
  /** Normalized screen-space direction; see AIM SEMANTICS above. */
  aim: Vec3;
  /** Triggering wrist position (midpoint for two-hand moves), screen space. */
  origin: Vec3;
  /** True when a Breath Charge empowered this move (1.6x damage, bigger VFX). */
  empowered: boolean;
  kind: MoveEventKind;
  /** Emission time minus trigger-condition completion time; see LATENCY above. */
  triggerLatencyMs: number;
}

export interface MoveEngineConfig {
  /**
   * Calibration-derived multiplier applied to all measured hand velocities
   * before threshold comparison (calibrationStats will tune this per player;
   * a player standing further from the camera gets a scale > 1). Span growth
   * is NOT scaled: it is a relative rate and already distance-invariant.
   */
  velocityScale?: number;
  /** Wrist-to-wrist distance for Twin Cannon arming. Calibrated per player. */
  handsTogetherThreshold?: number;
  /** Starting Breath, for tests and debug scenes. Defaults to BREATH_MAX. */
  initialBreath?: number;
  /**
   * Per-player motion profile from the calibration punch/push steps. All
   * motion thresholds derive from it once, in the constructor. Absent (replay
   * fixtures, tests) DEFAULT_PROFILE reproduces the classic tuned values.
   */
  profile?: MotionProfile;
}

/**
 * One near-miss diagnostic record (see MoveEngine.debugEnabled): a move whose
 * trigger was evaluated and failed on a final physical condition while the
 * measured value was at least NEAR_MISS_FRACTION of the threshold.
 *
 * Fusion additions: 'elbowVel' reports the pose-fusion PRIMARY signal
 * failing while pose was fresh; 'secondary' reports the primary passing but
 * NEITHER secondary crossing, in which case value/threshold carry the speed
 * pair and value2/threshold2 the bbox-growth pair (both shown by the HUD as
 * "no secondary: speed a/b, growth c/d").
 */
export interface NearMissRecord {
  t: number;
  move: MoveName;
  condition: 'speed' | 'growth' | 'upVel' | 'swingVx' | 'elbowVel' | 'secondary';
  value: number;
  threshold: number;
  /** Second signal pair, only for condition 'secondary'. */
  value2?: number;
  threshold2?: number;
}

/** Live fusion diagnostics for one hand (debug HUD; pulled at HUD rate). */
export interface FusionState {
  /** Elbow-extension angular velocity, rad/s (positive = extending). */
  elbowVel: number;
  elbowThreshold: number;
  /** True when a pose sample landed within POSE_FRESH_MS of the last frame. */
  elbowFresh: boolean;
  wristSpeed: number;
  speedThreshold: number;
  bboxGrowth: number;
  growthThreshold: number;
}

/** Debug view of one hand's pose classifier state. */
export interface PoseScores {
  fist: number;
  palm: number;
  grip: number;
  fistActive: boolean;
  palmActive: boolean;
  gripActive: boolean;
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
// PROVISIONAL: every threshold below is tuned against the synthetic fixtures
// only (fixtures/specs.ts motion profiles: jab thrusts spike above ~1.3 u/s
// windowed, negative fixtures stay below ~0.6 windowed). They must be retuned
// once real recordings exist in fixtures/recorded/ and calibrationStats
// supplies per-player velocity scaling. Units: normalized screen units and
// units/second, milliseconds for durations, y grows DOWN.

/** Aim/velocity filter window per Section 7 (fires along the hand velocity). */
export const AIM_WINDOW_FRAMES = 6;
/** Below this confidence a hand is treated as absent by the move layer. */
export const CONFIDENCE_FLOOR = 0.5;

// MOTION THRESHOLDS: the old absolute constants (SPIKE_SPEED_MIN 0.9,
// SPIKE_TOWARD_MIN 0.6, RETRACT_AWAY_VEL_MIN 0.5, RISING_UP_VEL_MIN 1.0,
// WHIP_SWING_VX_MIN 1.0, WHIP_STATIC_SPEED_MAX 0.3, BREATH_STATIC_SPEED_MAX
// 0.4, AIM_MIN_SPEED 0.5) are gone: every motion trigger now derives from a
// per-player MotionProfile via thresholdsFrom() (src/gestures/profile.ts).
// thresholdsFrom(DEFAULT_PROFILE) reproduces those exact values, so fixtures
// and tests stay deterministic.
//
// PUNCH FUSION (three signals, anchored on body pose):
//   PRIMARY   elbow-extension angular velocity from PoseLandmarker (rad/s,
//             d(elbow angle)/dt between consecutive POSE SAMPLES, positive =
//             opening toward straight). Anchored on large stable joints, so
//             it does not degrade when the fist clenches.
//   SECONDARY windowed wrist screen-space speed (s.speed.speed).
//   SECONDARY windowed hand bounding-box-diagonal growth (bboxGrowthRate in
//             src/gestures/motion.ts). The full-hand bbox replaces palm-span
//             growth: a clenching fist collapses the palm measurements into
//             a small noisy cluster, i.e. span growth measured its weakest
//             quantity exactly when a jab happened; the 21-landmark box
//             keeps a stable extent through the clench.
// FIRE RULE: pose fresh (a sample within POSE_FRESH_MS) -> primary AND at
// least one secondary. Pose absent or stale (replay fixtures, tracking
// dropouts) -> BOTH secondaries; this documented fallback is exactly the
// pre-fusion behavior and keeps the synthetic suite meaningful. Retract is
// bbox SHRINK, or (pose fresh) a fast elbow re-flex. MediaPipe z stays out:
// it is a monocular depth guess, far too noisy on real hands.

/**
 * A pose sample this recent (vs the current frame time) counts as fresh and
 * arms the fusion path; anything older falls back to the two-secondary rule.
 * Pose runs at ~15 Hz (66 ms) nominally and ~7.5 Hz degraded, so 250 ms
 * tolerates a missed detection without flapping between rules.
 */
export const POSE_FRESH_MS = 250;

/**
 * A gap between pose samples longer than this resets the elbow-angle
 * differencing (tracking dropout): the first sample after the gap
 * re-baselines instead of producing a bogus velocity across the hole.
 */
export const ELBOW_RESET_GAP_MS = 500;

/**
 * Thrust-family aim blend when pose is fresh (TUNABLE): the emitted aim is
 * normalize(0.6 * forearm direction + 0.4 * velocity aim). The forearm
 * (elbow -> wrist, screen space, z borrowed from the velocity aim) is where
 * the player is POINTING, steadier than raw hand velocity; the velocity
 * fraction keeps flicks responsive. Pose absent: pure velocity aim.
 */
export const AIM_FOREARM_WEIGHT = 0.6;
export const AIM_VELOCITY_WEIGHT = 0.4;

/**
 * Weak secondary z check. When true, a generous toward-camera z velocity is
 * OR-ed into the spike condition (never required); kept for experiments on
 * sources with trustworthy depth. Default false: z stays out of the loop.
 */
export const Z_TOWARD_SECONDARY = false;
/** Toward-camera z velocity for the weak secondary check (generous: only an
 *  unmistakable z spike passes, since z is untrusted). */
export const Z_TOWARD_SECONDARY_MIN = 1.0;

/** Hold duration after a thrust that upgrades it to a sustained move. */
export const EXTEND_HOLD_MS = 350;
/** Fallback aim: straight at the enemy (screen -z is toward the camera). */
export const AIM_FORWARD: Vec3 = { x: 0, y: 0, z: -1 };

/** Near-miss diagnostics: record a failed condition at or above this fraction
 *  of its threshold. */
export const NEAR_MISS_FRACTION = 0.5;
/** Near-miss ring buffer capacity. */
export const NEAR_MISS_CAPACITY = 8;

export const JAB_COOLDOWN_MS = 250; // per hand, Section 7 table
export const COMBO_WINDOW_MS = 1500;

export const PALM_WAVE_COOLDOWN_MS = 600;

export const TWIN_HOLD_MS = 300;
export const TWIN_GRACE_MS = 500; // thrust may follow this soon after the hold breaks
export const TWIN_CHEST_Y_MIN = 0.4;
export const TWIN_CHEST_Y_MAX = 0.68;
export const TWIN_COST = 40;
export const TWIN_COOLDOWN_MS = 5000;

export const RISING_LOW_Y = 0.65; // wrists below this line (y grows down) are "low"
/**
 * HIP-RELATIVE BANDS (Round 3 Phase 3): when body pose is FRESH, the
 * "at hips" (Breath Charge) and "low" (Rising Flame) wrist bands anchor to
 * the player's real hip line instead of the absolute screen constants: a
 * wrist counts as below the band when wrist.y > hipCenterY - margin (y grows
 * DOWN, so the margin admits wrists slightly ABOVE the hip line). Pose
 * absent or stale keeps the absolute constants (BREATH_HIP_Y, RISING_LOW_Y)
 * exactly as before, which is what every legacy replay fixture runs on.
 * The rising margin is the looser of the two, mirroring the 0.05 gap
 * between the absolute constants.
 */
export const BREATH_HIP_MARGIN = 0.05;
export const RISING_LOW_MARGIN = 0.1;
export const RISING_LOW_HOLD_MS = 150;
export const RISING_GRACE_MS = 600;
export const RISING_COST = 25;
export const RISING_COOLDOWN_MS = 4000;

export const WHIP_HOLD_MS = 400;
export const WHIP_COST = 20;
export const WHIP_COOLDOWN_MS = 1500;

/**
 * Grip-specific pose debouncing. gripScore multiplies four factors, so the
 * raw per-frame score is noisy (the live path smooths landmarks upstream in
 * FilteredSource; replayed fixtures are raw). The move layer therefore
 * averages the last GRIP_SMOOTH_FRAMES scores.
 *
 * Enter/exit levels are tuned on real hands (HaGRID 'like' vs the distractor
 * suite, see docs/hagrid-report.md): every 3-of-4-curl distractor saturates
 * at exactly 0.75, so entering just above that cliff (0.78) buys 0.96
 * precision at 0.61 recall. Fists remain a grip shape alias by construction
 * (a thumb-agnostic curl metric cannot tell them apart); the whip's safety
 * against fist confusion stays contextual: a 0.4s static raised hold
 * followed by a LATERAL swing, which no jab motion produces.
 */
export const GRIP_SMOOTH_FRAMES = 5;
export const GRIP_ENTER_SCORE = 0.78;
export const GRIP_EXIT_SCORE = 0.55;

export const BREATH_HIP_Y = 0.7; // wrists below this line count as "at hips"
export const BREATH_HOLD_MS = 1000;
export const BREATH_CHARGE_COST = 15;
export const EMPOWER_WINDOW_MS = 3000;
export const EMPOWER_MULTIPLIER = 1.6; // consumed by the combat layer

export const BREATH_MAX = 100;
export const BREATH_REGEN_PER_SEC = 12;
export const STREAM_COST_PER_SEC = 18;
export const FAN_COST_PER_SEC = 26;
/** A sustained move needs at least this many seconds of Breath to start. */
export const SUSTAIN_MIN_SEC = 0.25;

/**
 * After a two-hand thrust is recognized (fired OR refused by cooldown or
 * Breath), per-hand thrust detection is suppressed briefly so the same
 * physical motion cannot fall through and fire two jabs.
 */
export const THRUST_CONSUME_MS = 600;

/** Animation lockout per move: a trigger blocks all others for this long. */
export const LOCKOUT_MS: Readonly<Record<MoveName, number>> = {
  'jab-blast': 250,
  'fire-stream': 0, // sustained moves lock via their active state instead
  'cross-combo': 400,
  'palm-wave': 400,
  'flame-fan': 0,
  'twin-cannon': 800,
  'rising-flame': 600,
  'fire-whip': 500,
  'breath-charge': 500,
};

// ---------------------------------------------------------------------------
// Internal per-hand state
// ---------------------------------------------------------------------------

type PoseFamily = 'fist' | 'palm';

interface ThrustRecord {
  family: PoseFamily;
  /** Time the spike condition was first observed. */
  tSpike: number;
  /** Windowed velocity captured at the peak of the spike (the punch vector). */
  aimVel: Vec3;
  peakSpeed: number;
}

const ZERO_SPEED: HandSpeed = {
  speed: 0,
  velocity: { x: 0, y: 0, z: 0 },
  towardCamera: 0,
};

class HandState {
  window: HandFrame[] = [];
  readonly fistH = new Hysteresis();
  readonly palmH = new Hysteresis();
  readonly gripH = new Hysteresis(GRIP_ENTER_SCORE, 4, GRIP_EXIT_SCORE, 6);
  gripRecent: number[] = [];
  scores: PoseScores | null = null;
  present = false;
  wrist: Vec3 | null = null;
  /** Windowed wrist velocity, already velocity-scaled. */
  speed: HandSpeed = ZERO_SPEED;
  /**
   * Windowed relative hand-bbox-diagonal growth, 1/sec. Positive =
   * approaching the camera, negative = retracting. NOT velocity-scaled
   * (already relative). See bboxGrowthRate for why bbox, not palm span.
   */
  growth = 0;
  /**
   * Elbow-extension angular velocity for this hand's arm, rad/s, positive =
   * extending. Differenced on POSE SAMPLE timestamps (pose runs at half
   * frame rate); held between samples. Gated by pose freshness at use sites.
   */
  elbowVel = 0;
  /** Elbow angle at the last consumed pose sample, radians. */
  prevElbowAngle = 0;
  /** Timestamp (ms) of the last consumed pose sample; null before any. */
  lastPoseSampleT: number | null = null;
  thrust: ThrustRecord | null = null;
  suppressThrustUntil = -Infinity;
  gripStaticMs = 0;
  whipArmed = false;
  jabCooldownUntil = -Infinity;

  resetTracking(): void {
    this.window = [];
    this.fistH.reset();
    this.palmH.reset();
    this.gripH.reset();
    this.gripRecent = [];
    this.scores = null;
    this.present = false;
    this.wrist = null;
    this.speed = ZERO_SPEED;
    this.growth = 0;
    this.thrust = null;
    this.gripStaticMs = 0;
    this.whipArmed = false;
    // jabCooldownUntil survives tracking loss on purpose. Elbow tracking
    // (elbowVel / prevElbowAngle / lastPoseSampleT) also survives: it is
    // pose-driven and independent of hand-landmark presence.
  }
}

interface SustainState {
  move: MoveName;
  hand: Handedness;
  family: PoseFamily;
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
  /** When the physical trigger condition completed (<= current frame t). */
  completedAt: number;
  cost: number;
  /** Breath required to fire; defaults to cost. */
  minBreath?: number;
  cooldownMs: number;
  lockoutMs: number;
}

// ---------------------------------------------------------------------------
// MoveEngine
// ---------------------------------------------------------------------------

const DEFAULT_DT_SEC = 1 / 30;

export class MoveEngine {
  private readonly velocityScale: number;
  private readonly togetherThreshold: number;
  /** Motion thresholds derived once from the profile (see profile.ts). */
  private readonly th: MotionThresholds;

  private readonly left = new HandState();
  private readonly right = new HandState();

  /**
   * Near-miss diagnostics switch (the debug HUD flips this while open).
   * When false every record call is guarded off: zero allocation, zero cost.
   */
  debugEnabled = false;
  /** Preallocated ring of the last NEAR_MISS_CAPACITY near-miss records. */
  private readonly nearMissRing: NearMissRecord[] = [];
  private nearMissNext = 0;
  private nearMissCount = 0;

  private breathValue: number;
  private lockoutUntil = -Infinity;
  private readonly cooldowns = new Map<MoveName, number>();
  private sustain: SustainState | null = null;

  private combo: Array<{ hand: Handedness; t: number }> = [];
  private empowerUntil = -Infinity;

  /** Latest PoseFrame seen on a frame (null when the source carries none). */
  private latestPose: PoseFrame | null = null;
  /** True while the latest pose sample is within POSE_FRESH_MS of frame t. */
  private poseFresh = false;

  private chargeHoldMs = 0;
  private chargeFired = false;
  private twinHoldMs = 0;
  private twinArmedUntil = -Infinity;
  private risingLowMs = 0;
  private risingArmedUntil = -Infinity;

  private prevT: number | null = null;

  constructor(config: MoveEngineConfig = {}) {
    this.velocityScale = config.velocityScale ?? 1.0;
    this.togetherThreshold = config.handsTogetherThreshold ?? HANDS_TOGETHER_THRESHOLD;
    this.breathValue = config.initialBreath ?? BREATH_MAX;
    this.th = thresholdsFrom(config.profile ?? DEFAULT_PROFILE);
  }

  /** The derived motion thresholds in use (debug HUD display). */
  get thresholds(): MotionThresholds {
    return this.th;
  }

  /** Current Breath stamina, 0..BREATH_MAX. */
  get breath(): number {
    return this.breathValue;
  }

  /**
   * Spend Breath from outside the engine (player-hit penalties routed from
   * CombatSystem.onBreathPenalty). Added at P5 integration per the combat.ts
   * header note; clamps at 0 and ignores non-positive or non-finite amounts.
   */
  spend(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.breathValue = Math.max(0, this.breathValue - amount);
  }

  /** The sustained move currently active, if any. */
  get activeSustain(): MoveName | null {
    return this.sustain ? this.sustain.move : null;
  }

  /** Debug: latest pose classifier scores per hand (null = hand absent). */
  get currentPoseScores(): { left: PoseScores | null; right: PoseScores | null } {
    return { left: this.left.scores, right: this.right.scores };
  }

  /** Debug: per-hand motion state for the HUD (called at HUD rate only). */
  handMotionDebug(hand: Handedness): {
    present: boolean;
    speed: number;
    growth: number;
    thrustFamily: 'fist' | 'palm' | null;
    whipArmed: boolean;
  } {
    const s = this.handState(hand);
    return {
      present: s.present,
      speed: s.speed.speed,
      growth: s.growth,
      thrustFamily: s.thrust ? s.thrust.family : null,
      whipArmed: s.whipArmed,
    };
  }

  /**
   * Live fusion diagnostics per hand (debug HUD; called at HUD rate only,
   * so the per-call allocation is off the hot path).
   */
  get fusionState(): { left: FusionState; right: FusionState } {
    const of = (s: HandState): FusionState => ({
      elbowVel: s.elbowVel,
      elbowThreshold: this.th.elbowExtendVel,
      elbowFresh: this.poseFresh,
      wristSpeed: s.speed.speed,
      speedThreshold: this.th.spikeSpeed,
      bboxGrowth: s.growth,
      growthThreshold: this.th.spikeGrowth,
    });
    return { left: of(this.left), right: of(this.right) };
  }

  /** Debug: lockout expiry timestamp (frame time, ms). */
  get lockoutUntilT(): number {
    return this.lockoutUntil;
  }

  /** Debug: per-move cooldown expiry timestamps (frame time, ms). */
  get cooldownView(): ReadonlyMap<MoveName, number> {
    return this.cooldowns;
  }

  /** Debug: the frame time of the last processed frame (null before any). */
  get lastFrameT(): number | null {
    return this.prevT;
  }

  /**
   * Near-miss records, oldest first. Returns the live ring contents; entries
   * are reused in place, so callers must read, not retain.
   */
  nearMisses(out: NearMissRecord[] = []): NearMissRecord[] {
    out.length = 0;
    const n = this.nearMissCount;
    for (let i = 0; i < n; i++) {
      const idx = (this.nearMissNext - n + i + NEAR_MISS_CAPACITY) % NEAR_MISS_CAPACITY;
      const rec = this.nearMissRing[idx];
      if (rec) out.push(rec);
    }
    return out;
  }

  /** Record a near miss. ONLY call behind a debugEnabled guard. */
  private recordNearMiss(
    t: number,
    move: MoveName,
    condition: NearMissRecord['condition'],
    value: number,
    threshold: number,
    value2?: number,
    threshold2?: number,
  ): void {
    let rec = this.nearMissRing[this.nearMissNext];
    if (!rec) {
      rec = { t, move, condition, value, threshold };
      this.nearMissRing[this.nearMissNext] = rec;
    } else {
      rec.t = t;
      rec.move = move;
      rec.condition = condition;
      rec.value = value;
      rec.threshold = threshold;
    }
    rec.value2 = value2;
    rec.threshold2 = threshold2;
    this.nearMissNext = (this.nearMissNext + 1) % NEAR_MISS_CAPACITY;
    this.nearMissCount = Math.min(this.nearMissCount + 1, NEAR_MISS_CAPACITY);
  }

  /** Process one frame. Returns every MoveEvent emitted on this frame. */
  update(frame: LandmarkFrame): MoveEvent[] {
    const events: MoveEvent[] = [];
    const t = frame.t;
    const dtMs = this.prevT === null ? 0 : Math.max(0, t - this.prevT);
    this.prevT = t;
    const dtSec = dtMs / 1000;

    // Pose fusion state: freshness plus per-arm elbow angular velocity.
    // Absent pose (all replay fixtures, tracking dropouts) leaves poseFresh
    // false and the trigger logic on the documented two-secondary fallback.
    const pose = frame.pose ?? null;
    this.latestPose = pose;
    this.poseFresh = pose !== null && t - pose.t <= POSE_FRESH_MS;
    if (pose !== null) {
      this.updateElbow(this.left, pose, 'left');
      this.updateElbow(this.right, pose, 'right');
    }

    this.updateHand(this.left, frame.left, 'left', dtSec);
    this.updateHand(this.right, frame.right, 'right', dtSec);

    // Breath regenerates whenever no sustained move is active (Section 7).
    if (!this.sustain) {
      this.breathValue = Math.min(BREATH_MAX, this.breathValue + BREATH_REGEN_PER_SEC * dtSec);
    }

    this.updateArmTimers(t, dtMs);

    if (this.sustain) {
      // An active sustained move locks out every other trigger.
      this.updateSustain(events, t, dtSec);
      return events;
    }

    // Priority order (Section 7): two-hand > grip > palm/fist thrust family.
    this.evalBreathCharge(events, t);
    this.evalTwinCannon(events, t);
    this.evalRisingFlame(events, t);
    this.evalWhip(events, t, 'left');
    this.evalWhip(events, t, 'right');
    this.evalThrustFamily(events, t, 'left');
    this.evalThrustFamily(events, t, 'right');

    return events;
  }

  // -------------------------------------------------------------------------
  // Per-hand tracking
  // -------------------------------------------------------------------------

  /**
   * Advance one hand's elbow-extension tracking from a PoseFrame. Runs only
   * on RAW pose SAMPLES: held frames (same sample timestamp) and
   * INTERPOLATED frames (pose.interpolated, from the worker-path per-frame
   * lerp) are skipped, so the angular velocity is always differenced on real
   * detection timestamps, never on frame dt or synthetic in-between poses.
   * frame.left pairs with the pose LEFT arm. Allocation-free: reads joints
   * in place, stores scalars.
   */
  private updateElbow(s: HandState, pose: PoseFrame, hand: Handedness): void {
    if (pose.interpolated === true) return; // lerped frame: not a sample
    if (s.lastPoseSampleT === pose.t) return; // held sample: nothing new
    // poseWorld (metric, hip-centered) when available, else screen joints.
    const source = pose.world ?? pose;
    const arm = hand === 'left' ? source.left : source.right;
    const angle = elbowAngle(arm.shoulder, arm.elbow, arm.wrist);
    if (
      s.lastPoseSampleT !== null &&
      pose.t - s.lastPoseSampleT <= ELBOW_RESET_GAP_MS
    ) {
      const dtSec = (pose.t - s.lastPoseSampleT) / 1000;
      s.elbowVel = elbowAngularVelocity(s.prevElbowAngle, angle, dtSec);
    } else {
      // First sample ever, or a gap: re-baseline instead of inventing a
      // velocity across the hole.
      s.elbowVel = 0;
    }
    s.prevElbowAngle = angle;
    s.lastPoseSampleT = pose.t;
  }

  private updateHand(
    s: HandState,
    raw: HandFrame | null,
    handedness: Handedness,
    dtSec: number
  ): void {
    const present =
      raw !== null && raw.confidence >= CONFIDENCE_FLOOR && raw.landmarks.length >= 21;
    if (!present || raw === null) {
      s.resetTracking();
      return;
    }

    s.present = true;
    s.window.push(raw);
    if (s.window.length > AIM_WINDOW_FRAMES) s.window.shift();
    s.wrist = lm(raw, LM.WRIST);

    const dt = dtSec > 0 ? dtSec : DEFAULT_DT_SEC;
    const spRaw = handSpeed(s.window, dt);
    const vs = this.velocityScale;
    s.speed = {
      speed: spRaw.speed * vs,
      velocity: scale(spRaw.velocity, vs),
      towardCamera: spRaw.towardCamera * vs,
    };

    // Windowed relative bbox-diagonal growth: the toward-camera signal
    // (positive = approaching) and, negated, the retract signal. Not
    // velocity-scaled: relative growth is already distance-invariant. The
    // full-hand bbox replaces palm span, which collapsed under a clenched
    // fist (see gestures/motion.ts).
    s.growth = bboxGrowthRate(s.window, dt);

    const fist = fistScore(raw);
    const palm = palmScore(raw, handedness);
    const grip = gripScore(raw);
    // Grip runs on a short moving average; see GRIP_SMOOTH_FRAMES above.
    s.gripRecent.push(grip);
    if (s.gripRecent.length > GRIP_SMOOTH_FRAMES) s.gripRecent.shift();
    let gripSum = 0;
    for (const g of s.gripRecent) gripSum += g;
    const gripSmoothed = gripSum / s.gripRecent.length;
    s.scores = {
      fist,
      palm,
      grip: gripSmoothed,
      fistActive: s.fistH.update(fist),
      palmActive: s.palmH.update(palm),
      gripActive: s.gripH.update(gripSmoothed),
    };
  }

  // -------------------------------------------------------------------------
  // Arming timers (holds that precede triggers)
  // -------------------------------------------------------------------------

  /**
   * The wrist-y line above which (numerically: below on screen) a wrist
   * counts as "at the hips" / "low". Pose fresh: the real hip line minus a
   * small margin (see BREATH_HIP_MARGIN / RISING_LOW_MARGIN); pose absent:
   * the absolute legacy constant.
   */
  private lowBandY(kind: 'breath' | 'rising'): number {
    const pose = this.latestPose;
    if (this.poseFresh && pose !== null) {
      const hipCenterY = (pose.left.hip.y + pose.right.hip.y) / 2;
      return hipCenterY - (kind === 'breath' ? BREATH_HIP_MARGIN : RISING_LOW_MARGIN);
    }
    return kind === 'breath' ? BREATH_HIP_Y : RISING_LOW_Y;
  }

  private updateArmTimers(t: number, dtMs: number): void {
    const L = this.left;
    const R = this.right;
    const both = L.present && R.present && L.wrist !== null && R.wrist !== null;

    // Breath Charge: both fists parked at the hips, roughly static. The hip
    // band is pose-relative when pose is fresh (see lowBandY).
    const breathY = this.lowBandY('breath');
    const hipCond =
      both &&
      L.fistH.isActive &&
      R.fistH.isActive &&
      (L.wrist as Vec3).y > breathY &&
      (R.wrist as Vec3).y > breathY &&
      L.speed.speed < this.th.breathStaticMax &&
      R.speed.speed < this.th.breathStaticMax;
    if (hipCond) {
      this.chargeHoldMs += dtMs;
    } else {
      this.chargeHoldMs = 0;
      this.chargeFired = false;
    }

    // Twin Cannon: both fists together at chest height.
    const chest =
      both &&
      inBand((L.wrist as Vec3).y, TWIN_CHEST_Y_MIN, TWIN_CHEST_Y_MAX) &&
      inBand((R.wrist as Vec3).y, TWIN_CHEST_Y_MIN, TWIN_CHEST_Y_MAX);
    const together =
      both && dist(L.wrist as Vec3, R.wrist as Vec3) < this.togetherThreshold;
    if (chest && together && L.fistH.isActive && R.fistH.isActive) {
      this.twinHoldMs += dtMs;
      if (this.twinHoldMs >= TWIN_HOLD_MS) this.twinArmedUntil = t + TWIN_GRACE_MS;
    } else {
      this.twinHoldMs = 0;
    }

    // Rising Flame: both palms low (pose-relative band when pose is fresh).
    const risingY = this.lowBandY('rising');
    const low =
      both &&
      L.palmH.isActive &&
      R.palmH.isActive &&
      (L.wrist as Vec3).y > risingY &&
      (R.wrist as Vec3).y > risingY;
    if (low) {
      this.risingLowMs += dtMs;
      if (this.risingLowMs >= RISING_LOW_HOLD_MS) this.risingArmedUntil = t + RISING_GRACE_MS;
    } else {
      this.risingLowMs = 0;
    }

    // Fire Whip: hand held roughly static in the grip family. The static
    // hold accumulates while the fist OR grip pose is active because the
    // grip classifier can debounce in mid-hold (fist and grip share their
    // curl geometry); the swing itself still demands an active grip.
    for (const s of [L, R]) {
      const held = s.present && (s.gripH.isActive || s.fistH.isActive);
      if (held) {
        if (s.speed.speed < this.th.whipStaticMax) {
          s.gripStaticMs += dtMs;
          if (s.gripStaticMs >= WHIP_HOLD_MS) s.whipArmed = true;
        } else {
          s.gripStaticMs = 0;
        }
      } else {
        s.gripStaticMs = 0;
        s.whipArmed = false;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Two-hand triggers
  // -------------------------------------------------------------------------

  private evalBreathCharge(events: MoveEvent[], t: number): void {
    if (this.chargeHoldMs < BREATH_HOLD_MS || this.chargeFired) return;
    this.chargeFired = true; // one charge per continuous hold
    const emitted = this.emit(events, t, {
      move: 'breath-charge',
      hand: 'both',
      kind: 'trigger',
      aim: AIM_FORWARD,
      origin: this.midOrigin(),
      completedAt: t - (this.chargeHoldMs - BREATH_HOLD_MS),
      cost: BREATH_CHARGE_COST,
      cooldownMs: 0,
      lockoutMs: LOCKOUT_MS['breath-charge'],
    });
    if (emitted) this.empowerUntil = t + EMPOWER_WINDOW_MS;
  }

  private evalTwinCannon(events: MoveEvent[], t: number): void {
    const armed = this.twinHoldMs >= TWIN_HOLD_MS || t <= this.twinArmedUntil;
    if (!armed) return;
    const L = this.left;
    const R = this.right;
    const jointThrust =
      L.present &&
      R.present &&
      this.isSpike(L) &&
      this.isSpike(R);
    if (!jointThrust) return;

    // The joint thrust belongs to Twin Cannon whether or not it fires; never
    // let the same motion fall through and fire two jabs.
    this.consumeThrust(L, t);
    this.consumeThrust(R, t);
    this.twinHoldMs = 0;
    this.twinArmedUntil = -Infinity;

    const aimVel = scale(add(L.speed.velocity, R.speed.velocity), 0.5);
    this.emit(events, t, {
      move: 'twin-cannon',
      hand: 'both',
      kind: 'trigger',
      aim: this.aimOf(aimVel),
      origin: this.midOrigin(),
      completedAt: t,
      cost: TWIN_COST,
      cooldownMs: TWIN_COOLDOWN_MS,
      lockoutMs: LOCKOUT_MS['twin-cannon'],
    });
  }

  private evalRisingFlame(events: MoveEvent[], t: number): void {
    const armed = this.risingLowMs >= RISING_LOW_HOLD_MS || t <= this.risingArmedUntil;
    if (!armed) return;
    const L = this.left;
    const R = this.right;
    const bothPalms =
      L.present && R.present && L.palmH.isActive && R.palmH.isActive;
    const sweep =
      bothPalms &&
      L.speed.velocity.y <= -this.th.risingUpVel &&
      R.speed.velocity.y <= -this.th.risingUpVel;
    if (!sweep) {
      if (this.debugEnabled && bothPalms) {
        // The limiting hand's upward velocity (screen y grows down).
        const upVel = Math.min(-L.speed.velocity.y, -R.speed.velocity.y);
        if (upVel >= NEAR_MISS_FRACTION * this.th.risingUpVel) {
          this.recordNearMiss(t, 'rising-flame', 'upVel', upVel, this.th.risingUpVel);
        }
      }
      return;
    }

    this.risingLowMs = 0;
    this.risingArmedUntil = -Infinity;

    const aimVel = scale(add(L.speed.velocity, R.speed.velocity), 0.5);
    this.emit(events, t, {
      move: 'rising-flame',
      hand: 'both',
      kind: 'trigger',
      aim: this.aimOf(aimVel),
      origin: this.midOrigin(),
      completedAt: t,
      cost: RISING_COST,
      cooldownMs: RISING_COOLDOWN_MS,
      lockoutMs: LOCKOUT_MS['rising-flame'],
    });
  }

  // -------------------------------------------------------------------------
  // Grip family
  // -------------------------------------------------------------------------

  private evalWhip(events: MoveEvent[], t: number, hand: Handedness): void {
    const s = this.handState(hand);
    if (!s.present || !s.gripH.isActive || !s.whipArmed || s.wrist === null) return;
    const vx = Math.abs(s.speed.velocity.x);
    if (vx < this.th.whipSwingVx) {
      if (this.debugEnabled && vx >= NEAR_MISS_FRACTION * this.th.whipSwingVx) {
        this.recordNearMiss(t, 'fire-whip', 'swingVx', vx, this.th.whipSwingVx);
      }
      return;
    }

    // The swing consumes the arm whether or not the move fires, and claims
    // the hand's motion so the thrust family cannot reinterpret it.
    s.whipArmed = false;
    s.gripStaticMs = 0;
    this.consumeThrust(s, t);

    this.emit(events, t, {
      move: 'fire-whip',
      hand,
      kind: 'trigger',
      aim: this.aimOf(s.speed.velocity),
      origin: s.wrist,
      completedAt: t,
      cost: WHIP_COST,
      cooldownMs: WHIP_COOLDOWN_MS,
      lockoutMs: LOCKOUT_MS['fire-whip'],
    });
  }

  // -------------------------------------------------------------------------
  // Thrust family (fist: jab / stream / combo; palm: wave / fan)
  // -------------------------------------------------------------------------

  private evalThrustFamily(events: MoveEvent[], t: number, hand: Handedness): void {
    const s = this.handState(hand);
    if (!s.present || s.scores === null || s.wrist === null) return;

    // Grip priority note: the whip (evaluated earlier) claims lateral swings
    // and consumes the hand's thrust. The synthetic fist and grip poses are
    // geometrically close, so an active grip must NOT veto the fist family
    // here; the two are separated by their motion signatures instead (a
    // thrust spike is toward the camera, a whip swing is lateral).

    // Register or refresh a thrust spike.
    if (t >= s.suppressThrustUntil && this.isSpike(s)) {
      const family = this.thrustFamily(s);
      if (family !== null) {
        if (s.thrust === null || s.thrust.family !== family) {
          s.thrust = {
            family,
            tSpike: t,
            aimVel: s.speed.velocity,
            peakSpeed: s.speed.speed,
          };
        } else if (s.speed.speed > s.thrust.peakSpeed) {
          // Track the peak of the spike: that is the punch vector.
          s.thrust.peakSpeed = s.speed.speed;
          s.thrust.aimVel = s.speed.velocity;
        }
      }
    } else if (this.debugEnabled && t >= s.suppressThrustUntil && s.thrust === null) {
      // Near-miss tracing: a would-be thrust that failed its final physical
      // condition while at least NEAR_MISS_FRACTION of the way there. The
      // record names the SPECIFIC failing fusion signal.
      const family = this.thrustFamily(s);
      if (family !== null) {
        const move: MoveName = family === 'fist' ? 'jab-blast' : 'palm-wave';
        const sp = s.speed.speed;
        if (this.poseFresh) {
          if (s.elbowVel < this.th.elbowExtendVel) {
            // The PRIMARY (elbow extension) is what refused the spike.
            if (s.elbowVel >= NEAR_MISS_FRACTION * this.th.elbowExtendVel) {
              this.recordNearMiss(t, move, 'elbowVel', s.elbowVel, this.th.elbowExtendVel);
            }
          } else {
            // Primary passed; no secondary crossed. Report both pairs.
            const frac = Math.max(
              sp / this.th.spikeSpeed,
              s.growth / this.th.spikeGrowth,
            );
            if (frac >= NEAR_MISS_FRACTION) {
              this.recordNearMiss(
                t,
                move,
                'secondary',
                sp,
                this.th.spikeSpeed,
                s.growth,
                this.th.spikeGrowth,
              );
            }
          }
        } else if (sp < this.th.spikeSpeed) {
          if (sp >= NEAR_MISS_FRACTION * this.th.spikeSpeed) {
            this.recordNearMiss(t, move, 'speed', sp, this.th.spikeSpeed);
          }
        } else if (s.growth >= NEAR_MISS_FRACTION * this.th.spikeGrowth) {
          // Speed passed; the growth gate is what refused the spike.
          this.recordNearMiss(t, move, 'growth', s.growth, this.th.spikeGrowth);
        }
      }
    }

    const th = s.thrust;
    if (th === null) return;

    // The pose must survive until the thrust resolves.
    const poseStill = th.family === 'fist' ? s.fistH.isActive : s.palmH.isActive;
    if (!poseStill) {
      s.thrust = null;
      return;
    }

    // Retract within the hold window resolves to the discrete move. The
    // retract signal is windowed bbox SHRINK (the on-screen hand getting
    // smaller as it pulls back), not +z velocity; when pose is fresh a fast
    // elbow RE-FLEX (the arm folding back) also counts as retract.
    if (this.isRetract(s)) {
      s.thrust = null;
      if (th.family === 'fist') this.emitJab(events, t, hand, s, th);
      else this.emitPalmWave(events, t, hand, s, th);
      return;
    }

    // Held extended past the window resolves to the sustained move.
    if (t - th.tSpike >= EXTEND_HOLD_MS) {
      s.thrust = null;
      const move: MoveName = th.family === 'fist' ? 'fire-stream' : 'flame-fan';
      const costPerSec = th.family === 'fist' ? STREAM_COST_PER_SEC : FAN_COST_PER_SEC;
      const aim = this.thrustAim(hand, th.aimVel);
      const emitted = this.emit(events, t, {
        move,
        hand,
        kind: 'sustain-start',
        aim,
        origin: s.wrist,
        completedAt: th.tSpike + EXTEND_HOLD_MS,
        cost: 0,
        minBreath: costPerSec * SUSTAIN_MIN_SEC,
        cooldownMs: 0,
        lockoutMs: 0,
      });
      if (emitted) {
        this.sustain = {
          move,
          hand,
          family: th.family,
          costPerSec,
          aim,
          lastOrigin: s.wrist,
        };
      }
    }
  }

  private emitJab(
    events: MoveEvent[],
    t: number,
    hand: Handedness,
    s: HandState,
    th: ThrustRecord
  ): void {
    if (t < s.jabCooldownUntil) return; // per-hand cooldown, thrust already consumed

    // Cross Combo: three alternating-hand jabs inside the rolling window.
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
      aim: this.thrustAim(hand, th.aimVel),
      origin: s.wrist as Vec3,
      completedAt: t,
      cost: 0,
      cooldownMs: 0,
      lockoutMs: LOCKOUT_MS[move],
    });
    if (emitted) {
      s.jabCooldownUntil = t + JAB_COOLDOWN_MS;
      if (isCombo) this.combo = []; // third hit resets the combo window
      else this.combo.push({ hand, t });
    }
  }

  private emitPalmWave(
    events: MoveEvent[],
    t: number,
    hand: Handedness,
    s: HandState,
    th: ThrustRecord
  ): void {
    this.emit(events, t, {
      move: 'palm-wave',
      hand,
      kind: 'trigger',
      aim: this.thrustAim(hand, th.aimVel),
      origin: s.wrist as Vec3,
      completedAt: t,
      cost: 0,
      cooldownMs: PALM_WAVE_COOLDOWN_MS,
      lockoutMs: LOCKOUT_MS['palm-wave'],
    });
  }

  // -------------------------------------------------------------------------
  // Sustained move lifecycle
  // -------------------------------------------------------------------------

  private updateSustain(events: MoveEvent[], t: number, dtSec: number): void {
    const su = this.sustain;
    if (su === null) return;
    const s = this.handState(su.hand);

    this.breathValue -= su.costPerSec * dtSec;
    if (s.wrist !== null) su.lastOrigin = s.wrist;

    const poseActive =
      s.present && (su.family === 'fist' ? s.fistH.isActive : s.palmH.isActive);
    // Windowed bbox shrink (or, pose fresh, a fast elbow re-flex): robust
    // against noise over a long hold (the retract threshold sits well above
    // the measured hold-noise floor); a real retract crosses it within ~2
    // frames.
    const retracting = s.present && this.isRetract(s);
    const ended = this.breathValue <= 0 || !poseActive || retracting;

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

    // Steering: the tick aim follows the hand velocity when it moves with
    // intent, otherwise it keeps pointing where it last pointed.
    if (s.speed.speed >= this.th.aimMinSpeed) su.aim = normalize(s.speed.velocity);
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
  // Emission core (lockout, cooldown, Breath, empowerment)
  // -------------------------------------------------------------------------

  private emit(events: MoveEvent[], t: number, req: EmitRequest): boolean {
    if (t < this.lockoutUntil) return false;
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
    return true;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private handState(hand: Handedness): HandState {
    return hand === 'left' ? this.left : this.right;
  }

  /**
   * Thrust spike, three-signal fusion (see the PUNCH FUSION header note):
   * - Pose FRESH: the primary (elbow extension angular velocity) must cross
   *   AND at least one secondary (wrist speed, bbox growth) must cross.
   * - Pose absent/stale: BOTH secondaries must cross; this is the documented
   *   fallback, identical to the pre-fusion rule, and is what every replay
   *   fixture and tracking dropout runs on.
   * Z_TOWARD_SECONDARY optionally OR-s in the old z-velocity check as a weak
   * extra secondary; it is never required.
   */
  private isSpike(s: HandState): boolean {
    const speedOk = s.speed.speed >= this.th.spikeSpeed;
    const growthOk = s.growth >= this.th.spikeGrowth;
    const zOk = Z_TOWARD_SECONDARY && s.speed.towardCamera >= Z_TOWARD_SECONDARY_MIN;
    if (this.poseFresh) {
      if (s.elbowVel < this.th.elbowExtendVel) return false;
      return speedOk || growthOk || zOk;
    }
    return speedOk && (growthOk || zOk);
  }

  /**
   * Retract: windowed bbox shrink (the on-screen hand getting smaller as it
   * pulls back), or, when pose is fresh, the elbow re-flexing fast
   * (angular velocity at or below the negated extension threshold).
   */
  private isRetract(s: HandState): boolean {
    if (s.growth <= -this.th.retractShrink) return true;
    return this.poseFresh && s.elbowVel <= -this.th.elbowExtendVel;
  }

  /** Normalized aim from a velocity, with the forward fallback (see header). */
  private aimOf(velocity: Vec3): Vec3 {
    const n = normalize(velocity);
    const speed = Math.sqrt(
      velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z
    );
    if (speed < this.th.aimMinSpeed || (n.x === 0 && n.y === 0 && n.z === 0)) {
      return AIM_FORWARD;
    }
    return n;
  }

  /**
   * Thrust-family aim (jab / cross / palm-wave / stream / fan): when pose is
   * fresh, blend the forearm direction (elbow -> wrist, screen space, z
   * borrowed from the velocity aim since 2D pose says nothing about depth)
   * with the velocity aim at AIM_FOREARM_WEIGHT / AIM_VELOCITY_WEIGHT
   * (tunable, see the constants). Pose absent: pure velocity aim, exactly
   * as before. Twin / rising / whip keep the velocity aim regardless.
   */
  private thrustAim(hand: Handedness, aimVel: Vec3): Vec3 {
    const velAim = this.aimOf(aimVel);
    const pose = this.latestPose;
    if (!this.poseFresh || pose === null) return velAim;
    const arm = hand === 'left' ? pose.left : pose.right;
    const dx = arm.wrist.x - arm.elbow.x;
    const dy = arm.wrist.y - arm.elbow.y;
    const planarLen = Math.sqrt(dx * dx + dy * dy);
    if (planarLen < 1e-6) return velAim;
    // Unit forearm vector whose z matches the velocity aim's z; the xy part
    // is scaled so the whole vector stays unit length.
    const planarScale = Math.sqrt(Math.max(0, 1 - velAim.z * velAim.z));
    const blended = normalize({
      x: AIM_FOREARM_WEIGHT * ((dx / planarLen) * planarScale) + AIM_VELOCITY_WEIGHT * velAim.x,
      y: AIM_FOREARM_WEIGHT * ((dy / planarLen) * planarScale) + AIM_VELOCITY_WEIGHT * velAim.y,
      // Both terms borrow the velocity aim's z, so the blend keeps it as is.
      z: velAim.z,
    });
    if (blended.x === 0 && blended.y === 0 && blended.z === 0) return velAim;
    return blended;
  }

  private thrustFamily(s: HandState): PoseFamily | null {
    const fistA = s.fistH.isActive;
    const palmA = s.palmH.isActive;
    if (fistA && palmA) {
      // Both linger during transitions; the instantaneous score decides,
      // with the Section 7 tie priority palm > fist.
      const sc = s.scores;
      return sc !== null && sc.palm >= sc.fist ? 'palm' : 'fist';
    }
    if (palmA) return 'palm';
    if (fistA) return 'fist';
    return null;
  }

  private consumeThrust(s: HandState, t: number): void {
    s.thrust = null;
    s.suppressThrustUntil = t + THRUST_CONSUME_MS;
  }

  private midOrigin(): Vec3 {
    const lw = this.left.wrist;
    const rw = this.right.wrist;
    if (lw !== null && rw !== null) return scale(add(lw, rw), 0.5);
    return lw ?? rw ?? { x: 0.5, y: 0.5, z: 0 };
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

function inBand(v: number, min: number, max: number): boolean {
  return v >= min && v <= max;
}
