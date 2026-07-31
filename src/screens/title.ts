/**
 * Title screen (spec Section 8, P6 redesign): a film title card cut like a
 * woodblock print. Deep near-black field, a single vertical axis hairline on
 * the left, the wordmark set low-left against it (FIREBENDING large over a
 * vermilion stroke and a wide-tracked SIMULATOR), an understated ink menu
 * (Begin, Recalibrate), and a hanging oxblood temple banner on the right with
 * a narrow column of drifting embers as the one moving accent.
 *
 * Contract: "Begin" fires onPlay inside the click gesture (audio unlock and
 * seal-press happen in the orchestrator's callback). "Recalibrate" clears the
 * stored motion profile first, so the calibration ritual runs its full
 * punch/push capture again, then starts the same flow.
 */

import type { Screen } from './screenManager';
import { clearProfile } from '../gestures/profile';
import '../ui/theme.css';

export interface TitleScreenOptions {
  onPlay: () => void;
}

interface Ember {
  x: number;
  y: number;
  radius: number;
  /** Upward drift in px/sec. */
  rise: number;
  /** Horizontal sway frequency in rad/sec. */
  sway: number;
  /** Flicker frequency in rad/sec. */
  flicker: number;
  phase: number;
  baseAlpha: number;
  color: string;
}

const EMBER_COLORS = ['#e0a458', '#c9772e', '#a85a22', '#8a2f1d'] as const;
/** A sparse column, not a field: the embers live along the banner only. */
const EMBER_COUNT = 44;
/** Ember column bounds as fractions of viewport width (around the banner). */
const BAND_LEFT = 0.74;
const BAND_RIGHT = 0.9;
/** Embers are born near the banner's swallowtail hem and drift upward. */
const HEM_TOP = 0.62;
const HEM_BOTTOM = 0.78;

function makeEmber(width: number, height: number, anywhere: boolean): Ember {
  const bandX =
    width * BAND_LEFT + Math.random() * width * (BAND_RIGHT - BAND_LEFT);
  return {
    x: bandX,
    y: anywhere
      ? Math.random() * height * HEM_BOTTOM
      : height * (HEM_TOP + Math.random() * (HEM_BOTTOM - HEM_TOP)),
    radius: 0.9 + Math.random() * 1.9,
    rise: 10 + Math.random() * 16,
    sway: 0.25 + Math.random() * 0.5,
    flicker: 1.2 + Math.random() * 2.4,
    phase: Math.random() * Math.PI * 2,
    baseAlpha: 0.3 + Math.random() * 0.38,
    color:
      EMBER_COLORS[Math.floor(Math.random() * EMBER_COLORS.length)] ??
      EMBER_COLORS[0],
  };
}

export class TitleScreen implements Screen {
  private raf: number | null = null;
  private cleanups: Array<() => void> = [];
  private fired = false;

  constructor(private readonly options: TitleScreenOptions) {}

  enter(root: HTMLElement): void {
    this.fired = false;
    root.classList.add('fb-title');

    const canvas = document.createElement('canvas');
    canvas.className = 'fb-title-embers';
    root.appendChild(canvas);

    // Vertical axis hairline: the printing-block edge everything hangs on.
    const axis = document.createElement('div');
    axis.className = 'fb-title-axis';
    root.appendChild(axis);

    // Hanging temple banner, the composition's counterweight on the right.
    const banner = document.createElement('div');
    banner.className = 'fb-title-banner';
    root.appendChild(banner);

    const block = document.createElement('div');
    block.className = 'fb-title-block';
    root.appendChild(block);

    const mark = document.createElement('h1');
    mark.className = 'fb-title-mark';
    mark.setAttribute('aria-label', 'FIREBENDING SIMULATOR');
    const fire = document.createElement('span');
    fire.className = 'fb-title-fire';
    fire.setAttribute('aria-hidden', 'true');
    fire.textContent = 'FIREBENDING';
    // One span per letter so the word justifies edge to edge across the
    // vermilion bar, locked to the same measure as FIREBENDING.
    const sim = document.createElement('span');
    sim.className = 'fb-title-sim';
    sim.setAttribute('aria-hidden', 'true');
    for (const ch of 'SIMULATOR') {
      const letter = document.createElement('span');
      letter.textContent = ch;
      sim.appendChild(letter);
    }
    mark.appendChild(fire);
    mark.appendChild(sim);
    block.appendChild(mark);

    const menu = document.createElement('nav');
    menu.className = 'fb-title-menu';
    block.appendChild(menu);

    const begin = this.menuItem('Begin', () => {
      this.options.onPlay();
    });
    menu.appendChild(begin);

    const recal = this.menuItem('Recalibrate', () => {
      // Forget the stored motion profile, then the same flow: the ritual
      // notices the missing profile and runs its capture steps again.
      clearProfile();
      this.options.onPlay();
    });
    menu.appendChild(recal);

    const privacy = document.createElement('p');
    privacy.className = 'fb-smallprint fb-title-privacy';
    privacy.textContent = 'Your camera never leaves your device.';
    root.appendChild(privacy);

    this.startEmbers(root, canvas);
  }

  exit(): void {
    if (this.raf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.raf);
    }
    this.raf = null;
    for (const fn of this.cleanups) fn();
    this.cleanups = [];
  }

  /** Understated ink menu entry. Semantically a button, visually set type. */
  private menuItem(label: string, action: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'fb-menu-item';
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (this.fired) return;
      this.fired = true;
      action();
    });
    return btn;
  }

  /** Sparse warm embers in a narrow column by the banner. Canvas 2D only. */
  private startEmbers(root: HTMLElement, canvas: HTMLCanvasElement): void {
    if (typeof requestAnimationFrame !== 'function') return;
    const g = canvas.getContext('2d');
    if (!g) return;

    let width = 0;
    let height = 0;

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = root.clientWidth || window.innerWidth;
      height = root.clientHeight || window.innerHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);
    this.cleanups.push(() => window.removeEventListener('resize', resize));

    const embers: Ember[] = [];
    for (let i = 0; i < EMBER_COUNT; i++) {
      embers.push(makeEmber(width, height, true));
    }

    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const tSec = now / 1000;

      g.clearRect(0, 0, width, height);
      for (const e of embers) {
        e.y -= e.rise * dt;
        e.x += Math.sin(tSec * e.sway + e.phase) * 5 * dt;
        if (e.y < -10 || e.x < width * BAND_LEFT - 30 || e.x > width * BAND_RIGHT + 30) {
          Object.assign(e, makeEmber(width, height, false));
        }
        const flicker = 0.55 + 0.45 * Math.sin(tSec * e.flicker + e.phase);
        g.globalAlpha = e.baseAlpha * flicker;
        g.fillStyle = e.color;
        g.beginPath();
        g.arc(e.x, e.y, e.radius, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
}
