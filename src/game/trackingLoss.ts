/**
 * Tracking-loss UX state machines (T070, spec Phase 7). Pure logic, no DOM:
 * the ArenaScreen owns the overlay, chip and pause wiring.
 *
 * TrackingLoss: when BOTH hands go untracked (FilteredSource emits null for
 * each) for longer than TRACKING_LOSS_SEC during arena play, the game pauses
 * world updates and shows the "Show your hands." parchment overlay. When both
 * hands re-gate, a 3-2-1 ember countdown (RESUME_COUNTDOWN_SEC total) runs
 * and play resumes at zero.
 *
 *   playing --(both untracked > 1.5s)--> lost
 *   lost    --(both tracked)----------> resuming   (countdown starts)
 *   resuming --(a hand drops)---------> lost       (countdown cancelled)
 *   resuming --(countdown elapses)----> playing
 *
 * A single tracked hand keeps the game in `playing` (the single-hand fallback
 * covers that case with a hint chip, not a pause): the loss timer only
 * accumulates while NO hand is tracked, but resuming demands both hands per
 * the spec ("resume when both hands re-gate").
 *
 * SingleHandHint: when exactly one hand stays tracked for
 * SINGLE_HAND_HOLD_SEC continuously, emit one 'show' for the non-blocking
 * "One hand found." chip, then 'hide' after HINT_VISIBLE_SEC. The hint
 * re-arms only after both hands have been seen together again, so a player
 * fighting one-handed is not nagged every few seconds.
 */

export type TrackingLossState = 'playing' | 'lost' | 'resuming';

export type TrackingLossEvent =
  | 'lost' // entered the lost state (show the overlay, pause the world)
  | 'countdown-start' // both hands re-gated, ember countdown begins at 3
  | 'countdown-tick' // the visible countdown digit changed (3 -> 2 -> 1)
  | 'resumed'; // countdown finished, world unpauses

/** Both hands must be untracked this long before the overlay appears. */
export const TRACKING_LOSS_SEC = 1.5;
/** Total length of the 3-2-1 resume countdown. */
export const RESUME_COUNTDOWN_SEC = 0.9;
/** Seconds per countdown digit. */
export const COUNTDOWN_STEP_SEC = RESUME_COUNTDOWN_SEC / 3;

export class TrackingLoss {
  private current: TrackingLossState = 'playing';
  private untrackedSec = 0;
  private countdownSec = 0;

  get state(): TrackingLossState {
    return this.current;
  }

  /** True while world updates should be frozen (lost or resuming). */
  get paused(): boolean {
    return this.current !== 'playing';
  }

  /** Visible countdown digit while resuming: 3, 2 or 1. */
  get countdownStep(): number {
    const remaining = Math.max(0, RESUME_COUNTDOWN_SEC - this.countdownSec);
    return Math.min(3, Math.max(1, Math.ceil(remaining / COUNTDOWN_STEP_SEC)));
  }

  /**
   * Advance by dt seconds. `bothHandsTracked` gates the resume path;
   * `anyHandTracked` (defaults to the same flag) gates the loss timer so a
   * single tracked hand never pauses the game. `forceLost` (Round 3 Phase 3,
   * framing gate) drops `playing` into `lost` immediately: the framing
   * watch runs its own 2 s grace before raising it, so no extra timer here.
   * The caller keeps `bothHandsTracked` false while forcing, which also
   * cancels a running countdown through the existing resuming -> lost edge.
   */
  update(
    bothHandsTracked: boolean,
    dt: number,
    anyHandTracked: boolean = bothHandsTracked,
    forceLost = false,
  ): TrackingLossEvent[] {
    const events: TrackingLossEvent[] = [];

    switch (this.current) {
      case 'playing': {
        if (forceLost) {
          this.current = 'lost';
          this.untrackedSec = 0;
          events.push('lost');
        } else if (anyHandTracked) {
          this.untrackedSec = 0;
        } else {
          this.untrackedSec += dt;
          if (this.untrackedSec > TRACKING_LOSS_SEC) {
            this.current = 'lost';
            this.untrackedSec = 0;
            events.push('lost');
          }
        }
        break;
      }

      case 'lost': {
        if (bothHandsTracked) {
          this.current = 'resuming';
          this.countdownSec = 0;
          events.push('countdown-start');
        }
        break;
      }

      case 'resuming': {
        if (!bothHandsTracked) {
          // A hand dropped mid-countdown: back to the overlay.
          this.current = 'lost';
          events.push('lost');
          break;
        }
        const before = this.countdownStep;
        this.countdownSec += dt;
        if (this.countdownSec >= RESUME_COUNTDOWN_SEC) {
          this.current = 'playing';
          this.untrackedSec = 0;
          events.push('resumed');
        } else if (this.countdownStep !== before) {
          events.push('countdown-tick');
        }
        break;
      }
    }

    return events;
  }
}

// ---------------------------------------------------------------------------
// Single-hand fallback hint
// ---------------------------------------------------------------------------

export type SingleHandHintEvent = 'show' | 'hide';

/** Exactly one hand must stay tracked this long before the chip appears. */
export const SINGLE_HAND_HOLD_SEC = 2;
/** The chip fades after this long on screen. */
export const HINT_VISIBLE_SEC = 3;

export class SingleHandHint {
  private singleSec = 0;
  private visibleSec = 0;
  private showing = false;
  private shownThisEpisode = false;

  get visible(): boolean {
    return this.showing;
  }

  update(leftTracked: boolean, rightTracked: boolean, dt: number): SingleHandHintEvent[] {
    const events: SingleHandHintEvent[] = [];
    const exactlyOne = leftTracked !== rightTracked;
    const both = leftTracked && rightTracked;

    if (exactlyOne) {
      this.singleSec += dt;
      if (
        !this.showing &&
        !this.shownThisEpisode &&
        this.singleSec > SINGLE_HAND_HOLD_SEC
      ) {
        this.showing = true;
        this.shownThisEpisode = true;
        this.visibleSec = 0;
        events.push('show');
      }
    } else {
      this.singleSec = 0;
      // Both hands together end the episode; the next one may hint again.
      if (both) this.shownThisEpisode = false;
    }

    if (this.showing) {
      this.visibleSec += dt;
      if (this.visibleSec >= HINT_VISIBLE_SEC) {
        this.showing = false;
        events.push('hide');
      }
    }

    return events;
  }
}
