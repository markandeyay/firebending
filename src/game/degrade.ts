/**
 * Degrade ladder (T070, spec Section 14). Automatic quality stepping driven
 * by measured frame times, in the spec order:
 *
 *   rung 0  full fidelity
 *   (heat distortion off would be the first rung, but heat distortion was
 *    never built, so the ladder starts at particles; deviation recorded in
 *    the tracker)
 *   rung 1  particle count halved        setParticleScale(0.5)
 *   rung 2  pose tracking rate halved    setPoseIntervalMultiplier(2)
 *   rung 3  shadow resolution halved     setShadowHalved(true)
 *
 * The old face rung is GONE (Round 3 Phase 2): FaceLandmarker was deleted
 * and head pose now rides the pose samples for free, so there is nothing
 * left to degrade. ML degrade matches LiveLandmarkSource's internal
 * ML-budget ladder: pose only, hands never. Pose at half rate still feeds
 * the punch-fusion freshness window (250 ms), and head parallax follows the
 * pose rate since the camera rig smooths it anyway.
 *
 * Measurement: frame times accumulate into non-overlapping 120-frame windows
 * and each full window contributes one median. A window is SLOW when its
 * median exceeds DEGRADE_SLOW_MEDIAN_MS and FAST when it stays under
 * DEGRADE_FAST_MEDIAN_MS; anything between is neutral. Two consecutive slow
 * windows step DOWN one rung; four consecutive fast windows step UP one rung.
 * The asymmetric window counts are the hysteresis: alternating slow/fast
 * windows can never oscillate the ladder. Every step clears the streaks and
 * the in-progress window so the next verdict measures the new configuration.
 *
 * The ladder owns no rendering state; the host supplies hooks and each hook
 * is called exactly once per step that crosses its rung.
 */

export interface DegradeHooks {
  /** Rung 1: multiplier on particle spawn counts and rates, 0..1. */
  setParticleScale(scale: number): void;
  /** Rung 2: multiplier on the pose detection interval (2 = half rate). */
  setPoseIntervalMultiplier(multiplier: number): void;
  /** Rung 3: shadow maps at half resolution while true. */
  setShadowHalved(halved: boolean): void;
}

/** Frames per measurement window. */
export const DEGRADE_WINDOW_FRAMES = 120;
/** A window median above this is slow (just past the 60 fps budget). */
export const DEGRADE_SLOW_MEDIAN_MS = 16.9;
/** A window median below this is fast (comfortable headroom). */
export const DEGRADE_FAST_MEDIAN_MS = 14;
/** Consecutive slow windows required to step down one rung. */
export const DEGRADE_SLOW_WINDOWS = 2;
/** Consecutive fast windows required to step back up one rung. */
export const DEGRADE_FAST_WINDOWS = 4;
/** Deepest rung (see the module header for the rung table). */
export const DEGRADE_MAX_RUNG = 3;

const RUNG_LABELS: readonly string[] = [
  'full fidelity',
  'particles halved',
  'pose rate halved',
  'shadows halved',
];

export class DegradeLadder {
  private readonly hooks: DegradeHooks;
  private readonly window: number[] = [];
  private slowStreak = 0;
  private fastStreak = 0;
  private currentRung = 0;
  private lastMedian: number | null = null;

  constructor(hooks: DegradeHooks) {
    this.hooks = hooks;
  }

  /** Current rung, 0 (full fidelity) .. DEGRADE_MAX_RUNG. */
  get rung(): number {
    return this.currentRung;
  }

  /** Median of the most recently completed window, ms. Null before the first. */
  get lastWindowMedianMs(): number | null {
    return this.lastMedian;
  }

  /** Feed one frame's wall-clock duration in milliseconds. */
  update(frameMs: number): void {
    if (!Number.isFinite(frameMs) || frameMs < 0) return;
    this.window.push(frameMs);
    if (this.window.length < DEGRADE_WINDOW_FRAMES) return;

    const median = medianOf(this.window);
    this.window.length = 0;
    this.lastMedian = median;

    if (median > DEGRADE_SLOW_MEDIAN_MS) {
      this.slowStreak++;
      this.fastStreak = 0;
      if (this.slowStreak >= DEGRADE_SLOW_WINDOWS && this.currentRung < DEGRADE_MAX_RUNG) {
        this.step(this.currentRung + 1, median);
      }
    } else if (median < DEGRADE_FAST_MEDIAN_MS) {
      this.fastStreak++;
      this.slowStreak = 0;
      if (this.fastStreak >= DEGRADE_FAST_WINDOWS && this.currentRung > 0) {
        this.step(this.currentRung - 1, median);
      }
    } else {
      this.slowStreak = 0;
      this.fastStreak = 0;
    }
  }

  private step(toRung: number, median: number): void {
    const down = toRung > this.currentRung;
    // The rung whose setting changes: stepping down enters `toRung`,
    // stepping up leaves the rung we are currently on.
    const changed = down ? toRung : this.currentRung;
    this.currentRung = toRung;
    this.slowStreak = 0;
    this.fastStreak = 0;

    switch (changed) {
      case 1:
        this.hooks.setParticleScale(down ? 0.5 : 1);
        break;
      case 2:
        this.hooks.setPoseIntervalMultiplier(down ? 2 : 1);
        break;
      case 3:
        this.hooks.setShadowHalved(down);
        break;
    }

    console.info(
      `DEGRADE: ${down ? 'down' : 'up'} to rung ${toRung} ` +
        `(${RUNG_LABELS[toRung] ?? 'unknown'}), window median ${median.toFixed(2)}ms`,
    );
  }
}

/** Median of a non-empty list (does not mutate the input). */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] ?? upper;
  return (lower + upper) / 2;
}
