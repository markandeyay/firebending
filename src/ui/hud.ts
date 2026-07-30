/**
 * In-game HUD (T051, spec Sections 8 and 9): ink and parchment, DOM based,
 * no WebGL. Three pieces:
 *
 *   1. Breath meter, bottom left: an ink brush stroke drawn on a small
 *      canvas over a parchment backing with a muted gold frame. The stroke
 *      width follows the Breath value smoothly (exponential approach).
 *   2. Enemy health: a wax-seal indicator floated above the construct's
 *      screen-projected position. Crack lines are revealed in four stages as
 *      damage rises, and the seal shatters on death.
 *   3. Floating damage numbers: brush-styled plain numerals that spawn at
 *      the projected hit position, drift up and fade over 0.9 s. Empowered
 *      and twin hits render bigger in deeper vermilion. Spawn position is
 *      biased toward the side the player faces (head yaw, Section 8).
 *
 * three.js is deliberately kept OUT of this module: the combat/integration
 * layer projects world positions to screen pixels and passes plain numbers
 * (projectTo, damageNumber). Styling lives in src/ui/theme.css (--fb-*
 * palette custom properties).
 *
 * Headless testing: the pure parts (crackStageFor, approach,
 * sideBiasFromYaw, DamageNumberLedger) are exported and DOM-free. The HUD
 * class itself requires a DOM and throws early without one.
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

/**
 * Crack stage from damage percent (0..1): 0 pristine, then one more crack
 * for every 20% of damage taken, capped at 4. Death shatters regardless.
 */
export function crackStageFor(damagePercent: number): number {
  if (!Number.isFinite(damagePercent) || damagePercent <= 0) return 0;
  return Math.min(4, Math.floor(damagePercent * 5));
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

const BREATH_W = 240;
const BREATH_H = 26;
const BREATH_MAX = 100;
/** Redraw threshold, breath units; avoids repainting a static bar. */
const BREATH_REDRAW_EPS = 0.25;

/** Deterministic jitter for the brush-stroke edges (stable across redraws). */
function makeJitter(seed: number, count: number): number[] {
  let a = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out.push(((t ^ (t >>> 14)) >>> 0) / 4294967296);
  }
  return out;
}

const SEAL_SVG = `
<svg viewBox="0 0 64 64" aria-hidden="true">
  <circle cx="32" cy="32" r="26" style="fill: var(--fb-vermilion); stroke: var(--fb-gold); stroke-width: 2; opacity: 0.96;" />
  <circle cx="32" cy="32" r="19" style="fill: none; stroke: rgba(13, 10, 8, 0.4); stroke-width: 1.5;" />
  <circle cx="32" cy="32" r="6" style="fill: rgba(13, 10, 8, 0.28);" />
  <path class="fb-crack" d="M32 7 L29 17 L34 26 L31 32" />
  <path class="fb-crack" d="M56 36 L46 34 L39 38 L33 34" />
  <path class="fb-crack" d="M14 50 L22 43 L26 36 L31 33" />
  <path class="fb-crack" d="M44 55 L40 46 L34 41 L32 35" />
</svg>`;

export class HUD {
  private readonly root: HTMLDivElement;
  private readonly breathCanvas: HTMLCanvasElement;
  private readonly breathCtx: CanvasRenderingContext2D | null;
  private readonly sealEl: HTMLDivElement;
  private readonly crackEls: SVGPathElement[];
  private readonly flashEl: HTMLDivElement;
  private readonly jitter: number[];
  private readonly ledger = new DamageNumberLedger();

  private breathTarget = BREATH_MAX;
  private breathShown = BREATH_MAX;
  private lastDrawnBreath = -1;

  private construct: AttachedConstruct | null = null;
  private sealPlaced = false;
  private shattered = false;
  private shatterAge = 0;
  private lastCrackStage = -1;

  constructor(container: HTMLElement) {
    if (typeof document === 'undefined') {
      throw new Error('HUD requires a DOM; use the exported pure helpers headlessly.');
    }
    this.jitter = makeJitter(0x51ea1, 64);

    this.root = document.createElement('div');
    this.root.className = 'fb-hud';

    // Breath meter.
    const breathWrap = document.createElement('div');
    breathWrap.className = 'fb-breath';
    const label = document.createElement('div');
    label.className = 'fb-breath-label';
    label.textContent = 'BREATH';
    const frame = document.createElement('div');
    frame.className = 'fb-breath-frame';
    this.breathCanvas = document.createElement('canvas');
    this.breathCanvas.className = 'fb-breath-canvas';
    this.breathCanvas.width = BREATH_W * 2;
    this.breathCanvas.height = BREATH_H * 2;
    this.breathCtx = this.breathCanvas.getContext('2d');
    this.breathCtx?.scale(2, 2);
    frame.appendChild(this.breathCanvas);
    breathWrap.append(label, frame);

    // Wax-seal enemy health indicator.
    this.sealEl = document.createElement('div');
    this.sealEl.className = 'fb-seal-mark';
    this.sealEl.style.display = 'none';
    this.sealEl.innerHTML = SEAL_SVG;
    this.crackEls = Array.from(this.sealEl.querySelectorAll<SVGPathElement>('.fb-crack'));

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
    this.lastCrackStage = -1;
    this.sealEl.classList.remove('is-shattered');
    this.sealEl.style.display = 'none';
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
   * the brush feel comes from the display font and CSS weight only.
   */
  damageNumber(x: number, y: number, amount: number, opts?: DamageNumberOptions): void {
    const bias = opts?.side ?? sideBiasFromYaw(opts?.faceYaw ?? 0);
    const el = document.createElement('span');
    el.className = opts?.empowered ? 'fb-dmg fb-dmg--emp' : 'fb-dmg';
    el.textContent = String(Math.max(1, Math.round(amount)));
    el.style.left = `${x + bias * SIDE_BIAS_MAX_PX}px`;
    el.style.top = `${y}px`;
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
        for (const crack of this.crackEls) crack.classList.add('is-open');
        if (this.sealPlaced) this.sealEl.classList.add('is-shattered');
      }
      this.shatterAge += dt;
      if (this.shatterAge >= SEAL_SHATTER_SECONDS) {
        this.sealEl.style.display = 'none';
      }
      return;
    }
    const stage = crackStageFor(c.damagePercent);
    if (stage !== this.lastCrackStage) {
      this.lastCrackStage = stage;
      this.crackEls.forEach((crack, i) => {
        crack.classList.toggle('is-open', i < stage);
      });
    }
  }

  dispose(): void {
    this.ledger.clear();
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Brush stroke rendering
  // -------------------------------------------------------------------------

  private drawBreath(): void {
    const ctx = this.breathCtx;
    if (!ctx) return;
    this.lastDrawnBreath = this.breathShown;
    const w = BREATH_W;
    const h = BREATH_H;
    ctx.clearRect(0, 0, w, h);
    const fraction = Math.max(0, Math.min(1, this.breathShown / BREATH_MAX));
    if (fraction <= 0.01) return;

    const pad = 3;
    const barW = (w - pad * 2) * fraction;
    const midY = h / 2;
    const body = h * 0.32;
    // Ink darkens the parchment; near-empty Breath warms toward vermilion.
    ctx.fillStyle = fraction < 0.25 ? '#5e2417' : '#221a14';

    const steps = Math.max(2, Math.floor(barW / 7));
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const x = pad + barW * u;
      const taper = u > 0.82 ? 1 - ((u - 0.82) / 0.18) * 0.7 : 1;
      const j = this.jitter[(i * 2) % this.jitter.length] ?? 0.5;
      const yTop = midY - body * taper - (j - 0.5) * 5;
      if (i === 0) ctx.moveTo(x, yTop);
      else ctx.lineTo(x, yTop);
    }
    for (let i = steps; i >= 0; i--) {
      const u = i / steps;
      const x = pad + barW * u;
      const taper = u > 0.82 ? 1 - ((u - 0.82) / 0.18) * 0.7 : 1;
      const j = this.jitter[(i * 2 + 1) % this.jitter.length] ?? 0.5;
      ctx.lineTo(x, midY + body * taper + (j - 0.5) * 5);
    }
    ctx.closePath();
    ctx.fill();

    // Dry-brush streaks near the stroke's tip.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 0.45;
    for (let s = 0; s < 3; s++) {
      const j = this.jitter[(steps + s * 5) % this.jitter.length] ?? 0.5;
      const y = midY + (j - 0.5) * body * 1.6;
      ctx.fillRect(pad + barW * 0.7, y, barW * 0.3, 1.1);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
