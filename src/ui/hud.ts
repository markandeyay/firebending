/**
 * In-game HUD (T051, spec Sections 8 and 9): ink and parchment, DOM based,
 * no WebGL. Three pieces:
 *
 *   1. Breath meter, bottom left: a clean horizontal brush-stroke bar in
 *      deep charcoal ink on a parchment track (tapered right end via
 *      asymmetric border-radius). The fill follows the Breath value smoothly
 *      (exponential approach); below LOW_BREATH_THRESHOLD the stroke tip
 *      warms to ember and pulses gently.
 *   2. Enemy health: a small cracked wax seal floated just above the
 *      construct's head. Pure CSS (radial gradients + inset shadows): deep
 *      vermilion wax, embossed ring, a stamped ember glyph. Damage reveals
 *      1/2/3 crack lines at <75/50/25% hp (setSealDamage, is-cracked-N
 *      classes) with a squash-pop when the crack level rises, and the seal
 *      shatters on death.
 *   3. Floating damage numbers: brush-styled plain numerals that spawn at
 *      the projected hit position with a scale-pop entrance and a small
 *      deterministic rotation jitter, drift up and fade over 0.9 s.
 *      Empowered and twin hits render bigger in muted gold.
 *
 * three.js is deliberately kept OUT of this module: the combat/integration
 * layer projects world positions to screen pixels and passes plain numbers
 * (projectTo, setSealDamage, damageNumber). Styling lives in
 * src/ui/theme.css (--fb-* palette custom properties).
 *
 * Headless testing: the pure parts (sealCrackLevel, approach,
 * sideBiasFromYaw, damageNumberRotationDeg, DamageNumberLedger) are exported
 * and DOM-free. The HUD class itself requires a DOM and throws early
 * without one.
 */

// ---------------------------------------------------------------------------
// Pure helpers (headless testable)
// ---------------------------------------------------------------------------

/** Damage number lifetime, seconds. Matches the fb-dmg-rise CSS animation. */
export const DAMAGE_NUMBER_SECONDS = 0.9;

/** Head yaw (radians) at which the damage-number side bias saturates. */
export const SIDE_BIAS_FULL_YAW_RAD = 0.35;

/** Horizontal spawn offset at full side bias, pixels. */
export const SIDE_BIAS_MAX_PX = 56;

/** Seal shatter animation length, seconds. Matches fb-seal-shatter CSS. */
export const SEAL_SHATTER_SECONDS = 0.65;

/** Below this Breath value the ink stroke's tip warms to ember and pulses. */
export const LOW_BREATH_THRESHOLD = 30;

/** Damage-number rotation jitter bound, degrees (deterministic per spawn). */
export const DAMAGE_NUMBER_JITTER_DEG = 4;

/**
 * Seal crack level from the damage fraction (0..1): one crack line each time
 * the construct drops below 75/50/25% hp (damage above 0.25/0.5/0.75),
 * capped at 3. Death shatters the seal regardless.
 */
export function sealCrackLevel(damageFraction: number): number {
  if (!Number.isFinite(damageFraction)) return 0;
  if (damageFraction > 0.75) return 3;
  if (damageFraction > 0.5) return 2;
  if (damageFraction > 0.25) return 1;
  return 0;
}

/**
 * Deterministic damage-number rotation for spawn `seq` (a running counter):
 * an integer sweep across [-JITTER, +JITTER] degrees that never repeats on
 * consecutive spawns. Pure, for tests and the HUD alike.
 */
export function damageNumberRotationDeg(seq: number): number {
  const span = DAMAGE_NUMBER_JITTER_DEG * 2 + 1;
  return ((Math.abs(seq) * 5) % span) - DAMAGE_NUMBER_JITTER_DEG;
}

/**
 * Frame-rate independent exponential approach of current toward target.
 * Used for the breath bar so the ink stroke follows the value smoothly.
 */
export function approach(current: number, target: number, dt: number, rate = 8): number {
  if (dt <= 0 || rate <= 0) return current;
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/**
 * Signed side bias (-1..1) from head yaw (radians, positive = player looks
 * to their right). Damage numbers spawn offset toward that side (Section 8).
 */
export function sideBiasFromYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  return Math.max(-1, Math.min(1, yaw / SIDE_BIAS_FULL_YAW_RAD));
}

/**
 * DOM-free lifecycle bookkeeping for floating damage numbers: entries age
 * with update(dt) and fire their onExpire callback (element removal in the
 * HUD) when their duration elapses.
 */
export class DamageNumberLedger {
  private entries: Array<{ age: number; duration: number; onExpire: (() => void) | null }> = [];

  get count(): number {
    return this.entries.length;
  }

  spawn(duration: number = DAMAGE_NUMBER_SECONDS, onExpire?: () => void): void {
    this.entries.push({ age: 0, duration, onExpire: onExpire ?? null });
  }

  update(dt: number): void {
    const remaining: typeof this.entries = [];
    for (const entry of this.entries) {
      entry.age += dt;
      if (entry.age >= entry.duration) entry.onExpire?.();
      else remaining.push(entry);
    }
    this.entries = remaining;
  }

  /** Expire everything immediately (dispose path). */
  clear(): void {
    const expiring = this.entries;
    this.entries = [];
    for (const entry of expiring) entry.onExpire?.();
  }
}

// ---------------------------------------------------------------------------
// HUD (DOM)
// ---------------------------------------------------------------------------

/** The slice of a Construct the HUD needs (duck-typed, no game import). */
export interface AttachedConstruct {
  readonly damagePercent: number;
  readonly isAlive: boolean;
}

export interface DamageNumberOptions {
  /** Bigger, deeper vermilion styling (empowered and twin hits). */
  empowered?: boolean;
  /** Head yaw in radians; converted via sideBiasFromYaw. */
  faceYaw?: number;
  /** Explicit side bias -1..1; overrides faceYaw when provided. */
  side?: number;
}

const BREATH_MAX = 100;
/** Redraw threshold, breath units; avoids restyling a static bar. */
const BREATH_REDRAW_EPS = 0.25;
/** Seal crack-level classes, index = level (0 = pristine, no class). */
const SEAL_CRACK_CLASSES = ['', 'is-cracked-1', 'is-cracked-2', 'is-cracked-3'] as const;

export class HUD {
  private readonly root: HTMLDivElement;
  private readonly breathFill: HTMLDivElement;
  private readonly sealEl: HTMLDivElement;
  private readonly flashEl: HTMLDivElement;
  private readonly ledger = new DamageNumberLedger();

  private breathTarget = BREATH_MAX;
  private breathShown = BREATH_MAX;
  private lastDrawnBreath = -1;
  private breathLow = false;

  private construct: AttachedConstruct | null = null;
  private sealPlaced = false;
  private shattered = false;
  private shatterAge = 0;
  private sealLevel = 0;
  private dmgSeq = 0;

  constructor(container: HTMLElement) {
    if (typeof document === 'undefined') {
      throw new Error('HUD requires a DOM; use the exported pure helpers headlessly.');
    }

    this.root = document.createElement('div');
    this.root.className = 'fb-hud';

    // Breath meter: parchment track, charcoal ink stroke.
    const breathWrap = document.createElement('div');
    breathWrap.className = 'fb-breath';
    const label = document.createElement('div');
    label.className = 'fb-breath-label';
    label.textContent = 'BREATH';
    const track = document.createElement('div');
    track.className = 'fb-breath-track';
    this.breathFill = document.createElement('div');
    this.breathFill.className = 'fb-breath-fill';
    track.appendChild(this.breathFill);
    breathWrap.append(label, track);

    // Cracked wax seal enemy health indicator (pure CSS, see theme.css).
    this.sealEl = document.createElement('div');
    this.sealEl.className = 'fb-seal-mark';
    this.sealEl.style.display = 'none';
    for (let i = 1; i <= 3; i++) {
      const crack = document.createElement('div');
      crack.className = `fb-seal-crack fb-seal-crack--${i}`;
      this.sealEl.appendChild(crack);
    }

    // Player-hit screen-edge flash.
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'fb-hit-flash';

    this.root.append(this.flashEl, breathWrap, this.sealEl);
    container.appendChild(this.root);
    this.drawBreath();
  }

  // -------------------------------------------------------------------------
  // Breath
  // -------------------------------------------------------------------------

  /** Set the Breath value 0..100; the bar animates toward it in update(). */
  setBreath(v: number): void {
    this.breathTarget = Math.max(0, Math.min(BREATH_MAX, v));
  }

  /** The smoothed value currently displayed (for debugging and tuning). */
  get displayedBreath(): number {
    return this.breathShown;
  }

  // -------------------------------------------------------------------------
  // Enemy health seal
  // -------------------------------------------------------------------------

  /** Attach the construct whose health the seal reflects (null to hide). */
  attachConstruct(c: AttachedConstruct | null): void {
    this.construct = c;
    this.shattered = false;
    this.shatterAge = 0;
    this.sealPlaced = false;
    this.sealLevel = 0;
    this.sealEl.classList.remove(
      'is-shattered',
      'is-pop',
      'is-cracked-1',
      'is-cracked-2',
      'is-cracked-3',
    );
    this.sealEl.style.display = 'none';
  }

  /**
   * Reflect the construct's damage fraction (0..1) on the seal: crack lines
   * appear at <75/50/25% hp with a small squash-pop each time the crack
   * level rises. The integration layer wires this from the construct's hp.
   */
  setSealDamage(fraction: number): void {
    const level = sealCrackLevel(fraction);
    if (level === this.sealLevel) return;
    const rose = level > this.sealLevel;
    this.sealLevel = level;
    this.sealEl.classList.remove('is-cracked-1', 'is-cracked-2', 'is-cracked-3');
    const cls = SEAL_CRACK_CLASSES[level];
    if (cls) this.sealEl.classList.add(cls);
    if (rose && level > 0) {
      this.sealEl.classList.remove('is-pop');
      // Force a reflow so back-to-back crack steps restart the pop.
      void this.sealEl.offsetWidth;
      this.sealEl.classList.add('is-pop');
    }
  }

  /** Current seal crack level 0..3 (bookkeeping view, for tuning). */
  get sealCrackLevelShown(): number {
    return this.sealLevel;
  }

  /**
   * Position the seal at the construct's screen-projected position, in
   * pixels relative to the HUD container. The integration layer performs the
   * world-to-screen projection; the HUD never touches three.js. Pass
   * visible = false while the construct is off screen.
   */
  projectTo(screenX: number, screenY: number, visible = true): void {
    if (!this.construct || !visible) {
      this.sealPlaced = false;
      this.sealEl.style.display = 'none';
      return;
    }
    this.sealPlaced = true;
    this.sealEl.style.left = `${screenX}px`;
    this.sealEl.style.top = `${screenY}px`;
    if (!this.shattered || this.shatterAge < SEAL_SHATTER_SECONDS) {
      this.sealEl.style.display = 'block';
    }
  }

  // -------------------------------------------------------------------------
  // Damage numbers
  // -------------------------------------------------------------------------

  /**
   * Spawn a floating damage number at screen pixel (x, y). Plain numerals;
   * the brush feel comes from the display font and CSS weight only. Each
   * spawn gets a scale-pop entrance and a small deterministic rotation
   * jitter (counter-seeded, so replays render identically).
   */
  damageNumber(x: number, y: number, amount: number, opts?: DamageNumberOptions): void {
    const bias = opts?.side ?? sideBiasFromYaw(opts?.faceYaw ?? 0);
    const el = document.createElement('span');
    el.className = opts?.empowered ? 'fb-dmg fb-dmg--emp' : 'fb-dmg';
    el.textContent = String(Math.max(1, Math.round(amount)));
    el.style.left = `${x + bias * SIDE_BIAS_MAX_PX}px`;
    el.style.top = `${y}px`;
    el.style.setProperty('--fb-dmg-rot', `${damageNumberRotationDeg(this.dmgSeq++)}deg`);
    this.root.appendChild(el);
    this.ledger.spawn(DAMAGE_NUMBER_SECONDS, () => el.remove());
  }

  /** Live damage numbers on screen (bookkeeping view, for tuning). */
  get activeDamageNumbers(): number {
    return this.ledger.count;
  }

  // -------------------------------------------------------------------------
  // Player hit feedback
  // -------------------------------------------------------------------------

  /** Brief warm screen-edge flash; wire to CombatSystem deps.onPlayerHit. */
  playerHitFlash(): void {
    this.flashEl.classList.remove('is-on');
    // Force a reflow so a rapid second hit restarts the animation.
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add('is-on');
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt: number): void {
    // Breath stroke follows the target smoothly; redraw only on real change.
    this.breathShown = approach(this.breathShown, this.breathTarget, dt);
    if (Math.abs(this.breathShown - this.lastDrawnBreath) > BREATH_REDRAW_EPS) {
      this.drawBreath();
    }

    this.ledger.update(dt);

    const c = this.construct;
    if (!c) return;
    if (!c.isAlive) {
      if (!this.shattered) {
        this.shattered = true;
        this.shatterAge = 0;
        // All cracks open as the wax lets go.
        this.sealEl.classList.remove('is-cracked-1', 'is-cracked-2', 'is-pop');
        this.sealEl.classList.add('is-cracked-3');
        if (this.sealPlaced) this.sealEl.classList.add('is-shattered');
      }
      this.shatterAge += dt;
      if (this.shatterAge >= SEAL_SHATTER_SECONDS) {
        this.sealEl.style.display = 'none';
      }
      return;
    }
    // Crack level follows the attached construct even without explicit
    // setSealDamage wiring (the integration layer may also call it).
    this.setSealDamage(c.damagePercent);
  }

  dispose(): void {
    this.ledger.clear();
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Brush stroke rendering
  // -------------------------------------------------------------------------

  /** Restyle the ink stroke: width from the smoothed value, ember tip low. */
  private drawBreath(): void {
    this.lastDrawnBreath = this.breathShown;
    const fraction = Math.max(0, Math.min(1, this.breathShown / BREATH_MAX));
    this.breathFill.style.width = `${(fraction * 100).toFixed(1)}%`;
    const low = this.breathShown < LOW_BREATH_THRESHOLD;
    if (low !== this.breathLow) {
      this.breathLow = low;
      this.breathFill.classList.toggle('is-low', low);
    }
  }
}
