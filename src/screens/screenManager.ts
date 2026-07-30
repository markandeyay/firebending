/**
 * Screen state machine. Screens (title, calibration, arena) register by name;
 * show() swaps them with async enter/exit hooks and an optional transition
 * (the flame wipe). Each screen gets its own root element layered over the
 * WebGL canvas.
 *
 * The state logic is DOM-free so it runs headless under Vitest: DOM access is
 * confined to the default layer factory and flameWipe, both of which are
 * replaceable or guarded. Tests supply a createLayer stub.
 */

export type ScreenName = 'title' | 'calibration' | 'arena';

export interface Screen {
  /** Called when the screen becomes active. root is the screen's own layer. */
  enter(root: HTMLElement, ctx?: unknown): void | Promise<void>;
  /** Called before the screen is torn down. */
  exit(root: HTMLElement): void | Promise<void>;
}

/**
 * A transition wraps the swap: it should cover the screen, await swap()
 * (which runs old.exit and new.enter under cover), then reveal.
 */
export type ScreenTransition = (
  host: HTMLElement | null,
  swap: () => Promise<void>,
) => Promise<void>;

export interface ScreenManagerOptions {
  /** Parent element that screen layers mount into (the UI layer over the canvas). */
  host?: HTMLElement;
  /** Transition run when replacing an existing screen. First show is instant. */
  transition?: ScreenTransition;
  /** Layer factory override for headless tests. Defaults to a styled div. */
  createLayer?: () => HTMLElement;
}

interface ActiveScreen {
  name: ScreenName;
  screen: Screen;
  root: HTMLElement;
}

export class ScreenManager {
  private readonly screens = new Map<ScreenName, Screen>();
  private active: ActiveScreen | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ScreenManagerOptions = {}) {}

  register(name: ScreenName, screen: Screen): void {
    this.screens.set(name, screen);
  }

  get current(): ScreenName | null {
    return this.active ? this.active.name : null;
  }

  /**
   * Switch to a screen. Calls are serialized: a show() issued during a
   * transition runs after it settles. Showing the already-active screen is a
   * no-op.
   */
  show(name: ScreenName, ctx?: unknown): Promise<void> {
    const screen = this.screens.get(name);
    if (!screen) {
      return Promise.reject(new Error(`Screen not registered: ${name}`));
    }

    const run = this.queue.then(async () => {
      if (this.active && this.active.name === name) return;
      const prev = this.active;

      const swap = async (): Promise<void> => {
        if (prev) {
          await prev.screen.exit(prev.root);
          prev.root.remove?.();
        }
        const root = this.makeLayer();
        this.options.host?.appendChild(root);
        this.active = { name, screen, root };
        await screen.enter(root, ctx);
      };

      if (this.options.transition && prev) {
        await this.options.transition(this.options.host ?? null, swap);
      } else {
        await swap();
      }
    });

    // Keep the queue alive even if this show rejects; the caller still
    // receives the rejection through the returned promise.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private makeLayer(): HTMLElement {
    if (this.options.createLayer) return this.options.createLayer();
    if (typeof document === 'undefined') {
      throw new Error('ScreenManager needs a DOM or a createLayer option');
    }
    const el = document.createElement('div');
    el.className = 'fb-screen-layer';
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.overflow = 'hidden';
    return el;
  }
}

// ---------------------------------------------------------------------------
// Flame wipe transition
// ---------------------------------------------------------------------------

export const FLAME_WIPE_MS = 700;

/** Warm ember/charcoal palette for the wipe rim. Firelight only. */
const RIM_COLORS = ['#e0a458', '#c9772e', '#8a2f1d'] as const;
const COVER_COLOR = '#0d0a08';

/**
 * Full-screen ember/ink radial wipe in canvas 2D, no WebGL. A charcoal disc
 * with a flickering ember rim slams outward to cover the screen (fast,
 * weighty ease-in), atCover runs under full cover (the manager swaps screens
 * there), then the cover burns open from the center to reveal the new screen.
 * Roughly FLAME_WIPE_MS total. Headless-safe: without a DOM it just runs
 * atCover and resolves.
 */
export async function flameWipe(
  host: HTMLElement,
  atCover?: () => void | Promise<void>,
): Promise<void> {
  if (
    typeof document === 'undefined' ||
    typeof requestAnimationFrame === 'undefined'
  ) {
    if (atCover) await atCover();
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.zIndex = '999';
  canvas.style.pointerEvents = 'none';
  host.appendChild(canvas);

  const g = canvas.getContext('2d');
  if (!g) {
    canvas.remove();
    if (atCover) await atCover();
    return;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = host.clientWidth || window.innerWidth;
  const h = host.clientHeight || window.innerHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  g.scale(dpr, dpr);

  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.hypot(cx, cy) + 48;
  const half = FLAME_WIPE_MS / 2;

  const drawRim = (r: number, tMs: number): void => {
    const count = 46;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const jitter =
        Math.sin(i * 12.9898 + tMs * 0.02) * 7 +
        Math.sin(i * 4.7 + tMs * 0.007) * 4;
      const rr = Math.max(0, r + jitter);
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      const size = 1.4 + ((i * 31) % 5) * 0.55;
      g.globalAlpha = 0.3 + 0.45 * Math.abs(Math.sin(i * 3.3 + tMs * 0.03));
      g.fillStyle = RIM_COLORS[i % RIM_COLORS.length] ?? RIM_COLORS[0];
      g.beginPath();
      g.arc(x, y, size, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(201, 119, 46, 0.5)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
    g.stroke();
  };

  const animate = (
    durationMs: number,
    draw: (p: number, tMs: number) => void,
  ): Promise<void> =>
    new Promise((resolve) => {
      const start = performance.now();
      const step = (now: number): void => {
        // rAF timestamps can predate the performance.now() captured above;
        // an unclamped negative p maps through the reveal ease to a negative
        // arc radius, which throws and kills the transition.
        const p = Math.min(1, Math.max(0, (now - start) / durationMs));
        draw(p, now);
        if (p < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });

  // Cover: accelerating slam outward.
  await animate(half, (p, tMs) => {
    const e = p * p;
    const r = maxR * e;
    g.clearRect(0, 0, w, h);
    g.fillStyle = COVER_COLOR;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    drawRim(r, tMs);
  });

  // Full cover while the manager swaps screens underneath.
  g.clearRect(0, 0, w, h);
  g.fillStyle = COVER_COLOR;
  g.fillRect(0, 0, w, h);
  if (atCover) await atCover();

  // Reveal: the cover burns open from the center, decelerating.
  await animate(half, (p, tMs) => {
    const e = 1 - (1 - p) * (1 - p) * (1 - p);
    const r = maxR * e;
    g.clearRect(0, 0, w, h);
    g.fillStyle = COVER_COLOR;
    g.fillRect(0, 0, w, h);
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.restore();
    drawRim(r, tMs);
  });

  canvas.remove();
}

/** Ready-to-wire ScreenManager transition built on flameWipe. */
export const flameWipeTransition: ScreenTransition = (host, swap) =>
  host ? flameWipe(host, swap) : swap();
