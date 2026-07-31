/**
 * MoveAudio: the bridge between the gesture engine's MoveEvent stream and
 * the AudioEngine. Pure bookkeeping, zero Web Audio: it decides WHICH sound
 * fires and manages sustained-sound handle lifecycles, while the engine owns
 * HOW each sound is made. Designed against the EngineLike interface below so
 * tests can inject a spy engine; the real AudioEngine satisfies it
 * structurally.
 *
 * Sustain lifecycle mirrors moveEffects' cone handling: sustain-start opens
 * a handle, every sustain-tick refreshes intensity and a safety timer, and
 * sustain-end stops it. If ticks stop arriving without a sustain-end
 * (tracking dropout, tab losing rAF), the safety timer stops the handle
 * after SUSTAIN_SAFETY_MS, exactly like the cone's 0.6 s self-termination.
 *
 * The breath-charge rumble has no end event of its own: it stops when the
 * empowered follow-up move fires (any trigger or sustain-start consumes the
 * charge) or after the empower window expires, whichever comes first.
 */

import type { MoveEvent } from '../gestures/moves';
import { EMPOWER_WINDOW_MS } from '../gestures/moves';
import type { CoalHandle, StopHandle, SustainHandle } from './engine';

// ---------------------------------------------------------------------------
// Engine surface MoveAudio needs. AudioEngine satisfies this structurally.
// ---------------------------------------------------------------------------

export interface EngineLike {
  jab(empowered?: boolean): void;
  crossCombo(): void;
  twinCannon(empowered?: boolean): void;
  whipCrack(): void;
  risingFlame(): void;
  breathCharge(): StopHandle;
  streamStart(): SustainHandle;
  killHit(): void;
  coalWhistle(flightTimeSec: number): CoalHandle;
  duck(amount: number, ms: number): void;
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * A sustained sound with no tick for this long self-terminates, mirroring
 * moveEffects' SUSTAIN_STALE_SEC = 0.6 cone self-termination.
 */
export const SUSTAIN_SAFETY_MS = 600;

/**
 * Sustain loudness per tick. The engine already shapes streams and fans with
 * its own wobble; a constant here keeps the roar steady while the move is
 * held (ticks arrive every frame, so rate carries no extra information yet).
 */
export const TICK_INTENSITY = 1;

/** Master duck depth during hit-stop (0..1 of current volume). */
export const DUCK_AMOUNT = 0.65;

/** Fallback stop for the charge rumble if no follow-up move consumes it. */
export const CHARGE_FALLBACK_MS = EMPOWER_WINDOW_MS;

// ---------------------------------------------------------------------------
// MoveAudio
// ---------------------------------------------------------------------------

type Timer = ReturnType<typeof setTimeout>;

interface ActiveSustain {
  move: MoveEvent['move'];
  handle: SustainHandle;
  safetyTimer: Timer;
}

export class MoveAudio {
  private sustain: ActiveSustain | null = null;
  private charge: { handle: StopHandle; fallbackTimer: Timer } | null = null;
  /** In-flight coal lobs, oldest first (lobs resolve in launch order). */
  private coals: CoalHandle[] = [];

  constructor(private readonly engine: EngineLike) {}

  /** Route one gesture event to its sound. Never throws on odd input. */
  handleEvent(e: MoveEvent): void {
    switch (e.kind) {
      case 'trigger':
        this.onTrigger(e);
        return;
      case 'sustain-start':
        this.onSustainStart(e);
        return;
      case 'sustain-tick':
        this.onSustainTick(e);
        return;
      case 'sustain-end':
        this.onSustainEnd(e);
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Combat hooks (wired by the combat/director layer)
  // -------------------------------------------------------------------------

  /** Construct killed: the ceremonial taiko hit. */
  onKill(): void {
    this.engine.killHit();
  }

  /** Hit-stop began: duck the master for its duration. */
  onHitStop(ms: number): void {
    this.engine.duck(DUCK_AMOUNT, ms);
  }

  /** A tier-2 construct lobbed a coal; flightTime in seconds. */
  onCoalLob(flightTimeSec: number): void {
    this.coals.push(this.engine.coalWhistle(flightTimeSec));
  }

  /** The oldest in-flight coal hit the rising-flame wall. */
  onCoalBlocked(): void {
    this.resolveCoal(true);
  }

  /** The oldest in-flight coal landed unblocked. */
  onCoalLanded(): void {
    this.resolveCoal(false);
  }

  /** Stop everything held open and clear all timers. */
  dispose(): void {
    this.stopSustain();
    this.stopCharge();
    // In-flight whistles resolve silently: drop the handles, the engine's
    // own flight-length stop() bound ends them.
    this.coals = [];
  }

  // -------------------------------------------------------------------------
  // Event routing
  // -------------------------------------------------------------------------

  private onTrigger(e: MoveEvent): void {
    // Any real move consumes the breath charge, so its rumble resolves into
    // the empowered move's own sound.
    if (e.move !== 'breath-charge') this.stopCharge();

    switch (e.move) {
      case 'jab-blast':
        this.engine.jab(e.empowered);
        return;
      case 'cross-combo':
        this.engine.crossCombo();
        return;
      case 'twin-cannon':
        this.engine.twinCannon(e.empowered);
        return;
      case 'rising-flame':
        this.engine.risingFlame();
        return;
      case 'fire-whip':
        this.engine.whipCrack();
        return;
      case 'breath-charge': {
        this.stopCharge(); // a re-charge replaces the old rumble
        const handle = this.engine.breathCharge();
        const fallbackTimer = setTimeout(() => {
          this.charge = null;
          handle.stop();
        }, CHARGE_FALLBACK_MS);
        this.charge = { handle, fallbackTimer };
        return;
      }
      case 'fire-stream':
        // Sustained moves never arrive as plain triggers; ignore defensively.
        return;
    }
  }

  private onSustainStart(e: MoveEvent): void {
    if (e.move !== 'fire-stream') return;
    this.stopCharge(); // an empowered sustain consumes the charge too
    this.stopSustain(); // the engine allows one sustain at a time; mirror it
    const handle = this.engine.streamStart();
    handle.setIntensity(TICK_INTENSITY);
    this.sustain = {
      move: e.move,
      handle,
      safetyTimer: this.armSafety(),
    };
  }

  private onSustainTick(e: MoveEvent): void {
    const s = this.sustain;
    if (s === null || s.move !== e.move) return; // orphan tick, ignore
    s.handle.setIntensity(TICK_INTENSITY);
    clearTimeout(s.safetyTimer);
    s.safetyTimer = this.armSafety();
  }

  private onSustainEnd(e: MoveEvent): void {
    const s = this.sustain;
    if (s === null || s.move !== e.move) return; // already stopped, ignore
    this.stopSustain();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private armSafety(): Timer {
    return setTimeout(() => {
      // Ticks went silent without a sustain-end: stop the roar ourselves.
      const s = this.sustain;
      this.sustain = null;
      if (s !== null) s.handle.stop();
    }, SUSTAIN_SAFETY_MS);
  }

  private stopSustain(): void {
    const s = this.sustain;
    if (s === null) return;
    this.sustain = null;
    clearTimeout(s.safetyTimer);
    s.handle.stop();
  }

  private stopCharge(): void {
    const c = this.charge;
    if (c === null) return;
    this.charge = null;
    clearTimeout(c.fallbackTimer);
    c.handle.stop();
  }

  private resolveCoal(blocked: boolean): void {
    const coal = this.coals.shift();
    if (coal !== undefined) coal.land(blocked);
  }
}
