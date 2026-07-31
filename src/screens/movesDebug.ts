/**
 * Moves debug scene (Phase 2 exit criterion): prints MoveEvents with latency
 * stats. Draws the filtered hand skeletons (same visual language as the
 * tracking overlay: charcoal backdrop, warm amber, parchment text) plus:
 *
 * - Event log (right): the last 12 MoveEvents. Sustained moves collapse to a
 *   single line whose tick count updates live and which closes on sustain-end.
 * - Pose-score bars (left): fist/palm/grip per hand plus the Breath meter,
 *   read from the MoveEngine getters every frame.
 * - Aim arrows: each trigger/tick draws a short fading arrow from the wrist
 *   along the aim's screen-space direction (a ring when the aim is mostly
 *   toward the camera, i.e. dominated by -z).
 * - Latency footer: per move, count + mean + max triggerLatencyMs for the
 *   whole session.
 *
 * Input pipeline matches gameplay exactly: frames pass through FilteredSource
 * (confidence gating + One Euro smoothing) before reaching the MoveEngine.
 * Default source cycles through all 10 positive synthetic fixtures forever,
 * with a fresh FilteredSource and MoveEngine per fixture pass so no cooldown,
 * combo, or filter state bleeds across fixtures (and, for a pinned fixture,
 * across loops; each pass restarts t at 0 in its own fresh pipeline, so the
 * monotonic-t concern the tracking overlay's LoopingReplaySource solves does
 * not arise here). The live camera path stays behind opts.live and is loaded
 * via dynamic import so MediaPipe never enters the replay module graph.
 *
 * Pure helpers (formatEventLine, LatencyStats, nextFixture) are exported for
 * headless tests; all DOM access stays inside mountMovesDebug so this module
 * imports cleanly in node.
 */

import type { HandFrame, LandmarkFrame, Vec3 } from '../tracking/types';
import { LM } from '../tracking/types';
import { FilteredSource } from '../tracking/filters';
import { ReplaySource } from '../tracking/replaySource';
import { MoveEngine, BREATH_MAX } from '../gestures/moves';
import type { MoveEvent, PoseScores } from '../gestures/moves';
import { boneList, projectToCanvas } from './trackingDebug';

// ---------------------------------------------------------------------------
// Palette (Section 2: warm firelight only, no neon)
// ---------------------------------------------------------------------------

const COLOR_BACKDROP = '#1a1512';
const COLOR_AMBER = '#ff8a3c';
const COLOR_GOLD = '#c9a227';
const COLOR_EMPOWERED = '#ffd27a';
const COLOR_TEXT = '#d8c8a8';
const COLOR_DIM = '#5a5248';
const COLOR_BAR_BG = '#2a231c';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Replay-path velocity compensation. The motion thresholds (DEFAULT_PROFILE
 * derived) are tuned on RAW fixture frames, but this scene feeds the engine
 * FILTERED frames exactly as the game will. With the retuned One Euro
 * defaults (beta 4.0, dCutoff 4.0 in tracking/filters.ts) the filter costs a
 * synthetic thrust only ~4..5% of its peak windowed wrist speed (measured:
 * raw ~1.45..1.65 u/s vs filtered ~1.38..1.58; the 3-frame spike harness in
 * tests/oneEuroResponse.test.ts measures ~1.5%). 1.1 restores that loss with
 * a little headroom; all 10 positive fixtures fire and every negative
 * fixture stays silent through the filtered pipeline. The live path does NOT
 * use this: per-player scaling belongs to calibrationStats.
 */
export const REPLAY_VELOCITY_SCALE = 1.1;

/**
 * The 10 positive fixtures, in cycle order. The palm-wave and flame-fan
 * recordings are kept: since the 7-move simplification they are thrust
 * motions and must fire jab-blast and fire-stream respectively.
 */
export const POSITIVE_FIXTURES: readonly string[] = [
  'jab-left',
  'jab-right',
  'fire-stream',
  'cross-combo',
  'palm-wave',
  'flame-fan',
  'twin-cannon',
  'rising-flame',
  'fire-whip',
  'breath-charge',
];

/**
 * The fixture that plays after `current` in the default cycle. Wraps at the
 * end; an unknown name restarts the cycle at the first positive fixture.
 */
export function nextFixture(current: string): string {
  const i = POSITIVE_FIXTURES.indexOf(current);
  return POSITIVE_FIXTURES[(i + 1) % POSITIVE_FIXTURES.length] ?? 'jab-left';
}

/** One log line per event: `[t ms] move hand kind latency:Xms [EMPOWERED]`. */
export function formatEventLine(e: MoveEvent): string {
  const base =
    `[${Math.round(e.t)}ms] ${e.move} ${e.hand} ${e.kind}` +
    ` latency:${Math.round(e.triggerLatencyMs)}ms`;
  return e.empowered ? `${base} EMPOWERED` : base;
}

export interface MoveLatencySummary {
  move: string;
  count: number;
  meanMs: number;
  maxMs: number;
}

/** Session-wide per-move trigger latency accumulator. */
export class LatencyStats {
  private readonly byMove = new Map<
    string,
    { count: number; sumMs: number; maxMs: number }
  >();

  add(move: string, ms: number): void {
    const cur = this.byMove.get(move);
    if (cur) {
      cur.count++;
      cur.sumMs += ms;
      cur.maxMs = Math.max(cur.maxMs, ms);
    } else {
      this.byMove.set(move, { count: 1, sumMs: ms, maxMs: ms });
    }
  }

  /** Per-move count/mean/max, sorted by move name for stable display. */
  summary(): MoveLatencySummary[] {
    return [...this.byMove.entries()]
      .map(([move, s]) => ({
        move,
        count: s.count,
        meanMs: s.sumMs / s.count,
        maxMs: s.maxMs,
      }))
      .sort((a, b) => (a.move < b.move ? -1 : a.move > b.move ? 1 : 0));
  }
}

// ---------------------------------------------------------------------------
// Event log with sustain collapsing
// ---------------------------------------------------------------------------

const LOG_CAPACITY = 12;

type LogEntry =
  | { kind: 'trigger'; event: MoveEvent }
  | { kind: 'sustain'; start: MoveEvent; ticks: number; endT: number | null };

interface LogLine {
  text: string;
  color: string;
}

/**
 * Rolling log of the last LOG_CAPACITY entries. A sustained move occupies one
 * entry: its tick count updates in place and the entry closes on sustain-end.
 */
class EventLog {
  private entries: LogEntry[] = [];

  push(e: MoveEvent): void {
    if (e.kind === 'sustain-tick' || e.kind === 'sustain-end') {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const en = this.entries[i];
        if (
          en !== undefined &&
          en.kind === 'sustain' &&
          en.endT === null &&
          en.start.move === e.move &&
          en.start.hand === e.hand
        ) {
          if (e.kind === 'sustain-tick') en.ticks++;
          else en.endT = e.t;
          return;
        }
      }
      return; // orphan tick/end (entry already scrolled out): drop
    }
    if (e.kind === 'sustain-start') {
      this.entries.push({ kind: 'sustain', start: e, ticks: 0, endT: null });
    } else {
      this.entries.push({ kind: 'trigger', event: e });
    }
    if (this.entries.length > LOG_CAPACITY) this.entries.shift();
  }

  /** Close any still-open sustains (a fixture pass ended mid-hold). */
  closeOpen(t: number): void {
    for (const en of this.entries) {
      if (en.kind === 'sustain' && en.endT === null) en.endT = t;
    }
  }

  lines(): LogLine[] {
    return this.entries.map((en) => {
      if (en.kind === 'trigger') {
        return {
          text: formatEventLine(en.event),
          color: en.event.empowered ? COLOR_EMPOWERED : COLOR_AMBER,
        };
      }
      const tail =
        en.endT === null
          ? ` ticks:${en.ticks} ...`
          : ` ticks:${en.ticks} end@${Math.round(en.endT)}ms`;
      return {
        text: formatEventLine(en.start) + tail,
        color: en.start.empowered ? COLOR_EMPOWERED : COLOR_GOLD,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export interface MovesDebugOptions {
  /** Fixture name under fixtures/synthetic/, without .json. Pins the cycle. */
  fixture?: string;
  /** Use the live camera path instead of replay. */
  live?: boolean;
}

interface AimArrow {
  origin: Vec3;
  aim: Vec3;
  born: number; // performance.now()
  sustain: boolean;
}

const ARROW_LIFE_MS = 350;
const MAX_ARROWS = 40;

export async function mountMovesDebug(
  container: HTMLElement,
  opts: MovesDebugOptions
): Promise<() => void> {
  const priorBackground = container.style.background;
  container.style.background = COLOR_BACKDROP;

  const canvas = document.createElement('canvas');
  canvas.style.position = 'fixed';
  canvas.style.inset = '0';
  canvas.style.width = '100vw';
  canvas.style.height = '100vh';
  canvas.style.background = COLOR_BACKDROP;
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  let cssW = window.innerWidth;
  let cssH = window.innerHeight;
  const resize = (): void => {
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  // -------------------------------------------------------------------------
  // Session state
  // -------------------------------------------------------------------------

  const stats = new LatencyStats();
  const log = new EventLog();
  let arrows: AimArrow[] = [];
  let engine = new MoveEngine();
  let filteredFrame: LandmarkFrame | null = null;
  let lastT = 0;
  let sourceLabel = 'loading...';
  let disposed = false;

  const handleEvents = (events: MoveEvent[]): void => {
    for (const e of events) {
      log.push(e);
      if (e.kind === 'trigger' || e.kind === 'sustain-start') {
        stats.add(e.move, e.triggerLatencyMs);
      }
      if (e.kind !== 'sustain-end') {
        arrows.push({
          origin: e.origin,
          aim: e.aim,
          born: performance.now(),
          sustain: e.kind !== 'trigger',
        });
        if (arrows.length > MAX_ARROWS) arrows.shift();
      }
    }
  };

  const handleFrame = (f: LandmarkFrame): void => {
    filteredFrame = f;
    lastT = f.t;
    handleEvents(engine.update(f));
  };

  // -------------------------------------------------------------------------
  // Source wiring: fixture cycle by default, live camera behind the flag
  // -------------------------------------------------------------------------

  let cleanupSource: () => void = () => {};

  if (opts.live) {
    const { LiveLandmarkSource: Live } = await import('../tracking/liveSource');
    const live = new Live();
    const filtered = new FilteredSource(live);
    const off = filtered.onFrame(handleFrame);
    sourceLabel = 'live camera';
    cleanupSource = () => {
      off();
      filtered.stop();
      filtered.dispose();
    };
    await filtered.start();
  } else {
    const pinned = opts.fixture;
    const cache = new Map<string, ReplaySource>();
    let passCleanup: () => void = () => {};
    let nextTimer: ReturnType<typeof setTimeout> | null = null;

    const startPass = async (name: string): Promise<void> => {
      if (disposed) return;
      let replay = cache.get(name);
      if (!replay) {
        replay = await ReplaySource.load('fixtures/synthetic/' + name + '.json');
        cache.set(name, replay);
      }
      if (disposed) return;
      const rp = replay;
      rp.reset();

      // Fresh engine and filter pipeline per pass: no cooldown, combo,
      // Breath, gate, or One Euro state bleeds across fixtures or loops.
      engine = new MoveEngine({ velocityScale: REPLAY_VELOCITY_SCALE });
      const filtered = new FilteredSource(rp);
      const offFrames = filtered.onFrame(handleFrame);
      // FilteredSource subscribed first, so the engine has always processed
      // the final frame before this listener schedules the next pass.
      const offDone = rp.onFrame(() => {
        if (rp.done && !disposed) {
          const interval = 1000 / Math.max(rp.fps, 1);
          nextTimer = setTimeout(() => {
            endPass();
            log.closeOpen(lastT);
            void startPass(pinned ?? nextFixture(name));
          }, interval);
        }
      });
      const endPass = (): void => {
        offFrames();
        offDone();
        filtered.stop();
        filtered.dispose();
      };
      passCleanup = endPass;
      const pos = POSITIVE_FIXTURES.indexOf(name);
      sourceLabel =
        (pinned
          ? `replay ${rp.label} (pinned)`
          : `replay ${rp.label} (${pos + 1}/${POSITIVE_FIXTURES.length})`) +
        ` vscale:${REPLAY_VELOCITY_SCALE}`;
      await filtered.start();
    };

    cleanupSource = () => {
      if (nextTimer !== null) {
        clearTimeout(nextTimer);
        nextTimer = null;
      }
      passCleanup();
    };
    await startPass(pinned ?? POSITIVE_FIXTURES[0] ?? 'jab-left');
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  const drawSkeleton = (hand: HandFrame, label: string): void => {
    ctx.strokeStyle = COLOR_AMBER;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const [a, b] of boneList()) {
      const la = hand.landmarks[a];
      const lb = hand.landmarks[b];
      if (!la || !lb) continue;
      const pa = projectToCanvas(la, cssW, cssH);
      const pb = projectToCanvas(lb, cssW, cssH);
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();
    ctx.fillStyle = COLOR_AMBER;
    for (const lmk of hand.landmarks) {
      const p = projectToCanvas(lmk, cssW, cssH);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    const wrist = hand.landmarks[LM.WRIST];
    if (wrist) {
      const p = projectToCanvas(wrist, cssW, cssH);
      ctx.fillStyle = COLOR_TEXT;
      ctx.font = 'bold 16px monospace';
      ctx.fillText(label, p.x + 12, p.y + 20);
    }
  };

  const drawBar = (
    x: number,
    y: number,
    label: string,
    frac: number,
    active: boolean,
    color: string
  ): void => {
    const w = 120;
    const h = 10;
    ctx.fillStyle = COLOR_DIM;
    ctx.font = '11px monospace';
    ctx.fillText(label, x, y + h - 1);
    ctx.fillStyle = COLOR_BAR_BG;
    ctx.fillRect(x + 46, y, w, h);
    ctx.fillStyle = active ? COLOR_EMPOWERED : color;
    ctx.fillRect(x + 46, y, Math.max(0, Math.min(1, frac)) * w, h);
    if (active) {
      ctx.fillStyle = COLOR_TEXT;
      ctx.fillText('*', x + 46 + w + 6, y + h - 1);
    }
  };

  const drawPosePanel = (): void => {
    const scores = engine.currentPoseScores;
    let y = 110;
    const block = (label: string, s: PoseScores | null): void => {
      ctx.fillStyle = COLOR_TEXT;
      ctx.font = 'bold 12px monospace';
      ctx.fillText(label + (s === null ? ' (absent)' : ''), 16, y);
      y += 14;
      drawBar(16, y, 'fist', s?.fist ?? 0, s?.fistActive ?? false, COLOR_AMBER);
      y += 16;
      drawBar(16, y, 'grip', s?.grip ?? 0, s?.gripActive ?? false, COLOR_AMBER);
      y += 26;
    };
    block('LEFT', scores.left);
    block('RIGHT', scores.right);
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = 'bold 12px monospace';
    ctx.fillText('BREATH', 16, y);
    y += 14;
    drawBar(16, y, '', engine.breath / BREATH_MAX, false, COLOR_GOLD);
    ctx.fillStyle = COLOR_DIM;
    ctx.font = '11px monospace';
    ctx.fillText(engine.breath.toFixed(0), 16, y + 10);
  };

  const drawArrows = (): void => {
    const now = performance.now();
    arrows = arrows.filter((a) => now - a.born < ARROW_LIFE_MS);
    for (const a of arrows) {
      const alpha = 1 - (now - a.born) / ARROW_LIFE_MS;
      const p = projectToCanvas(a.origin, cssW, cssH);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = a.sustain ? COLOR_GOLD : COLOR_AMBER;
      ctx.lineWidth = 2;
      const planar = Math.hypot(a.aim.x, a.aim.y);
      if (planar < 0.15) {
        // Aim dominated by -z (straight at the camera/enemy): draw a ring.
        ctx.beginPath();
        ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const ux = a.aim.x / planar;
        const uy = a.aim.y / planar;
        const len = 40 + 50 * Math.min(1, planar);
        const tx = p.x + ux * len;
        const ty = p.y + uy * len;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(tx, ty);
        // Arrowhead.
        const hx = -ux * 10;
        const hy = -uy * 10;
        ctx.lineTo(tx + hx - hy * 0.6, ty + hy + hx * 0.6);
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx + hx + hy * 0.6, ty + hy - hx * 0.6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  };

  const drawEventLog = (): void => {
    const lines = log.lines();
    const x = Math.max(cssW - 480, 340);
    ctx.font = '12px monospace';
    ctx.fillStyle = COLOR_DIM;
    ctx.fillText('EVENTS (last 12, sustains collapsed)', x, 24);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      ctx.fillStyle = line.color;
      ctx.fillText(line.text, x, 44 + i * 17);
    }
  };

  const drawStatsFooter = (): void => {
    const rows = stats.summary();
    ctx.font = '12px monospace';
    const baseY = cssH - 16 - (rows.length - 1) * 16;
    ctx.fillStyle = COLOR_DIM;
    ctx.fillText('TRIGGER LATENCY (session)', 16, baseY - 20);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;
      ctx.fillStyle = COLOR_GOLD;
      ctx.fillText(
        `${r.move.padEnd(14)} n:${String(r.count).padStart(3)}` +
          `  mean:${r.meanMs.toFixed(1)}ms  max:${r.maxMs.toFixed(1)}ms`,
        16,
        baseY + i * 16
      );
    }
  };

  const drawHud = (): void => {
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = '13px monospace';
    ctx.fillText(`source: ${sourceLabel}`, 16, 24);
    ctx.fillText(`t: ${(lastT / 1000).toFixed(2)}s`, 16, 42);
    ctx.fillText(`sustain: ${engine.activeSustain ?? 'none'}`, 16, 60);
  };

  let rafHandle: number | null = null;
  const render = (): void => {
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = COLOR_BACKDROP;
    ctx.fillRect(0, 0, cssW, cssH);

    if (filteredFrame) {
      if (filteredFrame.left) drawSkeleton(filteredFrame.left, 'L');
      if (filteredFrame.right) drawSkeleton(filteredFrame.right, 'R');
    }
    drawArrows();
    drawHud();
    drawPosePanel();
    drawEventLog();
    drawStatsFooter();

    rafHandle = requestAnimationFrame(render);
  };
  rafHandle = requestAnimationFrame(render);

  return () => {
    disposed = true;
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    rafHandle = null;
    cleanupSource();
    window.removeEventListener('resize', resize);
    canvas.remove();
    container.style.background = priorBackground;
  };
}
