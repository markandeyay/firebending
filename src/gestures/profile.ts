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
 * DEFAULT_PROFILE is chosen so thresholdsFrom(DEFAULT_PROFILE) reproduces
 * the previously tuned absolute values exactly (spikeSpeed 0.9, risingUpVel
 * 1.0, whipSwingVx 1.0, whipStaticMax 0.3, breathStaticMax 0.4, aimMinSpeed
 * 0.5, and spikeGrowth 1.35 / retractShrink 1.05 matching the regenerated
 * perspective-scaled fixtures). Replay fixtures and tests therefore stay
 * deterministic with no stored profile.
 *
 * Every derived threshold is floored at 3x the matching neutral baseline AND
 * at a small absolute safety floor, so a degenerate profile (near-zero peaks
 * from a botched capture) can never hair-trigger the detectors.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MotionProfile {
  version: 1;
  /** Peak windowed wrist speed of a real punch, normalized units/sec. */
  peakPunchSpeed: number;
  /** Peak relative palm-span growth of a real punch, 1/sec. */
  peakPunchGrowth: number;
  /** Peak windowed wrist speed of a palm push, normalized units/sec. */
  peakPalmSpeed: number;
  /** Peak relative palm-span growth of a palm push, 1/sec. */
  peakPalmGrowth: number;
  /** Median windowed wrist speed while resting, normalized units/sec. */
  neutralSpeed: number;
  /** Median absolute span growth while resting, 1/sec. */
  neutralGrowth: number;
  /** ISO timestamp of the capture ('default' for DEFAULT_PROFILE). */
  capturedAt: string;
}

export interface MotionThresholds {
  /** Windowed wrist speed to register a thrust spike (jab / wave / twin). */
  spikeSpeed: number;
  /** Windowed span growth rate to register a thrust spike, 1/sec. */
  spikeGrowth: number;
  /** Windowed span SHRINK rate (positive number) that counts as retract. */
  retractShrink: number;
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
 */
export const FLOOR_SPIKE_SPEED = 0.5;
export const FLOOR_SPIKE_GROWTH = 0.6;
export const FLOOR_RETRACT_SHRINK = 0.5;
export const FLOOR_SWEEP = 0.6;
export const FLOOR_WHIP_STATIC = 0.2;
export const FLOOR_BREATH_STATIC = 0.4;
export const FLOOR_AIM_MIN = 0.5;

/**
 * Fallback profile for replay fixtures, tests, and skipped calibration.
 * Peaks match the regenerated synthetic fixtures (punch speed ~1.5..1.65
 * u/s windowed with peaks near 2 for a hard sweep; punch span growth
 * ~2.8..3.1 1/s); neutral baselines match resting fixture hands.
 */
export const DEFAULT_PROFILE: MotionProfile = {
  version: 1,
  peakPunchSpeed: 2.0,
  peakPunchGrowth: 3.0,
  peakPalmSpeed: 1.6,
  peakPalmGrowth: 3.0,
  neutralSpeed: 0.1,
  neutralGrowth: 0.15,
  capturedAt: 'default',
};

/**
 * Derive the full motion-threshold set from a profile. Every threshold is
 * max(fraction of the calibrated peak, 3x the matching neutral baseline,
 * absolute safety floor).
 */
export function thresholdsFrom(profile: MotionProfile): MotionThresholds {
  const nSpeed = NEUTRAL_FLOOR_MULT * profile.neutralSpeed;
  const nGrowth = NEUTRAL_FLOOR_MULT * profile.neutralGrowth;
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
      JAB_TRIGGER_FRACTION * profile.peakPunchGrowth,
      nGrowth,
      FLOOR_SPIKE_GROWTH,
    ),
    retractShrink: Math.max(
      RETRACT_FRACTION * profile.peakPunchGrowth,
      nGrowth,
      FLOOR_RETRACT_SHRINK,
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

export const PROFILE_STORAGE_KEY = 'fb.motionProfile.v1';

const NUMERIC_KEYS = [
  'peakPunchSpeed',
  'peakPunchGrowth',
  'peakPalmSpeed',
  'peakPalmGrowth',
  'neutralSpeed',
  'neutralGrowth',
] as const;

/** Full structural validation: wrong version, NaN, or non-finite rejects. */
function isValidProfile(value: unknown): value is MotionProfile {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  if (p['version'] !== 1) return false;
  if (typeof p['capturedAt'] !== 'string') return false;
  for (const key of NUMERIC_KEYS) {
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false;
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

/** Load the stored profile, or null when absent, invalid, or unavailable. */
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
