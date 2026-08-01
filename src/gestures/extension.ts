/**
 * Per-arm NORMALIZED EXTENSION and the arm phase machine (position-state-
 * machine rebuild, 2026-07-31).
 *
 * WHY POSITIONS: five rounds of velocity thresholds failed because velocity
 * is a derivative and degrades as fps drops (the player's machine captures
 * at ~14 fps). Extension is a pure position ratio; it survives dropped
 * frames untouched, and time enters only as sanity windows measured on frame
 * timestamps, so the machine behaves identically at 3 samples per punch or
 * 30.
 *
 * WHY THE POSE WRIST: the user's recorded drills (fixtures/recorded/
 * firebending-drill-2026-07-31.json) show the HAND tracker losing the hand
 * during every fast punch while the POSE tracker keeps tracking (pose
 * presence measured at 100 percent across every take, including all jab rep
 * windows). The primary positional signal is therefore the pose wrist; hand
 * landmarks contribute only finger-pose scores elsewhere.
 *
 *   extension = dist(shoulderAnchor, poseWrist) / (shoulderWidth * maxReach)
 *
 * shoulderAnchor and shoulderWidth come from the slowly-drifting body frame
 * (bodyFrame.ts), so the measurement is scale, distance and translation
 * invariant. maxReach is in shoulder-width units.
 *
 * MAXREACH IS THE FORWARD-PUNCH PEAK, NOT ANATOMICAL REACH. Measured on the
 * drill data, screen-space extension is heavily foreshortened for a punch at
 * the camera: guard sits at ~0.07..0.36 shoulder widths, forward punch peaks
 * at only ~0.59..0.93, while a HANGING idle arm sweeps 1.6..2.2 (an arm at
 * the side is anatomically extended and barely foreshortened). A naive
 * running max over all frames would learn the hanging arm's 2.2 and
 * normalized punches would never cross the extended threshold again. So:
 * the prior is the measured forward-punch band (MAX_REACH_PRIOR_SW 0.85),
 * learning happens ONLY from fast RETRACTED-to-peak transitions (punch
 * context, fed by the engine), clamped to the plausible forward band
 * 0.5..1.2, with a very slow decay back toward the seed. The calibrated
 * seed persists via the optional MotionProfile fields (profile.ts).
 *
 * PHASE MACHINE (per the Puioio rep-counter design, validated at 98.89
 * percent real-world accuracy with zero temporal derivatives):
 *   RETRACTED (ext < EXT_RETRACTED_MAX) -> EXTENDING -> EXTENDED
 *   (ext > EXT_EXTENDED_MIN).
 * Two load-bearing invariants: input matching no transition condition causes
 * NO state change, and there are NO backward transitions, with exactly one
 * game-feel exception: EXTENDING may abort back to RETRACTED when extension
 * re-crosses below the retracted threshold, so a half punch that pulls back
 * re-arms instead of stalling. No fire without a full RETRACTED -> EXTENDED
 * traversal, ever, including at init: the first confident sample SEEDS the
 * phase without emitting a transition, so an arm first seen extended (arms
 * hanging at the sides sit far above the threshold permanently) must visit
 * RETRACTED before it can ever fire.
 *
 * The raw extension signal is NOT smoothed and the phase label is not
 * window-filtered (the paper's tuned smoothing window was 1): at 14 fps
 * every smoothing frame costs ~71 ms of latency, and the hysteresis dead
 * band (re-arm at EXT_REARM_MAX) already does the anti-jitter work.
 *
 * CONFIDENCE-AWARE PAUSE: when the required pose landmarks drop below the
 * confidence floor the machine FREEZES: no transitions, timers paused, last
 * state held, indefinitely. It auto-resumes when confidence recovers, and on
 * resume every pending timestamp is shifted by the paused duration so paused
 * time never counts against the thrust or hold windows. A dropped or garbage
 * frame can therefore never corrupt state or fire a move. (Freeze-and-hold,
 * never reset-to-idle: resetting was considered and rejected after the
 * rep-counter review; a held state resumes exactly where the player left
 * off.)
 */

import { EXTEND_HOLD_MS, JAB_COOLDOWN_MS } from './moves';

// Re-exported so phase-machine consumers get their timing constants from
// the same module as the thresholds (values live in moves.ts, the single
// source of truth shared with the legacy engine).
export { EXTEND_HOLD_MS, JAB_COOLDOWN_MS };

// ---------------------------------------------------------------------------
// Thresholds (all on the normalized extension, tunable; see the module
// header for how normalization by the forward-punch maxReach shapes them)
// ---------------------------------------------------------------------------

/** Below this the arm is RETRACTED (guard/chamber). Drill guard measures
 *  0.07..0.36 shoulder widths, ~0.08..0.42 normalized: 0.40 covers it. */
export const EXT_RETRACTED_MAX = 0.4;

/**
 * Above this the arm is EXTENDED. The design starting point was 0.80, but
 * with maxReach = calibrated punch peak (~0.85 sw) the user's softer jab
 * rep maxima (0.59..0.68 sw) normalize to only ~0.70..0.80, so 0.80 would
 * miss them; 0.70 admits every recorded rep. Tunable: a downstream eval
 * pass retunes this against the recordings.
 */
export const EXT_EXTENDED_MIN = 0.7;

/**
 * Re-arm hysteresis: after reaching EXTENDED the arm counts as RETRACTED
 * again once extension falls below this (more lenient than the cold 0.40
 * entry), so rapid-fire jabs re-arm without demanding a full deep chamber.
 */
export const EXT_REARM_MAX = 0.5;

/**
 * A RETRACTED -> EXTENDED traversal slower than this is a REACH, not a jab:
 * the machine still transitions to EXTENDED but marks the entry slow so
 * nothing fires and the dwell cannot promote to a stream.
 */
export const MAX_THRUST_MS = 400;

/**
 * Forward-punch reach prior, shoulder-width units. The DRILL-MEASURED
 * forward punch band peaks at 0.59..0.93 sw; 0.85 seeds near the top so an
 * uncalibrated player's normalized punches land around 0.7..1.1.
 */
export const MAX_REACH_PRIOR_SW = 0.85;

/** Plausible forward-punch band for online learning: peaks outside it are
 *  either bad tracking or a hanging/lateral arm, never a forward punch. */
export const MAX_REACH_LEARN_MIN_SW = 0.5;
export const MAX_REACH_LEARN_MAX_SW = 1.2;

/**
 * Very slow exponential decay of the learned reach back toward the seed,
 * 1/sec (time constant ~8 minutes). WHY: one anomalous hard punch should
 * not permanently deflate every later extension; the decay forgets it over
 * minutes while calibration-quality punches keep re-teaching it.
 */
export const MAX_REACH_DECAY_PER_SEC = 0.002;

// ---------------------------------------------------------------------------
// Reach learner
// ---------------------------------------------------------------------------

/**
 * Online maxReach learner. The engine feeds it the PEAK reach (shoulder-
 * width units) of each completed fast RETRACTED -> EXTENDED traversal only:
 * punch context is the one situation where the arm is known to be thrown
 * forward, so the hanging-arm 2.2 sw plateau can never poison the estimate.
 */
export class ReachLearner {
  private readonly seed: number;
  private reach: number;

  constructor(seed?: number) {
    // A stored seed outside the plausible forward band (corrupt profile,
    // future format drift) falls back to the prior rather than poisoning
    // every normalized extension this session.
    const s =
      seed !== undefined &&
      Number.isFinite(seed) &&
      seed >= MAX_REACH_LEARN_MIN_SW &&
      seed <= MAX_REACH_LEARN_MAX_SW
        ? seed
        : MAX_REACH_PRIOR_SW;
    this.seed = s;
    this.reach = s;
  }

  /** Current maxReach, shoulder-width units. */
  get maxReach(): number {
    return this.reach;
  }

  /** Learn from the peak reach of one completed fast thrust. */
  learn(peakReachSw: number): void {
    if (!Number.isFinite(peakReachSw)) return;
    if (peakReachSw < MAX_REACH_LEARN_MIN_SW) return;
    if (peakReachSw > MAX_REACH_LEARN_MAX_SW) return;
    if (peakReachSw > this.reach) this.reach = peakReachSw;
  }

  /** Advance the slow decay toward the seed. Call once per frame. */
  decay(dtSec: number): void {
    if (!(dtSec > 0) || this.reach <= this.seed) return;
    this.reach =
      this.seed + (this.reach - this.seed) * Math.exp(-MAX_REACH_DECAY_PER_SEC * dtSec);
  }
}

/**
 * Normalized extension for one arm. Pure math, no state: screen distance
 * from the slow shoulder anchor to the pose wrist, over shoulder width,
 * over maxReach. Degenerate input yields 0, never NaN.
 */
export function armExtension(
  anchor: { x: number; y: number },
  wrist: { x: number; y: number },
  shoulderWidth: number,
  maxReachSw: number,
): number {
  if (!(shoulderWidth > 0) || !(maxReachSw > 0)) return 0;
  const d = Math.hypot(wrist.x - anchor.x, wrist.y - anchor.y);
  const ext = d / (shoulderWidth * maxReachSw);
  return Number.isFinite(ext) ? ext : 0;
}

// ---------------------------------------------------------------------------
// Phase machine
// ---------------------------------------------------------------------------

export type ArmPhase = 'RETRACTED' | 'EXTENDING' | 'EXTENDED';

/** One phase transition, for the debug HUD and tests. */
export interface ArmTransition {
  from: ArmPhase;
  to: ArmPhase;
  /** Frame timestamp of the transition, ms. */
  atT: number;
  /** For entries into EXTENDED: time since leaving RETRACTED (paused time
   *  excluded). 0 for every other transition. */
  tookMs: number;
}

/** Per-update output flags. The returned object is REUSED in place by the
 *  machine: callers must read the flags before the next update. */
export interface ArmPhaseUpdate {
  /** Entered EXTENDED this update (any speed, any arming). Edge signal for
   *  pairing logic (twin-cannon) that chambers together rather than at the
   *  shoulders and so never makes the full RETRACTED traversal. */
  enteredExtended: boolean;
  /**
   * Completed a full fast RETRACTED -> EXTENDED traversal this update, past
   * the per-arm cooldown. THE jab signal. The engine still gates it on the
   * completion zone (a hanging-arm drop sweeps extension 0.15 -> 2.0 within
   * the thrust window but ends in the HIP zone).
   */
  fired: boolean;
  /** Reached EXTENDED but slower than MAX_THRUST_MS: a reach, not a jab. */
  slow: boolean;
  /** Dwelled in EXTENDED past EXTEND_HOLD_MS after a FAST entry: the
   *  stream-hold promotion signal. Emitted once per extended visit. */
  holdPromoted: boolean;
  /** When the firing/promoting condition physically completed (<= t). */
  completedAt: number;
}

export class ArmPhaseMachine {
  private phaseVal: ArmPhase = 'RETRACTED';
  private seeded = false;
  /** Armed = has visited RETRACTED since the last fire (or since seeding in
   *  a non-retracted phase). No fire without a full traversal. */
  private armed = false;
  /** When the arm left RETRACTED (thrust-window start). */
  private tLeftRetracted = 0;
  private tEnteredExtended = 0;
  private fastEntry = false;
  private holdSignaled = false;
  private cooldownUntil = -Infinity;
  private pausedVal = false;
  private pauseStartT = 0;
  private lastTransitionVal: ArmTransition | null = null;
  private readonly out: ArmPhaseUpdate = {
    enteredExtended: false,
    fired: false,
    slow: false,
    holdPromoted: false,
    completedAt: 0,
  };

  get phase(): ArmPhase {
    return this.phaseVal;
  }

  get paused(): boolean {
    return this.pausedVal;
  }

  /** The last transition, or null before any. Reused in place. */
  get lastTransition(): Readonly<ArmTransition> | null {
    return this.lastTransitionVal;
  }

  /** True when the current EXTENDED visit was entered fast (jab quality). */
  get fastExtendedEntry(): boolean {
    return this.phaseVal === 'EXTENDED' && this.fastEntry;
  }

  private recordTransition(from: ArmPhase, to: ArmPhase, atT: number, tookMs: number): void {
    let rec = this.lastTransitionVal;
    if (rec === null) {
      rec = { from, to, atT, tookMs };
      this.lastTransitionVal = rec;
    } else {
      rec.from = from;
      rec.to = to;
      rec.atT = atT;
      rec.tookMs = tookMs;
    }
  }

  /**
   * Advance one frame. `confident` gates the freeze: false freezes the
   * machine in place (see the module header); the extension value is
   * ignored while frozen. All timing is on the caller's frame timestamps.
   * Returns the per-update flags (object reused in place).
   */
  update(extension: number, t: number, confident: boolean): ArmPhaseUpdate {
    const out = this.out;
    out.enteredExtended = false;
    out.fired = false;
    out.slow = false;
    out.holdPromoted = false;
    out.completedAt = t;

    if (!confident || !Number.isFinite(extension)) {
      // FREEZE: state held, no transitions. Mark the pause start so resume
      // can shift the timers by exactly the frozen span.
      if (!this.pausedVal) {
        this.pausedVal = true;
        this.pauseStartT = t;
      }
      return out;
    }

    if (this.pausedVal) {
      // RESUME: paused time must not count against any window, so every
      // pending timestamp slides forward by the frozen span.
      const pausedMs = Math.max(0, t - this.pauseStartT);
      this.tLeftRetracted += pausedMs;
      this.tEnteredExtended += pausedMs;
      if (Number.isFinite(this.cooldownUntil)) this.cooldownUntil += pausedMs;
      this.pausedVal = false;
    }

    if (!this.seeded) {
      // Seed WITHOUT a transition: an arm first seen extended (hanging at
      // the side) must visit RETRACTED before it can ever fire.
      this.seeded = true;
      this.phaseVal =
        extension < EXT_RETRACTED_MAX
          ? 'RETRACTED'
          : extension > EXT_EXTENDED_MIN
            ? 'EXTENDED'
            : 'EXTENDING';
      this.armed = this.phaseVal === 'RETRACTED';
      this.fastEntry = false;
      this.holdSignaled = true; // a seeded EXTENDED can never promote
      this.tEnteredExtended = t;
      return out;
    }

    switch (this.phaseVal) {
      case 'RETRACTED': {
        if (extension > EXT_RETRACTED_MAX) {
          this.phaseVal = 'EXTENDING';
          this.tLeftRetracted = t;
          this.recordTransition('RETRACTED', 'EXTENDING', t, 0);
        }
        break;
      }
      case 'EXTENDING': {
        if (extension > EXT_EXTENDED_MIN) {
          const tookMs = t - this.tLeftRetracted;
          const fast = tookMs <= MAX_THRUST_MS;
          this.phaseVal = 'EXTENDED';
          this.tEnteredExtended = t;
          this.fastEntry = fast && this.armed;
          this.holdSignaled = !this.fastEntry; // slow entries never promote
          this.recordTransition('EXTENDING', 'EXTENDED', t, tookMs);
          out.enteredExtended = true;
          if (this.fastEntry) {
            if (t >= this.cooldownUntil) {
              out.fired = true;
              out.completedAt = t;
              this.cooldownUntil = t + JAB_COOLDOWN_MS;
            }
            // Fired or cooldown-refused, the traversal is consumed either
            // way: the arm must re-arm below EXT_REARM_MAX.
            this.armed = false;
          } else {
            out.slow = true;
          }
        } else if (extension < EXT_RETRACTED_MAX) {
          // The one allowed backward transition: a half punch pulled back
          // re-arms instead of stalling in EXTENDING forever.
          this.phaseVal = 'RETRACTED';
          this.armed = true;
          this.recordTransition('EXTENDING', 'RETRACTED', t, 0);
        }
        break;
      }
      case 'EXTENDED': {
        if (extension < EXT_REARM_MAX) {
          this.phaseVal = 'RETRACTED';
          this.armed = true;
          this.fastEntry = false;
          this.holdSignaled = false;
          this.recordTransition('EXTENDED', 'RETRACTED', t, 0);
        } else if (
          this.fastEntry &&
          !this.holdSignaled &&
          t - this.tEnteredExtended >= EXTEND_HOLD_MS
        ) {
          // Dwell promotion: the hold-timer expiry can fall between frames,
          // so the completion time is the exact crossing instant.
          this.holdSignaled = true;
          out.holdPromoted = true;
          out.completedAt = this.tEnteredExtended + EXTEND_HOLD_MS;
        }
        break;
      }
    }
    return out;
  }
}
