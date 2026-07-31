/**
 * Tracking debug overlay (Phase 1 exit criterion): draws raw and filtered
 * hand skeletons plus a head-pose indicator from either a replay fixture
 * (looping) or the live camera path (behind the live flag).
 *
 * Pure helpers (boneList, projectToCanvas, formatHud) are exported for
 * headless tests; all DOM access stays inside mountTrackingDebug so this
 * module imports cleanly in node. The live source is loaded dynamically so
 * MediaPipe code never enters the module graph unless the flag is set.
 */

import type {
  FrameListener,
  HandFrame,
  LandmarkFrame,
  LandmarkSource,
  Vec3,
} from '../tracking/types';
import { HAND_LANDMARK_COUNT, LM } from '../tracking/types';
import { FilteredSource } from '../tracking/filters';
import { ReplaySource } from '../tracking/replaySource';
import type { LiveLandmarkSource } from '../tracking/liveSource';

// ---------------------------------------------------------------------------
// Palette (Section 2: warm firelight only, no neon)
// ---------------------------------------------------------------------------

const COLOR_BACKDROP = '#1a1512';
const COLOR_RAW = '#5a5248';
const COLOR_FILTERED = '#ff8a3c';
const COLOR_TEXT = '#d8c8a8';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Hand skeleton bones as landmark index pairs: a spoke from the wrist to the
 * base of each finger, each finger chain, and the palm arc across the MCPs.
 */
const BONES: ReadonlyArray<readonly [number, number]> = [
  // Wrist spokes.
  [LM.WRIST, LM.THUMB_CMC],
  [LM.WRIST, LM.INDEX_MCP],
  [LM.WRIST, LM.MIDDLE_MCP],
  [LM.WRIST, LM.RING_MCP],
  [LM.WRIST, LM.PINKY_MCP],
  // Thumb chain.
  [LM.THUMB_CMC, LM.THUMB_MCP],
  [LM.THUMB_MCP, LM.THUMB_IP],
  [LM.THUMB_IP, LM.THUMB_TIP],
  // Index chain.
  [LM.INDEX_MCP, LM.INDEX_PIP],
  [LM.INDEX_PIP, LM.INDEX_DIP],
  [LM.INDEX_DIP, LM.INDEX_TIP],
  // Middle chain.
  [LM.MIDDLE_MCP, LM.MIDDLE_PIP],
  [LM.MIDDLE_PIP, LM.MIDDLE_DIP],
  [LM.MIDDLE_DIP, LM.MIDDLE_TIP],
  // Ring chain.
  [LM.RING_MCP, LM.RING_PIP],
  [LM.RING_PIP, LM.RING_DIP],
  [LM.RING_DIP, LM.RING_TIP],
  // Pinky chain.
  [LM.PINKY_MCP, LM.PINKY_PIP],
  [LM.PINKY_PIP, LM.PINKY_DIP],
  [LM.PINKY_DIP, LM.PINKY_TIP],
  // Palm arc across the MCPs.
  [LM.INDEX_MCP, LM.MIDDLE_MCP],
  [LM.MIDDLE_MCP, LM.RING_MCP],
  [LM.RING_MCP, LM.PINKY_MCP],
];

/** The bone index pairs used to draw a hand skeleton. */
export function boneList(): ReadonlyArray<readonly [number, number]> {
  return BONES;
}

/** Map a normalized [0..1] landmark to pixel coordinates. */
export function projectToCanvas(
  v: Vec3,
  w: number,
  h: number
): { x: number; y: number } {
  return { x: v.x * w, y: v.y * h };
}

export interface HandHudState {
  /** Raw presence confidence, or null when the hand is absent. */
  confidence: number | null;
  /** Gated tracked state from the FilteredSource (Section 5 gating). */
  tracked: boolean;
}

export interface HudState {
  source: string;
  /** Frame timestamp in ms. */
  t: number;
  fps: number;
  left: HandHudState;
  right: HandHudState;
  /** Present only on the live path. */
  live?: {
    handMs: number;
    /** Pose detect cost per sample, ms (worker path: off-thread). */
    poseMs: number;
    /** Achieved pose sample rate, Hz (0 on the main-thread fallback). */
    poseHz: number;
    /** True while pose runs in the dedicated worker. */
    poseWorker: boolean;
    poseDegraded: boolean;
    /** ROI crop draw+detect average, ms (Round 3 Phase 1). */
    cropMs?: number;
    /** Which sides used the ROI crop path on the latest frame. */
    cropActive?: { left: boolean; right: boolean };
  };
}

/** Render the HUD text block. Plain ASCII, one field group per line. */
export function formatHud(state: HudState): string {
  const hand = (label: string, h: HandHudState): string => {
    const conf = h.confidence === null ? ' -- ' : h.confidence.toFixed(2);
    const gate = h.tracked ? 'TRACKED' : 'untracked';
    return `${label} conf ${conf}  ${gate}`;
  };
  const lines = [
    `source: ${state.source}`,
    `t: ${(state.t / 1000).toFixed(2)}s  fps: ${state.fps.toFixed(1)}`,
    hand('L', state.left),
    hand('R', state.right),
  ];
  if (state.live) {
    lines.push(
      `hand ${state.live.handMs.toFixed(1)}ms  pose ${state.live.poseMs.toFixed(1)}ms` +
        ` @ ${state.live.poseHz.toFixed(1)}Hz` +
        ` (${state.live.poseWorker ? 'worker' : 'main'})` +
        `  poseDegraded: ${state.live.poseDegraded ? 'yes' : 'no'}`
    );
    if (state.live.cropMs !== undefined && state.live.cropActive) {
      const on = state.live.cropActive;
      const sides =
        on.left || on.right
          ? `${on.left ? 'L' : '-'}${on.right ? 'R' : '-'}`
          : 'off';
      lines.push(`crop ${state.live.cropMs.toFixed(1)}ms  active: ${sides}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Looping replay adapter
// ---------------------------------------------------------------------------

/**
 * Wraps a ReplaySource so playback loops forever: on exhaustion the replay is
 * reset and restarted after one frame interval, and emitted timestamps are
 * shifted so t stays monotonic across loops. Monotonic time keeps the One
 * Euro filters and confidence gates downstream from seeing time run backward
 * at the loop seam.
 */
class LoopingReplaySource implements LandmarkSource {
  private listeners = new Set<FrameListener>();
  private offset = 0;
  private lastT = 0;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly detach: () => void;

  constructor(private readonly replay: ReplaySource) {
    this.detach = replay.onFrame((frame) => {
      this.lastT = frame.t + this.offset;
      const shifted: LandmarkFrame = { ...frame, t: this.lastT };
      for (const l of this.listeners) l(shifted);
      if (replay.done && !this.stopped) {
        const interval = 1000 / Math.max(replay.fps, 1);
        this.restartTimer = setTimeout(() => {
          this.offset = this.lastT + interval;
          this.replay.reset();
          void this.replay.start();
        }, interval);
      }
    });
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    await this.replay.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.replay.stop();
    this.detach();
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function drawHandSkeleton(
  ctx: CanvasRenderingContext2D,
  hand: HandFrame,
  w: number,
  h: number,
  color: string,
  lineWidth: number,
  dotRadius: number
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (const [a, b] of BONES) {
    const la = hand.landmarks[a];
    const lb = hand.landmarks[b];
    if (!la || !lb) continue;
    const pa = projectToCanvas(la, w, h);
    const pb = projectToCanvas(lb, w, h);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();

  ctx.fillStyle = color;
  for (let i = 0; i < HAND_LANDMARK_COUNT; i++) {
    const lm = hand.landmarks[i];
    if (!lm) continue;
    const p = projectToCanvas(lm, w, h);
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHandLabel(
  ctx: CanvasRenderingContext2D,
  hand: HandFrame,
  w: number,
  h: number,
  label: string
): void {
  const wrist = hand.landmarks[LM.WRIST];
  if (!wrist) return;
  const p = projectToCanvas(wrist, w, h);
  ctx.fillStyle = COLOR_TEXT;
  ctx.font = 'bold 16px monospace';
  ctx.fillText(label, p.x + 12, p.y + 20);
}

function drawFaceIndicator(
  ctx: CanvasRenderingContext2D,
  face: { yaw: number; pitch: number; position: Vec3 },
  w: number,
  h: number
): void {
  const p = projectToCanvas(face.position, w, h);
  const r = Math.min(w, h) * 0.035;

  // Head circle.
  ctx.strokeStyle = COLOR_FILTERED;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();

  // Yaw: a short line from the center pointing where the player looks
  // (positive yaw = player's right = +x in player space).
  const yawLen = r * 1.6;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + Math.sin(face.yaw) * yawLen, p.y);
  ctx.stroke();

  // Pitch: a small marker offset vertically (positive pitch = looking up).
  const pitchY = p.y - Math.sin(face.pitch) * yawLen;
  ctx.fillStyle = COLOR_TEXT;
  ctx.beginPath();
  ctx.arc(p.x, pitchY, 3, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Frame-rate meter for the replay path (live path reports its own stats)
// ---------------------------------------------------------------------------

class FpsMeter {
  private times: number[] = [];

  push(nowMs: number): void {
    this.times.push(nowMs);
    if (this.times.length > 30) this.times.shift();
  }

  get fps(): number {
    if (this.times.length < 2) return 0;
    const first = this.times[0];
    const last = this.times[this.times.length - 1];
    if (first === undefined || last === undefined || last <= first) return 0;
    return ((this.times.length - 1) / (last - first)) * 1000;
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export interface TrackingDebugOptions {
  /** Fixture name under fixtures/synthetic/, without .json. */
  fixture?: string;
  /** Use the live camera path instead of replay. */
  live?: boolean;
}

export async function mountTrackingDebug(
  container: HTMLElement,
  opts: TrackingDebugOptions
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

  // Source selection: the live path stays behind the flag and is loaded
  // dynamically so MediaPipe never loads for replay sessions.
  let inner: LandmarkSource;
  let liveSource: LiveLandmarkSource | null = null;
  let sourceLabel: string;
  if (opts.live) {
    const { LiveLandmarkSource: Live } = await import('../tracking/liveSource');
    liveSource = new Live();
    inner = liveSource;
    sourceLabel = 'live camera';
  } else {
    const fixture = opts.fixture ?? 'jab-right';
    const replay = await ReplaySource.load(
      'fixtures/synthetic/' + fixture + '.json'
    );
    inner = new LoopingReplaySource(replay);
    sourceLabel = 'replay ' + replay.label;
  }

  const filtered = new FilteredSource(inner);

  // Buffer the latest raw and filtered frames; render both on rAF.
  let rawFrame: LandmarkFrame | null = null;
  let filteredFrame: LandmarkFrame | null = null;
  const meter = new FpsMeter();
  const offRaw = inner.onFrame((f) => {
    rawFrame = f;
    meter.push(performance.now());
  });
  const offFiltered = filtered.onFrame((f) => {
    filteredFrame = f;
  });

  let rafHandle: number | null = null;
  const render = (): void => {
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = COLOR_BACKDROP;
    ctx.fillRect(0, 0, cssW, cssH);

    // Raw skeletons: dim, thin.
    if (rawFrame) {
      if (rawFrame.left) drawHandSkeleton(ctx, rawFrame.left, cssW, cssH, COLOR_RAW, 1, 2);
      if (rawFrame.right) drawHandSkeleton(ctx, rawFrame.right, cssW, cssH, COLOR_RAW, 1, 2);
    }

    // Filtered skeletons: warm amber, thicker, with L/R tags.
    if (filteredFrame) {
      if (filteredFrame.left) {
        drawHandSkeleton(ctx, filteredFrame.left, cssW, cssH, COLOR_FILTERED, 3, 4);
        drawHandLabel(ctx, filteredFrame.left, cssW, cssH, 'L');
      }
      if (filteredFrame.right) {
        drawHandSkeleton(ctx, filteredFrame.right, cssW, cssH, COLOR_FILTERED, 3, 4);
        drawHandLabel(ctx, filteredFrame.right, cssW, cssH, 'R');
      }
      if (filteredFrame.face) drawFaceIndicator(ctx, filteredFrame.face, cssW, cssH);
    }

    // Tag raw-only hands too so an untracked hand is still identifiable.
    if (rawFrame) {
      if (rawFrame.left && !filteredFrame?.left) drawHandLabel(ctx, rawFrame.left, cssW, cssH, 'L');
      if (rawFrame.right && !filteredFrame?.right) drawHandLabel(ctx, rawFrame.right, cssW, cssH, 'R');
    }

    // HUD.
    const hud = formatHud({
      source: sourceLabel,
      t: rawFrame ? rawFrame.t : 0,
      fps: liveSource ? liveSource.stats.fps : meter.fps,
      left: {
        confidence: rawFrame?.left ? rawFrame.left.confidence : null,
        tracked: filteredFrame?.left != null,
      },
      right: {
        confidence: rawFrame?.right ? rawFrame.right.confidence : null,
        tracked: filteredFrame?.right != null,
      },
      ...(liveSource
        ? {
            live: {
              handMs: liveSource.stats.handMs,
              poseMs: liveSource.stats.poseMs,
              poseHz: liveSource.stats.poseHz,
              poseWorker: liveSource.stats.poseWorkerActive,
              poseDegraded: liveSource.poseDegraded,
              cropMs: liveSource.stats.cropMs,
              cropActive: liveSource.stats.cropActive,
            },
          }
        : {}),
    });
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = '13px monospace';
    const lines = hud.split('\n');
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i] ?? '', 16, 24 + i * 18);
    }

    rafHandle = requestAnimationFrame(render);
  };
  rafHandle = requestAnimationFrame(render);

  await filtered.start();

  return () => {
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    rafHandle = null;
    offRaw();
    offFiltered();
    filtered.stop();
    filtered.dispose();
    window.removeEventListener('resize', resize);
    canvas.remove();
    container.style.background = priorBackground;
  };
}
