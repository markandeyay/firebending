/**
 * The 7-move state machine (spec Section 7, simplified per the 2026-07-31
 * drill-data review). Consumes LandmarkFrame objects one per frame via
 * MoveEngine.update() and emits MoveEvent objects. Everything is
 * deterministic and frame-driven: all timing derives from LandmarkFrame.t,
 * never from wall clocks.
 *
 * MOVESET SIMPLIFICATION (major deviation, Round 3 Phase 1b): palm is NO
 * LONGER a classified pose on the critical path. The palm-vs-fist hysteresis
 * split multiplied every thrust into two moves (jab/palm-wave, stream/fan)
 * whose only difference was finger curl, which the player's own recorded
 * drills could not reliably separate mid-thrust. Thrust detection is now
 * POSE-AGNOSTIC: the elbow-extension + wrist-speed/bbox-growth fusion alone
 * decides, finger curl is irrelevant. palm-wave and flame-fan are gone; a
 * palm strike reads as jab-blast and a held palm push reads as fire-stream.
 * The seven moves differ by ARM COUNT, MOTION TYPE (thrust vs upward sweep
 * vs lateral swing vs static hold), HOLD DURATION, and WRIST POSITION vs the
 * body's hip/shoulder lines (pose-fresh) or the absolute fallback bands.
 * gripScore keeps its finger-pose read for fire-whip (HaGRID 0.96
 * precision); fistScore is still read for the breath-charge chamber (an
 * idle player's relaxed hands also hang at the hip line, so the deliberate
 * fist chamber is what separates the move from standing idle: the idle-rest
 * negative fixture holds exactly that pose) and to assist the whip hold.
 * palmScore/palmScore2D stay exported for the studio and HaGRID suites; no
 * move reads them.
 *
 * AIM SEMANTICS (combat layer contract):
 *   MoveEvent.aim is the normalized SCREEN-SPACE hand velocity at the moment
 *   the move triggered (filtered over the last AIM_WINDOW_FRAMES frames).
 *   When body pose is FRESH, thrust-family aims (jab / cross / stream)
 *   blend the forearm direction into the velocity aim (see
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
 * PRIORITY (Section 7): two-hand moves > grip moves > thrusts, evaluated
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
  /**
   * OPTIONAL: the captureTs of the LandmarkFrame that triggered this event
   * (performance.now()-domain capture time of the source video frame; see
   * types.ts). Live frames carry it; fixtures and recordings never do, and
   * every consumer must treat its absence as fully supported. Used for
   * photon-to-fire latency instrumentation.
   */
  captureTs?: number;
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
  /**
   * EXACT motion thresholds, bypassing profile derivation entirely. Used by
   * the analyze tool (tools/analyze.ts) to replay a recorded take under the
   * very thresholds that were active when it was captured (the studio
   * exports them per take). Takes precedence over `profile` when present.
   */
  thresholds?: MotionThresholds;
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

/**
 * Debug view of one hand's pose classifier state. Palm is gone from the
 * critical path (7-move simplification); only fist (breath-charge chamber,
 * whip-hold assist) and grip (fire-whip) are classified here.
 */
export interface PoseScores {
  fist: number;
  grip: number;
  fistActive: boolean;
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

// VANISHED-HAND ELBOW-ONLY THRUSTS (2026-07-31 drill review). The user's
// recorded drills (fixtures/recorded/firebending-drill-2026-07-31.json)
// show the hand tracker LOSING the hand during fast motion: both hands are
// null through all 11 jab AUTO-PEAK windows, so the wrist-speed/bbox-growth
// secondaries read zero exactly when a thrust happens. The disappearance
// itself is the fast-motion signature. Rule: when body pose is FRESH and a
// side's hand WAS tracked within HAND_VANISH_WINDOW_MS but is currently
// absent, a sufficiently violent elbow extension registers a thrust on the
// elbow PRIMARY alone, aimed along the forearm with the pose wrist as the
// origin. Resolution uses the signals that survive a vanished hand: elbow
// RE-FLEX resolves to the discrete jab, the elbow staying extended past
// EXTEND_HOLD_MS resolves to Fire Stream.

/**
 * How recently the vanished hand must have been tracked. In the drill data,
 * 105 vanish episodes measured with this window keep each episode tied to
 * the motion that destroyed tracking; jab-take elbow peaks arriving later
 * than this after hand loss (e.g. jab-right rep 1: last track ~6100 ms,
 * elbow peak 6452..6669 ms) are indistinguishable from between-rep arm
 * motion and stay excluded on purpose.
 */
export const HAND_VANISH_WINDOW_MS = 300;

/**
 * Elbow-extension angular velocity floor for the vanished-hand path,
 * DERIVED FROM THE DRILL DATA as the max-margin separator over all 105
 * vanish episodes (hand absent, tracked within HAND_VANISH_WINDOW_MS):
 * non-thrust episodes peak at 3.93 rad/s (the fire-whip-left arm re-raise,
 * the loudest arm motion that must NOT fire), the quietest separable
 * thrust measures 4.66 rad/s (the fire-stream take's second thrust);
 * midpoint 4.29, margin 0.37. The user's jab/twin vanish-context elbow
 * peaks (max 2.74 rad/s at ~14 fps pose sampling) sit BELOW the whip
 * noise, so NO value fires them without cross-firing on arm raises: this
 * path deliberately recovers only unambiguous elbow spikes. Applied as
 * max(elbowExtendVel, ELBOW_VANISH_VEL) so a calibrated profile can only
 * raise it further.
 */
export const ELBOW_VANISH_VEL = 4.29;
/** Fallback aim: straight at the enemy (screen -z is toward the camera). */
export const AIM_FORWARD: Vec3 = { x: 0, y: 0, z: -1 };

/** Near-miss diagnostics: record a failed condition at or above this fraction
 *  of its threshold. */
export const NEAR_MISS_FRACTION = 0.5;
/** Near-miss ring buffer capacity. */
export const NEAR_MISS_CAPACITY = 8;

export const JAB_COOLDOWN_MS = 250; // per hand, Section 7 table
export const COMBO_WINDOW_MS = 1500;

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

/**
 * Breath-charge chamber fist hysteresis, DERIVED FROM THE USER'S RECORDED
 * DATA (fixtures/recorded/firebending-drill-2026-07-31.json, breath-charge
 * take, 196 chamber-hold fist scores across the 3 recorded cycles): the
 * sustained chamber level is p5 0.632 / median 0.711 / min 0.572 with
 * frame-to-frame jitter p90 0.022. The standard 0.75 enter level sat ABOVE
 * the user's entire sustained hold distribution, so the chamber never
 * debounced and 5 of 6 detected rep windows missed. Enter is set to the
 * recorded p5 (0.63); exit keeps the standard 0.55, which is below the
 * recorded minimum (0.572), so an entered chamber survives the hold. The
 * synthetic negative fixtures score fist 0.00..0.04 at rest, so the lowered
 * enter costs the false-positive suite nothing. NOTE: on real hands a
 * RELAXED idle hand also saturates fistScore (recorded noise pool: fist
 * 1.00), so the fist gate does not separate a chamber from real idle; that
 * separation comes from the hip band + stillness + the 1.0 s hold. The gate
 * is kept because it still rejects open-handed and synthetic-rest cases.
 */
export const BREATH_FIST_ENTER = 0.63;
export const BREATH_FIST_EXIT = 0.55;

export const BREATH_HOLD_MS = 1000;
export const BREATH_CHARGE_COST = 15;
export const EMPOWER_WINDOW_MS = 3000;
export const EMPOWER_MULTIPLIER = 1.6; // consumed by the combat layer

export const BREATH_MAX = 100;
export const BREATH_REGEN_PER_SEC = 12;
export const STREAM_COST_PER_SEC = 18;
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
  'twin-cannon': 800,
  'rising-flame': 600,
  'fire-whip': 500,
  'breath-charge': 500,
};

// ---------------------------------------------------------------------------
// Internal per-hand state
// ---------------------------------------------------------------------------

interface ThrustRecord {
  /** Time the spike condition was first observed. */
  tSpike: number;
  /**
   * The punch vector. Hand-tracked thrusts: the windowed velocity captured
   * at the peak of the spike (fed through thrustAim at emission).
   * Elbow-only thrusts: the FINAL forearm aim itself, captured at the peak
   * elbow extension (used verbatim at emission).
   */
  aimVel: Vec3;
  /** Peak signal of the spike: wrist speed (hand path) or rad/s (elbow path). */
  peakSpeed: number;
  /** True for a vanished-hand elbow-only thrust (see HAND_VANISH_WINDOW_MS). */
  elbowOnly: boolean;
}

const ZERO_SPEED: HandSpeed = {
  speed: 0,
  velocity: { x: 0, y: 0, z: 0 },
  towardCamera: 0,
};

class HandState {
  window: HandFrame[] = [];
  readonly fistH = new Hysteresis();
  /** Breath-chamber fist hysteresis at the data-derived enter level. */
  readonly chamberH = new Hysteresis(BREATH_FIST_ENTER, 4, BREATH_FIST_EXIT, 6);
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
  /** Frame time when this hand was last tracked; survives tracking loss. */
  lastPresentT = -Infinity;

  resetTracking(): void {
    this.window = [];
    this.fistH.reset();
    this.chamberH.reset();
    this.gripH.reset();
    this.gripRecent = [];
    this.scores = null;
    this.present = false;
    this.wrist = null;
    this.speed = ZERO_SPEED;
    this.growth = 0;
    // A hand-tracked thrust dies with its hand; an ELBOW-ONLY thrust is
    // pose-driven and must survive the very tracking loss that defines it.
    if (this.thrust !== null && !this.thrust.elbowOnly) this.thrust = null;
    this.gripStaticMs = 0;
    this.whipArmed = false;
    // jabCooldownUntil and lastPresentT survive tracking loss on purpose.
    // Elbow tracking (elbowVel / prevElbowAngle / lastPoseSampleT) also
    // survives: it is pose-driven and independent of hand-landmark presence.
  }
}

interface SustainState {
  move: MoveName;
  hand: Handedness;
  costPerSec: number;
  aim: Vec3;
  lastOrigin: Vec3;
  /** Started by a vanished-hand elbow-only thrust: pose-driven lifecycle. */
  elbowOnly: boolean;
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
  /**
   * Optional sink receiving EVERY near-miss record the instant it is
   * written, before the ring can overwrite it (the analyze tool captures
   * per-rep maxima; the 8-slot ring only serves the debug HUD). Called only
   * while debugEnabled. The record object is REUSED in place: listeners
   * must copy fields they keep.
   */
  nearMissListener: ((rec: Readonly<NearMissRecord>) => void) | null = null;
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
  /**
   * Rising Flame arming is suppressed until this time after a Breath Charge
   * fires: with the palm gate gone, the charge RELEASE (both fists rising
   * from the hips) is geometrically a rising sweep, so the fired charge
   * claims the posture, exactly like consumeThrust claims a hand's motion.
   */
  private risingSuppressUntil = -Infinity;

  private prevT: number | null = null;

  constructor(config: MoveEngineConfig = {}) {
    this.velocityScale = config.velocityScale ?? 1.0;
    this.togetherThreshold = config.handsTogetherThreshold ?? HANDS_TOGETHER_THRESHOLD;
    this.breathValue = config.initialBreath ?? BREATH_MAX;
    this.th = config.thresholds ?? thresholdsFrom(config.profile ?? DEFAULT_PROFILE);
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
    /** True while a thrust spike is registered and awaiting resolution. */
    thrustArmed: boolean;
    whipArmed: boolean;
  } {
    const s = this.handState(hand);
    return {
      present: s.present,
      speed: s.speed.speed,
      growth: s.growth,
      thrustArmed: s.thrust !== null,
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
    if (this.nearMissListener !== null) this.nearMissListener(rec);
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

    this.updateHand(this.left, frame.left, t, dtSec);
    this.updateHand(this.right, frame.right, t, dtSec);

    // Breath regenerates whenever no sustained move is active (Section 7).
    if (!this.sustain) {
      this.breathValue = Math.min(BREATH_MAX, this.breathValue + BREATH_REGEN_PER_SEC * dtSec);
    }

    this.updateArmTimers(t, dtMs);

    if (this.sustain) {
      // An active sustained move locks out every other trigger.
      this.updateSustain(events, t, dtSec);
      return this.stampCapture(events, frame);
    }

    // Priority order (Section 7): two-hand > grip > pose-agnostic thrusts.
    this.evalBreathCharge(events, t);
    this.evalTwinCannon(events, t);
    this.evalRisingFlame(events, t);
    this.evalWhip(events, t, 'left');
    this.evalWhip(events, t, 'right');
    this.evalThrust(events, t, 'left');
    this.evalThrust(events, t, 'right');

    return this.stampCapture(events, frame);
  }

  /** Stamp every event of this frame with the frame's captureTs (live
   * frames only; fixtures lack the field and events stay byte-identical). */
  private stampCapture(events: MoveEvent[], frame: LandmarkFrame): MoveEvent[] {
    if (frame.captureTs !== undefined) {
      for (const e of events) e.captureTs = frame.captureTs;
    }
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

  private updateHand(s: HandState, raw: HandFrame | null, t: number, dtSec: number): void {
    const present =
      raw !== null && raw.confidence >= CONFIDENCE_FLOOR && raw.landmarks.length >= 21;
    if (!present || raw === null) {
      s.resetTracking();
      return;
    }

    s.present = true;
    s.lastPresentT = t;
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

    // Palm is NOT classified here anymore (7-move simplification): no move
    // reads a palm score, so the engine skips palmScore2D entirely. The
    // studio's SignalTracker still records palm scores for its own review
    // signals, and the HaGRID suite keeps both palm scorers honest.
    const fist = fistScore(raw);
    const grip = gripScore(raw);
    // Grip runs on a short moving average; see GRIP_SMOOTH_FRAMES above.
    s.gripRecent.push(grip);
    if (s.gripRecent.length > GRIP_SMOOTH_FRAMES) s.gripRecent.shift();
    let gripSum = 0;
    for (const g of s.gripRecent) gripSum += g;
    const gripSmoothed = gripSum / s.gripRecent.length;
    s.chamberH.update(fist);
    s.scores = {
      fist,
      grip: gripSmoothed,
      fistActive: s.fistH.update(fist),
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

  /**
   * The Twin Cannon chest band [minY, maxY]. Pose fresh: between the real
   * shoulder line and the hip line (plain body geometry, no tuned margins);
   * pose absent or stale: the absolute TWIN_CHEST_Y_MIN/MAX constants,
   * exactly what every legacy replay fixture runs on.
   */
  private chestBand(): [number, number] {
    const pose = this.latestPose;
    if (this.poseFresh && pose !== null) {
      const shoulderY = (pose.left.shoulder.y + pose.right.shoulder.y) / 2;
      const hipY = (pose.left.hip.y + pose.right.hip.y) / 2;
      if (shoulderY < hipY) return [shoulderY, hipY];
    }
    return [TWIN_CHEST_Y_MIN, TWIN_CHEST_Y_MAX];
  }

  private updateArmTimers(t: number, dtMs: number): void {
    const L = this.left;
    const R = this.right;
    const both = L.present && R.present && L.wrist !== null && R.wrist !== null;

    // Breath Charge: both fists parked at the hips, roughly static. The hip
    // band is pose-relative when pose is fresh (see lowBandY); the fist
    // read runs at the data-derived chamber level (BREATH_FIST_ENTER).
    const breathY = this.lowBandY('breath');
    const hipCond =
      both &&
      L.chamberH.isActive &&
      R.chamberH.isActive &&
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

    // Twin Cannon: both wrists together at chest height (between the
    // shoulder and hip lines when pose is fresh). Pose-agnostic since the
    // 7-move simplification: the together-at-chest hold plus the joint
    // thrust is the differentiator, not finger curl.
    const [chestMin, chestMax] = this.chestBand();
    const chest =
      both &&
      inBand((L.wrist as Vec3).y, chestMin, chestMax) &&
      inBand((R.wrist as Vec3).y, chestMin, chestMax);
    const together =
      both && dist(L.wrist as Vec3, R.wrist as Vec3) < this.togetherThreshold;
    if (chest && together) {
      this.twinHoldMs += dtMs;
      if (this.twinHoldMs >= TWIN_HOLD_MS) this.twinArmedUntil = t + TWIN_GRACE_MS;
    } else {
      this.twinHoldMs = 0;
    }

    // Rising Flame: both hands low (pose-relative band when pose is fresh).
    // Pose-agnostic since the 7-move simplification: the low hold plus the
    // fast two-arm upward sweep is the differentiator. Arming is suppressed
    // briefly after a Breath Charge fires (see risingSuppressUntil).
    const risingY = this.lowBandY('rising');
    const low =
      both &&
      t >= this.risingSuppressUntil &&
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
    if (emitted) {
      this.empowerUntil = t + EMPOWER_WINDOW_MS;
      // The charge claims the at-hips posture: its release (both fists
      // rising fast off the hips) must not read as a Rising Flame sweep.
      // Reuses the standard consume window (THRUST_CONSUME_MS); a real
      // rising needs a fresh low hold, which takes longer than this anyway.
      this.risingLowMs = 0;
      this.risingArmedUntil = -Infinity;
      this.risingSuppressUntil = t + THRUST_CONSUME_MS;
    }
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
    const bothHands = L.present && R.present;
    const sweep =
      bothHands &&
      L.speed.velocity.y <= -this.th.risingUpVel &&
      R.speed.velocity.y <= -this.th.risingUpVel;
    if (!sweep) {
      if (this.debugEnabled && bothHands) {
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
    // The sweep belongs to Rising Flame: never let the same two-arm motion
    // fall through and register per-hand thrust spikes.
    this.consumeThrust(L, t);
    this.consumeThrust(R, t);

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
  // Thrusts (pose-agnostic: jab / cross-combo / fire-stream)
  // -------------------------------------------------------------------------

  private evalThrust(events: MoveEvent[], t: number, hand: Handedness): void {
    const s = this.handState(hand);
    if (s.present && s.scores !== null && s.wrist !== null) {
      this.registerHandThrust(t, s);
    } else {
      // Hand absent: the vanished-hand elbow-only path (see the
      // HAND_VANISH_WINDOW_MS / ELBOW_VANISH_VEL notes above).
      this.registerVanishThrust(t, s, hand);
    }

    const th = s.thrust;
    if (th === null) return;

    // Resolution needs an origin: the tracked wrist, or for a vanished
    // hand the pose wrist of the same side.
    const origin = s.wrist ?? this.poseWristOf(hand);
    if (origin === null) return; // pose lost too: keep the thrust pending

    // Retract within the hold window resolves to the discrete move. The
    // retract signal is windowed bbox shrink (the on-screen hand getting
    // smaller as it pulls back) or, pose fresh, a fast elbow RE-FLEX; a
    // vanished hand reads growth 0, so the elbow re-flex is what resolves
    // an elbow-only thrust.
    if (this.isRetract(s)) {
      s.thrust = null;
      // Guard against double-fire when the hand reappears: the resolved
      // elbow-only thrust consumes the hand's motion for the standard
      // window, so the reacquisition spike cannot re-register it.
      if (th.elbowOnly) this.consumeThrust(s, t);
      this.emitJab(events, t, hand, s, th, origin);
      return;
    }

    // Held extended past the window resolves to Fire Stream, the only
    // sustained move since the 7-move simplification. For an elbow-only
    // thrust "held" means the elbow stayed extended: no re-flex arrived.
    if (t - th.tSpike >= EXTEND_HOLD_MS) {
      s.thrust = null;
      if (th.elbowOnly) this.consumeThrust(s, t);
      const aim = th.elbowOnly ? th.aimVel : this.thrustAim(hand, th.aimVel);
      const emitted = this.emit(events, t, {
        move: 'fire-stream',
        hand,
        kind: 'sustain-start',
        aim,
        origin,
        completedAt: th.tSpike + EXTEND_HOLD_MS,
        cost: 0,
        minBreath: STREAM_COST_PER_SEC * SUSTAIN_MIN_SEC,
        cooldownMs: 0,
        lockoutMs: 0,
      });
      if (emitted) {
        this.sustain = {
          move: 'fire-stream',
          hand,
          costPerSec: STREAM_COST_PER_SEC,
          aim,
          lastOrigin: origin,
          elbowOnly: th.elbowOnly,
        };
      }
    }
  }

  /** Hand-tracked spike registration plus near-miss tracing. */
  private registerHandThrust(t: number, s: HandState): void {
    // Priority note: the whip (evaluated earlier) claims lateral swings and
    // the two-hand moves consume joint motions, so a thrust reaching this
    // point is a genuine one-arm event. Since the 7-move simplification
    // there is NO finger-pose requirement here: the elbow/speed/growth
    // fusion alone decides, and a palm push resolves exactly like a fist
    // jab (finger curl is irrelevant to the thrust family).

    // Register or refresh a thrust spike.
    if (t >= s.suppressThrustUntil && this.isSpike(s)) {
      if (s.thrust === null) {
        s.thrust = {
          tSpike: t,
          aimVel: s.speed.velocity,
          peakSpeed: s.speed.speed,
          elbowOnly: false,
        };
      } else if (!s.thrust.elbowOnly && s.speed.speed > s.thrust.peakSpeed) {
        // Track the peak of the spike: that is the punch vector. A pending
        // ELBOW-ONLY thrust is left untouched (its peak is in rad/s): the
        // reappeared hand resolves it instead of re-registering it.
        s.thrust.peakSpeed = s.speed.speed;
        s.thrust.aimVel = s.speed.velocity;
      }
    } else if (this.debugEnabled && t >= s.suppressThrustUntil && s.thrust === null) {
      // Near-miss tracing: a would-be thrust that failed its final physical
      // condition while at least NEAR_MISS_FRACTION of the way there. The
      // record names the SPECIFIC failing fusion signal.
      const move: MoveName = 'jab-blast';
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

  /**
   * Vanished-hand elbow-only registration: pose fresh, the hand tracked
   * within HAND_VANISH_WINDOW_MS but currently absent (the disappearance IS
   * the fast-motion signature on the drill data), and the elbow extension
   * crossing the data-derived vanish floor. Aim comes from the forearm,
   * captured at the peak extension velocity.
   */
  private registerVanishThrust(t: number, s: HandState, hand: Handedness): void {
    if (t < s.suppressThrustUntil) return;
    if (!this.poseFresh) return;
    if (t - s.lastPresentT > HAND_VANISH_WINDOW_MS) return;
    const threshold = Math.max(this.th.elbowExtendVel, ELBOW_VANISH_VEL);
    if (s.elbowVel < threshold) {
      if (
        this.debugEnabled &&
        s.thrust === null &&
        s.elbowVel >= NEAR_MISS_FRACTION * threshold
      ) {
        this.recordNearMiss(t, 'jab-blast', 'elbowVel', s.elbowVel, threshold);
      }
      return;
    }
    if (s.thrust === null) {
      s.thrust = {
        tSpike: t,
        aimVel: this.forearmAim(hand),
        peakSpeed: s.elbowVel,
        elbowOnly: true,
      };
    } else if (s.thrust.elbowOnly && s.elbowVel > s.thrust.peakSpeed) {
      s.thrust.peakSpeed = s.elbowVel;
      s.thrust.aimVel = this.forearmAim(hand);
    }
  }

  private emitJab(
    events: MoveEvent[],
    t: number,
    hand: Handedness,
    s: HandState,
    th: ThrustRecord,
    origin: Vec3,
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
      // Elbow-only thrusts carry their final forearm aim in the record.
      aim: th.elbowOnly ? th.aimVel : this.thrustAim(hand, th.aimVel),
      origin,
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

  // -------------------------------------------------------------------------
  // Sustained move lifecycle
  // -------------------------------------------------------------------------

  private updateSustain(events: MoveEvent[], t: number, dtSec: number): void {
    const su = this.sustain;
    if (su === null) return;
    const s = this.handState(su.hand);

    this.breathValue -= su.costPerSec * dtSec;
    if (s.wrist !== null) su.lastOrigin = s.wrist;
    else if (su.elbowOnly) {
      // Vanished hand: the pose wrist keeps the origin moving with the arm.
      const pw = this.poseWristOf(su.hand);
      if (pw !== null) su.lastOrigin = pw;
    }

    // Pose-agnostic since the 7-move simplification: the stream ends when
    // the hand is lost, the arm retracts, or Breath runs out; finger curl
    // never ends it. Windowed bbox shrink (or, pose fresh, a fast elbow
    // re-flex): robust against noise over a long hold (the retract
    // threshold sits well above the measured hold-noise floor); a real
    // retract crosses it within ~2 frames. An ELBOW-ONLY stream is
    // pose-driven instead: it survives the vanished hand and ends on the
    // elbow re-flex, Breath exhaustion, or pose going stale.
    const retracting = s.present && this.isRetract(s);
    const ended = su.elbowOnly
      ? this.breathValue <= 0 ||
        !this.poseFresh ||
        s.elbowVel <= -this.th.elbowExtendVel ||
        retracting
      : this.breathValue <= 0 || !s.present || retracting;

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
   * Thrust-family aim (jab / cross / stream): when pose is fresh, blend the
   * forearm direction (elbow -> wrist, screen space, z borrowed from the
   * velocity aim since 2D pose says nothing about depth) with the velocity
   * aim at AIM_FOREARM_WEIGHT / AIM_VELOCITY_WEIGHT (tunable, see the
   * constants). Pose absent: pure velocity aim, exactly as before.
   * Twin / rising / whip keep the velocity aim regardless.
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

  private consumeThrust(s: HandState, t: number): void {
    s.thrust = null;
    s.suppressThrustUntil = t + THRUST_CONSUME_MS;
  }

  /** The pose wrist for a side, or null when no pose has been seen. */
  private poseWristOf(hand: Handedness): Vec3 | null {
    const pose = this.latestPose;
    if (pose === null) return null;
    return hand === 'left' ? pose.left.wrist : pose.right.wrist;
  }

  /**
   * Aim for a vanished-hand elbow-only thrust: the FOREARM direction.
   * pose.world (metric, mirrored consistently with player space: x right,
   * y down, z negative toward the camera) gives a true 3D elbow -> wrist
   * direction. Screen joints carry no usable depth, so the fallback blends
   * the planar screen forearm with the forward fallback at the standard
   * AIM_FOREARM_WEIGHT / AIM_VELOCITY_WEIGHT split; no pose at all (cannot
   * happen while poseFresh, kept for safety) aims straight ahead.
   */
  private forearmAim(hand: Handedness): Vec3 {
    const pose = this.latestPose;
    if (pose === null) return AIM_FORWARD;
    const world = pose.world;
    if (world) {
      const arm = hand === 'left' ? world.left : world.right;
      const dir = normalize({
        x: arm.wrist.x - arm.elbow.x,
        y: arm.wrist.y - arm.elbow.y,
        z: arm.wrist.z - arm.elbow.z,
      });
      if (dir.x !== 0 || dir.y !== 0 || dir.z !== 0) return dir;
    }
    const arm = hand === 'left' ? pose.left : pose.right;
    const dx = arm.wrist.x - arm.elbow.x;
    const dy = arm.wrist.y - arm.elbow.y;
    const planarLen = Math.hypot(dx, dy);
    if (planarLen < 1e-6) return AIM_FORWARD;
    const blended = normalize({
      x: AIM_FOREARM_WEIGHT * (dx / planarLen),
      y: AIM_FOREARM_WEIGHT * (dy / planarLen),
      z: AIM_VELOCITY_WEIGHT * AIM_FORWARD.z,
    });
    if (blended.x === 0 && blended.y === 0 && blended.z === 0) return AIM_FORWARD;
    return blended;
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
