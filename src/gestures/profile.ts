/**
 * Per-player motion profile and threshold derivation.
 *
 * The move engine used to carry absolute motion-trigger constants
 * (SPIKE_SPEED_MIN and friends). Players differ wildly in punch speed and in
 * how much their hand grows on screen during a thrust, so every motion
 * threshold is now derived from a MotionProfile captured during the
 * calibration ritual's punch/push steps. Static geometry (y bands, hold
 * durations, Breath costs) stays absolute in moves.ts; only motion triggers
 * are personal.
 *
 * VERSION 2 (pose-fusion): the growth fields are now BOUNDING-BOX-DIAGONAL
 * growth (src/gestures/motion.ts bboxGrowthRate), replacing palm-span growth
 * which collapsed exactly when a fist clenched, and the profile gains the
 * elbow-extension angular-velocity peaks from the body-pose punch signal
 * (rad/s, from PoseLandmarker; see tracking/poseSource.ts). A stored v1
 * profile fails validation and loads as null, forcing one recalibration.
 *
 * DEFAULT_PROFILE is chosen so thresholdsFrom(DEFAULT_PROFILE) reproduces
 * the previously tuned values exactly (spikeSpeed 0.9, risingUpVel 1.0,
 * whipSwingVx 1.0, whipStaticMax 0.3, breathStaticMax 0.4, aimMinSpeed 0.5,
 * spikeGrowth 1.35 / retractShrink 1.05). The growth defaults carry over
 * unchanged because on the perspective-scaled synthetic fixtures the bbox
 * diagonal grows at the same relative rate as the palm span (uniform
 * scaling): measured windowed bbox growth peaks 2.69..3.08 1/s across every
 * thrust fixture (jab 3.03/3.04, cross-combo 3.02/3.08, stream 2.95,
 * palm-wave 2.76, fan 2.69, twin 2.81/2.84) against the derived 1.35
 * threshold, while every negative fixture stays at or below 1.28 (fidget
 * 1.23, breath-charge release 1.28, talking-hands 1.00). All fixtures
 * therefore keep firing exactly their moves through the no-pose fallback
 * path with no fixture regeneration.
 *
 * Every derived threshold is floored at 3x the matching neutral baseline AND
 * at a small absolute safety floor, so a degenerate profile (near-zero peaks
 * from a botched capture) can never hair-trigger the detectors.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MotionProfile {
  version: 2;
  /** Peak windowed wrist speed of a real punch, normalized units/sec. */
  peakPunchSpeed: number;
  /** Peak relative hand-bbox-diagonal growth of a real punch, 1/sec. */
  peakPunchBboxGrowth: number;
  /** Peak windowed wrist speed of a palm push, normalized units/sec. */
  peakPalmSpeed: number;
  /** Peak relative hand-bbox-diagonal growth of a palm push, 1/sec. */
  peakPalmBboxGrowth: number;
  /** Peak elbow-extension angular velocity of a real punch, rad/s. */
  peakElbowVel: number;
  /** Median absolute elbow angular velocity while resting, rad/s. */
  neutralElbowVel: number;
  /** Median windowed wrist speed while resting, normalized units/sec. */
  neutralSpeed: number;
  /** Median absolute bbox-diagonal growth while resting, 1/sec. */
  neutralBboxGrowth: number;
  /** ISO timestamp of the capture ('default' for DEFAULT_PROFILE). */
  capturedAt: string;
  /**
   * OPTIONAL (additive, position-state-machine rebuild 2026-07-31): the
   * calibrated per-arm FORWARD-PUNCH peak reach in SHOULDER-WIDTH units,
   * i.e. dist(shoulder anchor, pose wrist) / shoulder width at the peak of
   * a calibration punch. Seeds the phase engine's maxReach normalizer
   * (src/gestures/extension.ts). NOTE this is the foreshortened SCREEN
   * reach of a punch thrown at the camera (drill-measured 0.59..0.93), NOT
   * anatomical arm length: a hanging idle arm measures 1.6..2.2 and must
   * never seed this. Profiles that predate the fields lack them, and
   * absence is fully supported (the engine falls back to its prior); a
   * PRESENT but non-finite or non-positive value fails validation like any
   * other corrupt numeric field.
   */
  maxReachLeftSw?: number;
  maxReachRightSw?: number;
}

export interface MotionThresholds {
  /** Windowed wrist speed to register a thrust spike (jab / wave / twin). */
  spikeSpeed: number;
  /** Windowed bbox-diagonal growth rate to register a thrust spike, 1/sec. */
  spikeGrowth: number;
  /** Windowed bbox SHRINK rate (positive number) that counts as retract. */
  retractShrink: number;
  /**
   * Elbow-extension angular velocity (rad/s) for the pose-fusion PRIMARY
   * punch signal; negated, it is also the fast re-flex retract signal.
   */
  elbowExtendVel: number;
  /** Windowed -y velocity for the Rising Flame upward sweep. */
  risingUpVel: number;
  /** Windowed |x| velocity for the Fire Whip lateral swing. */
  whipSwingVx: number;
  /** "Roughly static" speed cap during the whip's grip hold. */
  whipStaticMax: number;
  /** "Roughly static" speed cap during the Breath Charge hip hold. */
  breathStaticMax: number;
  /** Below this windowed speed the aim falls back to AIM_FORWARD. */
  aimMinSpeed: number;
}

// ---------------------------------------------------------------------------
// Derivation fractions and safety floors
// ---------------------------------------------------------------------------

/** Jab/thrust triggers fire at this fraction of the calibrated punch peaks. */
export const JAB_TRIGGER_FRACTION = 0.45;
/** Retract fires at this fraction of the calibrated punch growth peak. */
export const RETRACT_FRACTION = 0.35;
/** Rising sweep and whip swing fire at this fraction of the punch speed. */
export const SWEEP_FRACTION = 0.5;
/** Static caps sit at this fraction of the punch speed (or 3x neutral). */
export const STATIC_FRACTION = 0.12;
/** Aim direction needs this fraction of the punch speed (or 3x neutral). */
export const AIM_FRACTION = 0.2;
/** Derived thresholds never drop below this multiple of the neutral baseline. */
export const NEUTRAL_FLOOR_MULT = 3;

/**
 * Absolute safety floors. Chosen so thresholdsFrom(DEFAULT_PROFILE) lands
 * exactly on the status quo tuning: the speed/growth floors sit safely below
 * the DEFAULT-derived values (never active for a sane profile), while the
 * static and aim floors ARE the binding term for DEFAULT_PROFILE (0.4 and
 * 0.5 reproduce the old BREATH_STATIC_SPEED_MAX and AIM_MIN_SPEED). Raising
 * a static cap is lenient, not hair-trigger, so a high floor there is safe.
 * The elbow floor (1.5 rad/s) guards against a pose capture that barely saw
 * the arm: idle arm sway measures well under 1 rad/s, a deliberate punch
 * extension measures several.
 */
export const FLOOR_SPIKE_SPEED = 0.5;
export const FLOOR_SPIKE_GROWTH = 0.6;
export const FLOOR_RETRACT_SHRINK = 0.5;
export const FLOOR_ELBOW_VEL = 1.5;
export const FLOOR_SWEEP = 0.6;
export const FLOOR_WHIP_STATIC = 0.2;
export const FLOOR_BREATH_STATIC = 0.4;
export const FLOOR_AIM_MIN = 0.5;

/**
 * Fallback profile for replay fixtures, tests, and skipped calibration.
 * Speed/growth peaks match the synthetic fixtures (punch speed ~1.5..1.65
 * u/s windowed with peaks near 2 for a hard sweep; punch bbox growth
 * 2.69..3.08 1/s measured, see the module header); neutral baselines match
 * resting fixture hands. Elbow defaults model a real seated punch: the
 * elbow opens from a ~90 degree guard to near straight (~1.4 rad) in about
 * 175 ms, i.e. a peak around 8 rad/s, and a resting arm drifts well under
 * 0.5 rad/s. Derived elbowExtendVel = 0.45 * 8 = 3.6 rad/s.
 */
export const DEFAULT_PROFILE: MotionProfile = {
  version: 2,
  peakPunchSpeed: 2.0,
  peakPunchBboxGrowth: 3.0,
  peakPalmSpeed: 1.6,
  peakPalmBboxGrowth: 3.0,
  peakElbowVel: 8.0,
  neutralElbowVel: 0.3,
  neutralSpeed: 0.1,
  neutralBboxGrowth: 0.15,
  capturedAt: 'default',
};

/**
 * Derive the full motion-threshold set from a profile. Every threshold is
 * max(fraction of the calibrated peak, 3x the matching neutral baseline,
 * absolute safety floor).
 */
export function thresholdsFrom(profile: MotionProfile): MotionThresholds {
  const nSpeed = NEUTRAL_FLOOR_MULT * profile.neutralSpeed;
  const nGrowth = NEUTRAL_FLOOR_MULT * profile.neutralBboxGrowth;
  const nElbow = NEUTRAL_FLOOR_MULT * profile.neutralElbowVel;
  const sweep = Math.max(
    SWEEP_FRACTION * profile.peakPunchSpeed,
    nSpeed,
    FLOOR_SWEEP,
  );
  return {
    spikeSpeed: Math.max(
      JAB_TRIGGER_FRACTION * profile.peakPunchSpeed,
      nSpeed,
      FLOOR_SPIKE_SPEED,
    ),
    spikeGrowth: Math.max(
      JAB_TRIGGER_FRACTION * profile.peakPunchBboxGrowth,
      nGrowth,
      FLOOR_SPIKE_GROWTH,
    ),
    retractShrink: Math.max(
      RETRACT_FRACTION * profile.peakPunchBboxGrowth,
      nGrowth,
      FLOOR_RETRACT_SHRINK,
    ),
    elbowExtendVel: Math.max(
      JAB_TRIGGER_FRACTION * profile.peakElbowVel,
      nElbow,
      FLOOR_ELBOW_VEL,
    ),
    risingUpVel: sweep,
    whipSwingVx: sweep,
    whipStaticMax: Math.max(
      nSpeed,
      STATIC_FRACTION * profile.peakPunchSpeed,
      FLOOR_WHIP_STATIC,
    ),
    breathStaticMax: Math.max(
      nSpeed,
      STATIC_FRACTION * profile.peakPunchSpeed,
      FLOOR_BREATH_STATIC,
    ),
    aimMinSpeed: Math.max(
      nSpeed,
      AIM_FRACTION * profile.peakPunchSpeed,
      FLOOR_AIM_MIN,
    ),
  };
}

// ---------------------------------------------------------------------------
// Persistence (localStorage)
// ---------------------------------------------------------------------------

/**
 * Storage key is shared across profile versions; the version field inside
 * the JSON is what gates loading. A v1 payload under this key fails
 * validation and loads as null, which forces one recalibration.
 */
export const PROFILE_STORAGE_KEY = 'fb.motionProfile.v1';

const NUMERIC_KEYS = [
  'peakPunchSpeed',
  'peakPunchBboxGrowth',
  'peakPalmSpeed',
  'peakPalmBboxGrowth',
  'peakElbowVel',
  'neutralElbowVel',
  'neutralSpeed',
  'neutralBboxGrowth',
] as const;

/**
 * OPTIONAL additive numeric fields (phase-engine reach seeds): absent is
 * fully supported; present values must be finite and positive, matching the
 * strictness of the required numerics so a corrupt profile forces one clean
 * recalibration instead of poisoning extension normalization.
 */
const OPTIONAL_POSITIVE_KEYS = ['maxReachLeftSw', 'maxReachRightSw'] as const;

/** Full structural validation: wrong version (v1 included), NaN, or
 *  non-finite rejects. */
function isValidProfile(value: unknown): value is MotionProfile {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  if (p['version'] !== 2) return false;
  if (typeof p['capturedAt'] !== 'string') return false;
  for (const key of NUMERIC_KEYS) {
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false;
  }
  for (const key of OPTIONAL_POSITIVE_KEYS) {
    const v = p[key];
    if (v === undefined) continue; // additive field: absence fully supported
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return false;
  }
  return true;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage disabled (privacy mode, headless)
  }
}

/** Load the stored profile, or null when absent, invalid, or a stale v1. */
export function loadProfile(): MotionProfile | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(PROFILE_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidProfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: MotionProfile): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Quota or privacy failure: the session still works, just uncached.
  }
}

export function clearProfile(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    // Ignore: nothing to clear or storage unavailable.
  }
}
