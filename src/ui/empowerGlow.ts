/**
 * Breath Charge empowerment glow (T062 juice, spec Section 7 move 9 and
 * Phase 6): while the charge is exposed (MoveEffects.chargeActive, the 3 s
 * empower window) a subtle warm vignette breathes at the screen edges and
 * the HUD breath bar frame picks up a faint ember glow (via the
 * fb-empower-active class on the arena root; see theme.css).
 *
 * DOM + CSS radial gradient only, no WebGL. The opacity math is a pure
 * exported function so the pulse and fade are headless-testable.
 */

import './theme.css';

/** Peak vignette opacity while empowered. Subtle by design. */
export const EMPOWER_GLOW_MAX_OPACITY = 0.15;
/** Breathing pulse rate while active, cycles per second. */
export const EMPOWER_GLOW_PULSE_HZ = 1.4;
/** Exponential fade rate toward the target opacity, per second. */
export const EMPOWER_GLOW_FADE_RATE = 6;

/**
 * Next opacity value: while active, approach a pulsing target around
 * EMPOWER_GLOW_MAX_OPACITY; while inactive, decay toward 0. Frame-rate
 * independent (exponential approach).
 */
export function empowerGlowOpacity(
  active: boolean,
  current: number,
  dt: number,
  tSec: number,
): number {
  const pulse = 0.7 + 0.3 * Math.sin(tSec * Math.PI * 2 * EMPOWER_GLOW_PULSE_HZ);
  const target = active ? EMPOWER_GLOW_MAX_OPACITY * pulse : 0;
  if (dt <= 0) return current;
  return current + (target - current) * (1 - Math.exp(-EMPOWER_GLOW_FADE_RATE * dt));
}

export class EmpowerGlow {
  private readonly el: HTMLDivElement;
  private opacity = 0;
  private t = 0;
  private wasActive = false;

  constructor(private readonly host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'fb-empower-glow';
    host.appendChild(this.el);
  }

  /** Call once per frame with wall-clock dt (glow ignores hit-stop). */
  update(active: boolean, dt: number): void {
    this.t += dt;
    this.opacity = empowerGlowOpacity(active, this.opacity, dt, this.t);
    this.el.style.opacity = this.opacity.toFixed(3);
    if (active !== this.wasActive) {
      this.wasActive = active;
      this.host.classList.toggle('fb-empower-active', active);
    }
  }

  dispose(): void {
    this.el.remove();
    this.host.classList.remove('fb-empower-active');
  }
}
