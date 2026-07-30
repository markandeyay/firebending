/**
 * Title screen (spec Section 8): black lacquer background with a subtle
 * firelit vignette, faint drifting embers on a 2D canvas, the FIREBENDING
 * wordmark, a wax seal Play button, and the privacy line. The Play button
 * fires the onPlay callback; the orchestrator wires camera permission and
 * the calibration transition.
 */

import type { Screen } from './screenManager';
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
const EMBER_COUNT = 34;

function makeEmber(width: number, height: number, anywhere: boolean): Ember {
  return {
    x: Math.random() * width,
    y: anywhere ? Math.random() * height : height + 8,
    radius: 0.8 + Math.random() * 1.5,
    rise: 9 + Math.random() * 16,
    sway: 0.25 + Math.random() * 0.5,
    flicker: 1.2 + Math.random() * 2.4,
    phase: Math.random() * Math.PI * 2,
    baseAlpha: 0.18 + Math.random() * 0.32,
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

    const stack = document.createElement('div');
    stack.className = 'fb-title-stack';
    root.appendChild(stack);

    const wordmark = document.createElement('h1');
    wordmark.className = 'fb-wordmark';
    wordmark.textContent = 'FIREBENDING';
    stack.appendChild(wordmark);

    const play = document.createElement('button');
    play.className = 'fb-seal-btn';
    play.type = 'button';
    play.textContent = 'PLAY';
    play.addEventListener('click', () => {
      if (this.fired) return;
      this.fired = true;
      this.options.onPlay();
    });
    stack.appendChild(play);

    const privacy = document.createElement('p');
    privacy.className = 'fb-smallprint';
    privacy.textContent = 'Your camera never leaves your device.';
    stack.appendChild(privacy);

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

  /** Sparse warm embers, slow upward drift with flicker. Canvas 2D only. */
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
        e.x += Math.sin(tSec * e.sway + e.phase) * 6 * dt;
        if (e.y < -10 || e.x < -10 || e.x > width + 10) {
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
