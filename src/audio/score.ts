/**
 * AdaptiveScore: the procedural arena score director. Pure bookkeeping over
 * the AudioEngine's music voices (drone bed, taiko, shakuhachi), mirroring
 * MoveAudio's design: this module decides WHEN and HOW LOUD, the engine owns
 * the synthesis. Everything is testable headless against a spy engine.
 *
 * TONE.JS DECISION (documented per the audio task): the score stays on the
 * existing zero-dependency Web Audio AudioEngine. The music here is one
 * drone bus, a handful of one-shot voices, and slow AudioParam automation,
 * all of which plain Web Audio expresses in a few nodes. Tone.js would add
 * roughly 150 kB gzipped to a bundle Section 14 caps at 2 MB gzipped for a
 * transport/scheduler/instrument library we would use maybe 5 percent of,
 * and its Transport clock buys nothing for a score that is event-driven
 * (kills, impacts, travels) rather than bar-synchronized. Not worth the
 * weight; synthesis stays license-clean by construction.
 *
 * Intensity model (the pure part, see computeIntensity):
 *   intensity = BASE
 *             + W_SUSTAIN  while a fire-stream sustain is held
 *             + W_HITS    * min(1, hitRate / HIT_RATE_FULL)
 *             + W_DAMAGE  * constructDamage01
 * clamped to 0..1. hitRate is a leaky accumulator: each hit adds a weight,
 * and the total decays exponentially with time constant HIT_DECAY_SEC, so a
 * flurry swells the bed and a lull lets it sink back to the low drone.
 *
 * Inputs and where they come from (existing AudioHooks seam only):
 *   - active sustain: onMoveEvent sustain-start/end (fire-stream).
 *   - recent hit rate: onHitStop (Twin Cannon impacts) and onKill.
 *   - construct hp: the seam does not carry per-hit hp, so wiring feeds
 *     onConstructImpact damage as a rough kill-progress proxy and travels
 *     reset it; setConstructDamage stays exposed for a caller that knows
 *     the real hp fraction.
 *
 * Musical events:
 *   - onKill: intensity spike only. The ceremonial kill taiko already plays
 *     through MoveAudio.onKill -> engine.killHit; doubling it here would
 *     flam. A travel follows every kill, so the phrase note covers the beat.
 *   - onHitStop (Twin Cannon impact): a lighter score taiko + hit credit.
 *   - onTravelStart: one shakuhachi phrase note over the wipe swell, and the
 *     kill-progress proxy resets for the next construct.
 *
 * Clocking: start() opens the engine drone and arms a coarse TICK_MS
 * interval that decays the hit tracker and pushes intensity to the drone
 * handle. All state motion lives in tick(nowMs)/event methods that take an
 * explicit timestamp, so tests drive the state machine directly with fake
 * clocks and never need the interval.
 */

import type { SustainHandle } from './engine';

// ---------------------------------------------------------------------------
// Engine surface the score needs. AudioEngine satisfies it structurally.
// ---------------------------------------------------------------------------

export interface ScoreEngineLike {
  droneStart(): SustainHandle;
  taiko(strength?: number): void;
  shakuhachi(): void;
}

/** The slice of MoveEvent the score reads (kept loose to avoid coupling). */
export interface ScoreMoveEvent {
  kind: 'trigger' | 'sustain-start' | 'sustain-tick' | 'sustain-end';
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

export const SCORE = {
  /** Drone intensity push cadence (ms). Coarse: the engine smooths on top. */
  TICK_MS: 100,
  /** Exponential decay time constant of the recent-hit tracker (seconds). */
  HIT_DECAY_SEC: 4,
  /** hitRate at which the hit contribution saturates. */
  HIT_RATE_FULL: 3,
  /** Intensity weights (sum with BASE stays near 1 at full boil). */
  BASE: 0.12,
  W_SUSTAIN: 0.3,
  W_HITS: 0.36,
  W_DAMAGE: 0.22,
  /** Hit credits fed to the leaky tracker. */
  HIT_WEIGHT_IMPACT: 1,
  HIT_WEIGHT_KILL: 1.6,
  /** Score taiko strength on a Twin Cannon hit-stop impact. */
  IMPACT_TAIKO_STRENGTH: 0.7,
  /** Damage proxy: one construct's worth of damage is normalized by this. */
  DAMAGE_FULL: 30,
} as const;

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Leaky hit tracker decay: rate * e^(-dt / HIT_DECAY_SEC). Pure. */
export function decayHitRate(rate: number, dtSec: number): number {
  if (dtSec <= 0) return rate;
  return rate * Math.exp(-dtSec / SCORE.HIT_DECAY_SEC);
}

export interface IntensityInputs {
  sustainActive: boolean;
  hitRate: number;
  /** 0 = fresh construct, 1 = one kill's worth of damage dealt. */
  constructDamage01: number;
}

/** The whole intensity model in one pure function (see module header). */
export function computeIntensity(s: IntensityInputs): number {
  return clamp01(
    SCORE.BASE +
      (s.sustainActive ? SCORE.W_SUSTAIN : 0) +
      SCORE.W_HITS * Math.min(1, Math.max(0, s.hitRate) / SCORE.HIT_RATE_FULL) +
      SCORE.W_DAMAGE * clamp01(s.constructDamage01)
  );
}

// ---------------------------------------------------------------------------
// AdaptiveScore
// ---------------------------------------------------------------------------

export class AdaptiveScore {
  private drone: SustainHandle | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastNowMs = 0;
  private hitRate = 0;
  private sustainActive = false;
  private damage01 = 0;
  /** Manual override; null = adaptive (the normal state). */
  private override: number | null = null;

  constructor(private readonly engine: ScoreEngineLike) {}

  /** Current drone intensity, override included. */
  get intensity(): number {
    if (this.override !== null) return clamp01(this.override);
    return computeIntensity({
      sustainActive: this.sustainActive,
      hitRate: this.hitRate,
      constructDamage01: this.damage01,
    });
  }

  get running(): boolean {
    return this.drone !== null;
  }

  /** Open the drone bed and arm the tick interval. Idempotent. */
  start(nowMs = Date.now()): void {
    if (this.drone !== null) return;
    this.lastNowMs = nowMs;
    this.drone = this.engine.droneStart();
    this.drone.setIntensity(this.intensity);
    this.interval = setInterval(() => this.tick(Date.now()), SCORE.TICK_MS);
  }

  /**
   * Advance the clock: decay the hit tracker and push intensity to the
   * drone. Public so tests drive the state machine without timers.
   */
  tick(nowMs: number): void {
    const dtSec = Math.max(0, (nowMs - this.lastNowMs) / 1000);
    this.lastNowMs = nowMs;
    this.hitRate = decayHitRate(this.hitRate, dtSec);
    this.drone?.setIntensity(this.intensity);
  }

  /**
   * Force the drone intensity (0..1) until setIntensity(null) returns
   * control to the adaptive model.
   */
  setIntensity(v: number | null): void {
    this.override = v;
    this.drone?.setIntensity(this.intensity);
  }

  /** Feed the real construct hp fraction (1 = full hp) when a caller has it. */
  setConstructDamage(damage01: number): void {
    this.damage01 = clamp01(damage01);
  }

  // -------------------------------------------------------------------------
  // AudioHooks-facing events (wired by src/boot/audioWiring.ts)
  // -------------------------------------------------------------------------

  /** Sustain tracking: fire-stream held = the bed swells. */
  onMoveEvent(e: ScoreMoveEvent, nowMs = Date.now()): void {
    if (e.kind === 'sustain-start' || e.kind === 'sustain-tick') {
      if (!this.sustainActive) {
        this.sustainActive = true;
        this.tick(nowMs);
      }
    } else if (e.kind === 'sustain-end') {
      this.sustainActive = false;
      this.tick(nowMs);
    }
  }

  /** Construct killed: intensity spike (the kill taiko plays via MoveAudio). */
  onKill(nowMs = Date.now()): void {
    this.recordHit(SCORE.HIT_WEIGHT_KILL, nowMs);
  }

  /** Twin Cannon impact hit-stop: score taiko + hit credit. */
  onHitStop(_ms: number, nowMs = Date.now()): void {
    this.engine.taiko(SCORE.IMPACT_TAIKO_STRENGTH);
    this.recordHit(SCORE.HIT_WEIGHT_IMPACT, nowMs);
  }

  /** A projectile struck the construct: damage proxy + light hit credit. */
  onConstructImpact(damage: number, nowMs = Date.now()): void {
    this.damage01 = clamp01(this.damage01 + Math.max(0, damage) / SCORE.DAMAGE_FULL);
    this.recordHit(SCORE.HIT_WEIGHT_IMPACT * 0.5, nowMs);
  }

  /** Camera travel began: phrase note, and the next construct starts fresh. */
  onTravelStart(nowMs = Date.now()): void {
    this.engine.shakuhachi();
    this.damage01 = 0;
    this.sustainActive = false;
    this.tick(nowMs);
  }

  /** Stop the drone and clear the interval. start() may be called again. */
  dispose(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.drone?.stop();
    this.drone = null;
  }

  // -------------------------------------------------------------------------

  private recordHit(weight: number, nowMs: number): void {
    this.tick(nowMs); // decay to now first so credits stack correctly
    this.hitRate += weight;
    this.drone?.setIntensity(this.intensity);
  }
}
