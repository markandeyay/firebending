/**
 * Perf gate harness (Phase 3 exit, spec Section 13.5): a scripted stress
 * scene that builds the FULL arena (environment, ambient brazier flames, a
 * tier 2 construct with physics, coal lobs) and drives a heavy, deterministic
 * fire load while a slowly panning camera renders it all. After a 3 s warmup
 * it collects per-frame ms for 15 s and renders a parchment verdict panel:
 * median, p95, max frame time, draw calls, particle counts. PASS iff the
 * median frame is within the 16.6 ms budget.
 *
 * Load script (repeatable): every 0.5 s the harness alternates between a
 * spawnBurst volley (3 bursts with pooled lights, seeded placement) and a
 * sustained stream cone fired down the lane; ambient embers run throughout;
 * 2 traveling lights orbit the lane (re-acquired if the pool recycles them);
 * the construct lobs coals on a fixed interval.
 *
 * Automation: the result is exposed as window.__perfGateResult and logged as
 * a single line 'PERFGATE {json}' to the console.
 *
 * ML mode (&ml=1, Phase 7 support): the gate additionally runs the two
 * MediaPipe landmarkers (Hand, Pose; FaceLandmarker was deleted in R3
 * Phase 2 -- head pose derives from pose) against a SYNTHETIC camera --
 * a hidden 640x480 canvas redrawn every frame with deterministic animated
 * content (mulberry32-seeded drifting shapes and gradient bands so the
 * encoders have real work), captureStream(30)'d into a muted hidden video.
 * Detection runs inside the same rAF tick as the render on the liveSource
 * fallback schedule (hands every frame, pose every 2nd, monotonic
 * timestamps), so the frame-time median already includes the detect calls.
 * &pose=full swaps the pose model to the FULL variant so its cost can be
 * measured against the LITE default (see POSE_MODEL_URLS); the chosen
 * variant is reported in the ml block. The result gains an `ml` block with
 * the AMORTIZED per-rendered-frame cost of each model plus a separate
 * PASS/FAIL against the 7 ms combined ML budget (Section 14). If the models
 * cannot be created (offline), the gate degrades gracefully: it measures
 * without ML and reports available: false.
 *
 * The measurement math (quantiles, summary, pass rule, ML amortization) is
 * pure and exported for headless tests; mountPerfGate itself needs a real
 * browser.
 */

import * as THREE from 'three';
import type { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { PoseModelVariant } from '../tracking/poseSource';
import { configureRenderer } from '../game/renderer';
import { createPostPipeline } from '../game/post';
import { buildArena, type Arena } from '../game/arena';
import { FireSystem, type FireLightHandle } from '../vfx/fire';
import {
  ConstructManager,
  createPhysicsWorld,
  type PhysicsWorld,
} from '../game/enemies';
import '../ui/theme.css';

// ---------------------------------------------------------------------------
// Pure measurement math (headless testable)
// ---------------------------------------------------------------------------

/** Median frame budget, ms (Section 13.5 / Section 2 rule 5). */
export const PERF_BUDGET_MS = 16.6;
/**
 * Vsync tolerance: on a 60Hz display, rAF deltas quantize to ~16.7ms, so a
 * perfectly vsync-locked 60fps run has a median a hair ABOVE 16.6. The gate
 * passes when the median is within half a millisecond of the vsync interval
 * AND p95 shows no dropped frames (a drop reads as ~33ms). Recorded as a
 * spec deviation in the Decision Log.
 */
export const PERF_VSYNC_SLACK_MS = 0.5;
export const PERF_P95_LIMIT_MS = 25;
/** Seconds discarded before measurement (shader compiles, pool warmup). */
export const PERF_WARMUP_SEC = 3;
/** Seconds of frame collection after warmup. */
export const PERF_MEASURE_SEC = 15;
/** Load script phase length: burst volley / stream cone alternation, sec. */
export const PERF_PHASE_SEC = 0.5;

/** Combined ML budget per rendered frame in ms (Section 14). */
export const ML_BUDGET_MS = 7;

export interface PerfSummary {
  frames: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

/**
 * Per-model ML cost breakdown (&ml=1 runs only). The Ms values are AMORTIZED
 * average cost per RENDERED frame over the measurement window (total model ms
 * divided by rendered frames), so the scheduling discount shows: a pose model
 * that costs 4 ms but runs every 2nd frame reports ~2 ms here. poseVariant
 * records which pose model asset ran (&pose=full selects 'full').
 */
export interface PerfMlSummary {
  available: boolean;
  handMs: number;
  poseMs: number;
  poseVariant: PoseModelVariant;
  totalMsPerFrame: number;
}

export interface PerfGateResult extends PerfSummary {
  pass: boolean;
  budgetMs: number;
  drawCalls: number;
  particles: { flames: number; embers: number; smoke: number; total: number };
  lightsActive: number;
  /** Present only when the gate ran with &ml=1. */
  ml?: PerfMlSummary;
}

/** Linear-interpolated quantile of an ASCENDING-sorted array. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, q));
  const pos = (sorted.length - 1) * clamped;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/** Reduce collected per-frame ms to the reported summary statistics. */
export function summarizeFrames(frameMs: readonly number[]): PerfSummary {
  const sorted = [...frameMs].sort((a, b) => a - b);
  return {
    frames: sorted.length,
    medianMs: quantileSorted(sorted, 0.5),
    p95Ms: quantileSorted(sorted, 0.95),
    maxMs: sorted.length > 0 ? (sorted[sorted.length - 1] ?? 0) : 0,
  };
}

/** The gate rule: PASS iff the median frame is within budget (plus vsync
 * quantization slack) and p95 shows no dropped frames. */
export function perfPass(medianMs: number, p95Ms?: number): boolean {
  const medianOk = medianMs <= PERF_BUDGET_MS + PERF_VSYNC_SLACK_MS;
  const p95Ok = p95Ms === undefined || p95Ms <= PERF_P95_LIMIT_MS;
  return medianOk && p95Ok;
}

/**
 * Reduce accumulated per-model detect totals into the amortized ml block:
 * each Ms value is total model ms / rendered frames. Unavailable models (or
 * a zero-frame window) report zeros so the JSON stays well-formed. Pure.
 */
export function summarizeMl(
  available: boolean,
  totals: { handMs: number; poseMs: number },
  renderedFrames: number,
  poseVariant: PoseModelVariant = 'lite',
): PerfMlSummary {
  if (!available || renderedFrames <= 0) {
    return { available, handMs: 0, poseMs: 0, poseVariant, totalMsPerFrame: 0 };
  }
  const handMs = totals.handMs / renderedFrames;
  const poseMs = totals.poseMs / renderedFrames;
  return {
    available: true,
    handMs,
    poseMs,
    poseVariant,
    totalMsPerFrame: handMs + poseMs,
  };
}

/** The ML budget rule (Section 14): amortized total per frame within 7 ms.
 * Reported alongside the frame-time gate, never multiplied into it. */
export function mlPass(totalMsPerFrame: number): boolean {
  return totalMsPerFrame <= ML_BUDGET_MS;
}

// ---------------------------------------------------------------------------
// Measurement clock state machine (pure, exported for headless tests)
// ---------------------------------------------------------------------------

export type PerfGatePhase = 'loading' | 'warmup' | 'measure' | 'done';

export interface PerfClockState {
  phase: PerfGatePhase;
  /** Wall-clock seconds since the window started (0 while phase='loading'). */
  elapsed: number;
}

export interface PerfClockStep {
  state: PerfClockState;
  /** Frame sample to record (ms, clamped >= 0), or null outside the window. */
  recordMs: number | null;
  /** True on exactly one step ever: the frame that completes measurement. */
  finish: boolean;
}

/**
 * Advance the measurement clock by one rendered frame. Invariants, each one a
 * regression guard for a live-run hang:
 * - MONOTONIC: elapsed never decreases; negative rAF deltas (a real browser
 *   quirk, see the flame-wipe fix) are clamped to 0, never subtracted.
 * - WALL TIME, UNCAPPED: elapsed advances by the FULL frame delta. The
 *   simulation dt cap (0.1 s) must never be applied here -- capping the clock
 *   stretched the 3 s warmup into minutes once ML frames cost hundreds of ms,
 *   which read as "warming up forever, frames: 0".
 * - ONE-WAY: 'loading' can only be left, never re-entered; mlPending is
 *   ignored in every other phase, so a mid-run ML disable (detect throw) or
 *   any flag noise can never reset the clock or restart warmup.
 * - 'done' absorbs all further steps; finish fires exactly once.
 */
export function stepPerfClock(
  state: PerfClockState,
  rawDeltaMs: number,
  mlPending: boolean,
): PerfClockStep {
  if (state.phase === 'done') return { state, recordMs: null, finish: false };
  if (state.phase === 'loading') {
    if (mlPending) {
      return {
        state: { phase: 'loading', elapsed: 0 },
        recordMs: null,
        finish: false,
      };
    }
    // Transition frame: its delta spans the load period, so discard it and
    // start the warmup clock at 0.
    return {
      state: { phase: 'warmup', elapsed: 0 },
      recordMs: null,
      finish: false,
    };
  }
  const deltaMs = Math.max(0, rawDeltaMs);
  const elapsed = state.elapsed + deltaMs / 1000;
  const measuring = elapsed >= PERF_WARMUP_SEC;
  const complete = elapsed >= PERF_WARMUP_SEC + PERF_MEASURE_SEC;
  return {
    state: {
      phase: complete ? 'done' : measuring ? 'measure' : 'warmup',
      elapsed,
    },
    recordMs: measuring ? deltaMs : null,
    finish: complete,
  };
}

// ---------------------------------------------------------------------------
// Deterministic RNG for burst placement (same mulberry32 as the rest of vfx)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Synthetic-camera ML runtime (&ml=1)
// ---------------------------------------------------------------------------

const ML_VIDEO_WIDTH = 640;
const ML_VIDEO_HEIGHT = 480;
const ML_SCENE_SEED = 0x5eedca3;
/**
 * If ML setup neither resolves nor rejects within this window (a hung model
 * fetch or a WASM abort leaves the promise pending forever), give up and
 * measure without ML so the gate ALWAYS completes and prints PERFGATE.
 * Generous because a CPU-delegate fallback chain can legitimately take ~40 s.
 */
const ML_SETUP_TIMEOUT_MS = 90_000;
/** Hidden but live: 1px offscreen-ish styling, same trick as liveSource. */
const HIDDEN_MEDIA_CSS =
  'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';

interface MlRuntime {
  hand: HandLandmarker;
  pose: PoseLandmarker;
  poseVariant: PoseModelVariant;
  detectHands: typeof import('../tracking/handSource').detectHands;
  detectPoseAndHead: typeof import('../tracking/poseSource').detectPoseAndHead;
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;
  stream: MediaStream;
  /** Redraw the synthetic camera content for the given frame index. */
  drawFrame: (frame: number) => void;
}

/**
 * Deterministic animated 640x480 content: mulberry32-seeded drifting blobs
 * over scrolling gradient bands. Every frame differs from the last so the
 * capture encoder and the landmarker input pipeline do real per-frame work.
 */
function makeSyntheticSceneDrawer(
  seed: number,
  w: number,
  h: number,
): (ctx: CanvasRenderingContext2D, frame: number) => void {
  const rng = mulberry32(seed);
  const blobs = Array.from({ length: 10 }, () => ({
    x: rng() * w,
    y: rng() * h,
    r: 18 + rng() * 46,
    dx: 0.5 + rng() * 2.5,
    dy: 0.5 + rng() * 2.5,
    hue: Math.floor(rng() * 360),
    phase: rng() * Math.PI * 2,
  }));
  const bandH = Math.ceil(h / 12);
  return (ctx, frame) => {
    ctx.fillStyle = '#1a2430';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 12; i++) {
      const y = ((i * bandH + frame * 1.5) % (h + bandH)) - bandH;
      ctx.fillStyle = `hsl(${(i * 30 + frame) % 360}, 45%, ${18 + (i % 4) * 8}%)`;
      ctx.fillRect(0, y, w, bandH * 0.6);
    }
    for (const b of blobs) {
      const x = (((b.x + frame * b.dx) % w) + w) % w;
      const y = (((b.y + frame * b.dy) % h) + h) % h;
      const r = b.r * (0.75 + 0.25 * Math.sin(frame * 0.06 + b.phase));
      ctx.fillStyle = `hsl(${b.hue}, 60%, 55%)`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };
}

function disposeMlRuntime(rt: MlRuntime): void {
  rt.hand.close();
  rt.pose.close();
  for (const track of rt.stream.getTracks()) track.stop();
  rt.video.srcObject = null;
  rt.video.remove();
  rt.canvas.remove();
}

/**
 * Build the synthetic camera and create both landmarkers (GPU delegate
 * with CPU fallback, via the exact factories the live sources use; the
 * tracking modules are dynamically imported so a non-ML gate run never loads
 * them). `poseVariant` selects the pose model asset (&pose=full). Throws --
 * after cleaning up whatever it built -- if any landmarker cannot be
 * created (e.g. model/WASM download failing offline); the caller degrades
 * to a no-ML measurement.
 */
async function setupSyntheticMl(
  container: HTMLElement,
  poseVariant: PoseModelVariant,
): Promise<MlRuntime> {
  const canvas = document.createElement('canvas');
  canvas.width = ML_VIDEO_WIDTH;
  canvas.height = ML_VIDEO_HEIGHT;
  canvas.style.cssText = HIDDEN_MEDIA_CSS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable for synthetic camera');
  const draw = makeSyntheticSceneDrawer(ML_SCENE_SEED, ML_VIDEO_WIDTH, ML_VIDEO_HEIGHT);
  container.appendChild(canvas);

  const stream = canvas.captureStream(30);
  // Prime the stream: paint AFTER capture starts (frames drawn before
  // captureStream are not delivered) and force the first frame out so
  // video.play() has data to start on instead of pending forever.
  draw(ctx, 0);
  const [track] = stream.getVideoTracks();
  if (track && 'requestFrame' in track) {
    (track as CanvasCaptureMediaStreamTrack).requestFrame();
  }
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.style.cssText = HIDDEN_MEDIA_CSS;
  video.srcObject = stream;
  container.appendChild(video);

  try {
    await video.play();
    const [handMod, poseMod] = await Promise.all([
      import('../tracking/handSource'),
      import('../tracking/poseSource'),
    ]);
    const [handRes, poseRes] = await Promise.allSettled([
      handMod.createHandLandmarker(),
      poseMod.createPoseLandmarker(poseVariant),
    ]);
    if (handRes.status === 'rejected' || poseRes.status === 'rejected') {
      // Close whichever landmarkers DID come up before failing the setup.
      if (handRes.status === 'fulfilled') handRes.value.close();
      if (poseRes.status === 'fulfilled') poseRes.value.close();
      const rejected = [handRes, poseRes].find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      throw rejected?.reason ?? new Error('landmarker creation failed');
    }
    return {
      hand: handRes.value,
      pose: poseRes.value,
      poseVariant,
      detectHands: handMod.detectHands,
      detectPoseAndHead: poseMod.detectPoseAndHead,
      canvas,
      video,
      stream,
      drawFrame: (frame) => draw(ctx, frame),
    };
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    video.remove();
    canvas.remove();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const BRAZIER_FLAME_SCALE = 0.8;
const CONSTRUCT_POS = new THREE.Vector3(0, 0, -6);
const PLAYER_POS = new THREE.Vector3(0, 1.4, 0);
const COAL_LOB_INTERVAL_SEC = 2.5;

/** Sustained stream cone rates during odd phases (per second). */
const STREAM_FLAME_RATE = 150;
const STREAM_FLAME_CAP = 6;
const STREAM_EMBER_RATE = 60;

export function mountPerfGate(container: HTMLElement): () => void {
  const params = new URLSearchParams(window.location.search);
  const mlRequested = params.get('ml') === '1';
  /** Pose model variant under measurement: LITE default, &pose=full opts in. */
  const poseVariant: PoseModelVariant = params.get('pose') === 'full' ? 'full' : 'lite';
  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  configureRenderer(renderer);
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);

  // The REAL render pipeline (Phase 6 + fire rebuild): the gate must measure
  // the same post chain (half-res fire pass + bloom + grain + vignette) the
  // arena screen renders through, so fire is constructed first and passed in.
  const fire = new FireSystem(scene);
  const post = createPostPipeline(renderer, scene, camera, { fire });

  const arena: Arena = buildArena(scene);
  for (const anchor of arena.brazierAnchors) {
    fire.attachAmbient(anchor, BRAZIER_FLAME_SCALE);
  }

  // Progress HUD (monospace, same language as the other debug harnesses).
  const hud = document.createElement('div');
  hud.style.cssText = [
    'position:absolute',
    'top:8px',
    'left:8px',
    'padding:6px 10px',
    'font:12px/1.5 monospace',
    'color:#d8c8a8',
    'background:rgba(26,21,18,0.75)',
    'border:1px solid #6b1f15',
    'pointer-events:none',
    'white-space:pre',
    'z-index:10',
  ].join(';');
  hud.textContent = 'perf gate: warming up';
  container.appendChild(hud);

  const rng = mulberry32(0x9e2f6a7);
  const burstPos = new THREE.Vector3();
  const burstDir = new THREE.Vector3();
  const streamOrigin = new THREE.Vector3(0, 1.4, -0.4);
  const streamDir = new THREE.Vector3(0, -0.05, -1).normalize();
  const streamVel = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  // Two traveling lights, re-acquired whenever the pool recycles them.
  let lightA: FireLightHandle | null = null;
  let lightB: FireLightHandle | null = null;

  let physics: PhysicsWorld | null = null;
  let manager: ConstructManager | null = null;
  let disposed = false;

  void createPhysicsWorld().then((world) => {
    if (disposed) {
      world.dispose();
      return;
    }
    physics = world;
    manager = new ConstructManager(world, scene);
    const construct = manager.spawn(CONSTRUCT_POS, 2);
    construct.startLobbing(PLAYER_POS, COAL_LOB_INTERVAL_SEC);
  });

  // --- ML load (&ml=1): warmup/measurement waits until the models are up
  // (or have failed / timed out), so the whole window measures ONE
  // configuration. Setup runs exactly once and settles exactly once; a
  // runtime that arrives after the timeout or unmount is disposed unused.
  let mlRuntime: MlRuntime | null = null;
  let mlPending = mlRequested;
  let mlFrameIndex = 0;
  let mlLastTimestamp = -1;
  const mlTotals = { handMs: 0, poseMs: 0 };
  if (mlRequested) {
    let mlSettled = false;
    const settleWithoutMl = (why: string, err?: unknown): void => {
      if (mlSettled) return;
      mlSettled = true;
      mlPending = false;
      console.warn(`perf gate: ${why}, measuring without ML`, err ?? '');
    };
    const timeoutHandle = window.setTimeout(
      () => settleWithoutMl('ML setup timed out'),
      ML_SETUP_TIMEOUT_MS,
    );
    void setupSyntheticMl(container, poseVariant).then(
      (runtime) => {
        window.clearTimeout(timeoutHandle);
        if (disposed || mlSettled) {
          disposeMlRuntime(runtime);
          return;
        }
        mlSettled = true;
        mlRuntime = runtime;
        mlPending = false;
      },
      (err: unknown) => {
        window.clearTimeout(timeoutHandle);
        settleWithoutMl('ML models unavailable', err);
      },
    );
  }

  // Measurement clock: pure state machine (stepPerfClock), stepped once per
  // rendered frame. Starts in 'loading' only when ML was requested.
  let clock: PerfClockState = {
    phase: mlRequested ? 'loading' : 'warmup',
    elapsed: 0,
  };
  let lastNow = performance.now();
  let lastPhase = -1;
  let streamFlameAcc = 0;
  let streamEmberAcc = 0;
  const frameMs: number[] = [];

  const finish = (): void => {
    const summary = summarizeFrames(frameMs);
    const stats = fire.stats();
    const mlSummary = mlRequested
      ? summarizeMl(mlRuntime !== null, mlTotals, summary.frames, poseVariant)
      : null;
    const result: PerfGateResult = {
      ...summary,
      pass: perfPass(summary.medianMs, summary.p95Ms),
      budgetMs: PERF_BUDGET_MS,
      drawCalls: renderer.info.render.calls,
      particles: {
        flames: stats.flames,
        embers: stats.embers,
        smoke: stats.smoke,
        total: stats.total,
      },
      lightsActive: stats.lightsActive,
      ...(mlSummary ? { ml: mlSummary } : {}),
    };
    (window as unknown as { __perfGateResult?: PerfGateResult }).__perfGateResult =
      result;
    console.log(`PERFGATE ${JSON.stringify(result)}`);
    hud.textContent = 'perf gate: done';

    // Verdict panel, parchment and ink.
    const panel = document.createElement('div');
    panel.className = 'fb-panel';
    panel.style.cssText = [
      'position:absolute',
      'top:50%',
      'left:50%',
      'transform:translate(-50%,-50%)',
      'min-width:320px',
      'text-align:center',
      'z-index:20',
    ].join(';');
    const verdict = document.createElement('div');
    verdict.textContent = result.pass ? 'PASS' : 'FAIL';
    verdict.style.cssText = [
      'font-family:var(--fb-font-display)',
      'font-size:2.6rem',
      'letter-spacing:0.3em',
      'text-indent:0.3em',
      `color:${result.pass ? 'var(--fb-gold)' : 'var(--fb-vermilion)'}`,
      'margin-bottom:0.6rem',
    ].join(';');
    const lines = document.createElement('pre');
    lines.style.cssText =
      'margin:0;font:13px/1.7 monospace;text-align:left;white-space:pre';
    const lineRows = [
      `frames        ${result.frames}`,
      `median        ${result.medianMs.toFixed(2)} ms (budget ${PERF_BUDGET_MS} ms)`,
      `p95           ${result.p95Ms.toFixed(2)} ms`,
      `max           ${result.maxMs.toFixed(2)} ms`,
      `draw calls    ${result.drawCalls}`,
      `particles     ${result.particles.total} (fl ${result.particles.flames} / em ${result.particles.embers} / sm ${result.particles.smoke})`,
      `lights        ${result.lightsActive}`,
    ];
    if (result.ml) {
      if (result.ml.available) {
        lineRows.push(
          `ml/frame      ${result.ml.totalMsPerFrame.toFixed(2)} ms (hand ${result.ml.handMs.toFixed(2)} / pose[${result.ml.poseVariant}] ${result.ml.poseMs.toFixed(2)})`,
          `ml budget     ${ML_BUDGET_MS} ms -> ${mlPass(result.ml.totalMsPerFrame) ? 'PASS' : 'FAIL'}`,
        );
      } else {
        lineRows.push('ml            unavailable (models failed to load)');
      }
    }
    lines.textContent = lineRows.join('\n');
    panel.append(verdict, lines);
    container.appendChild(panel);
  };

  // With the post chain, one frame is several internal renderer.render calls
  // (scene + bloom mips + output + grade). autoReset would leave info showing
  // only the last quad pass; manual reset per tick makes drawCalls the TRUE
  // total per frame across the whole pipeline.
  renderer.info.autoReset = false;

  const tick = (): void => {
    renderer.info.reset();
    const now = performance.now();
    const rawDeltaMs = now - lastNow;
    lastNow = now;
    // Simulation dt for physics/particles: clamped to [0, 0.1]. The
    // measurement clock advances separately inside stepPerfClock on the
    // UNCAPPED wall delta -- applying this cap to the clock stretched the 3 s
    // warmup into minutes once ML frames cost hundreds of ms (the live-run
    // "warming up forever" hang).
    const dt = Math.min(Math.max(rawDeltaMs, 0) / 1000, 0.1);

    const step = stepPerfClock(clock, rawDeltaMs, mlPending);
    clock = step.state;
    if (step.recordMs !== null) frameMs.push(step.recordMs);
    const elapsed = clock.elapsed;

    if (clock.phase !== 'done') {
      const label =
        clock.phase === 'loading'
          ? 'loading ML models'
          : clock.phase === 'warmup'
            ? `warming up ${(PERF_WARMUP_SEC - elapsed).toFixed(1)}s`
            : `measuring ${(PERF_WARMUP_SEC + PERF_MEASURE_SEC - elapsed).toFixed(1)}s`;
      hud.textContent = `perf gate: ${label}\nframes: ${frameMs.length}`;
    }

    // --- Scripted heavy load -----------------------------------------------
    const phase = Math.floor(elapsed / PERF_PHASE_SEC);
    const streamPhase = phase % 2 === 1;
    if (phase !== lastPhase) {
      lastPhase = phase;
      if (!streamPhase) {
        // Burst volley: 3 pooled-light bursts along the lane, seeded spread.
        for (let i = 0; i < 3; i++) {
          burstPos.set(
            (rng() - 0.5) * 4,
            0.8 + rng() * 1.4,
            -3 - rng() * 8,
          );
          burstDir.set((rng() - 0.5) * 0.6, 0.4 + rng() * 0.6, (rng() - 0.5) * 0.6);
          fire.spawnBurst(burstPos, burstDir, {
            flameCount: 24,
            emberCount: 16,
            size: 0.5,
            speed: 4,
            spread: 0.5,
            lifetime: 0.5,
            lightIntensity: 4,
            lightRadius: 7,
            lightDuration: 0.4,
          });
        }
      }
    }
    if (streamPhase) {
      // Sustained stream cone down the lane, spawn-rate matched to gameplay.
      streamFlameAcc = Math.min(
        streamFlameAcc + STREAM_FLAME_RATE * dt,
        STREAM_FLAME_CAP,
      );
      const nFlames = Math.floor(streamFlameAcc);
      if (nFlames > 0) {
        streamFlameAcc -= nFlames;
        streamVel.copy(streamDir).multiplyScalar(9);
        fire.flames.spawn({
          position: streamOrigin,
          velocity: streamVel,
          size: 0.32,
          lifetime: 0.4,
          count: nFlames,
          spread: 0.09,
        });
      }
      streamEmberAcc = Math.min(streamEmberAcc + STREAM_EMBER_RATE * dt, 4);
      const nEmbers = Math.floor(streamEmberAcc);
      if (nEmbers > 0) {
        streamEmberAcc -= nEmbers;
        streamVel.copy(streamDir).multiplyScalar(4);
        streamVel.y += 0.4;
        fire.embers.spawn({
          position: streamOrigin,
          velocity: streamVel,
          lifetime: 1.2,
          count: nEmbers,
          spread: 0.12,
        });
      }
    }

    // Two traveling lights orbiting the lane; re-acquire on recycle.
    if (!lightA || !lightA.alive) lightA = fire.lights.acquire(tmp.set(0, 1.5, -3), 3.2, 7);
    if (!lightB || !lightB.alive) lightB = fire.lights.acquire(tmp.set(0, 1.5, -8), 3.2, 7);
    lightA.move(tmp.set(Math.sin(elapsed * 0.9) * 2.4, 1.4 + Math.sin(elapsed * 1.7) * 0.4, -3 - Math.sin(elapsed * 0.5) * 2));
    lightB.move(tmp.set(Math.cos(elapsed * 0.7) * 2.4, 1.6 + Math.cos(elapsed * 1.3) * 0.4, -8 + Math.cos(elapsed * 0.4) * 2));

    // --- Synthetic-camera ML load (&ml=1) ----------------------------------
    // Runs INSIDE this rAF tick, so the frame-time median already includes
    // the detect calls. liveSource fallback schedule: hands every frame,
    // pose every 2nd (odd frames; the head pose derives from the same
    // detection); monotonic timestamps.
    if (
      mlRuntime &&
      mlRuntime.video.readyState >= 2 &&
      mlRuntime.video.videoWidth > 0
    ) {
      const rt = mlRuntime;
      const timestamp = Math.max(now, mlLastTimestamp + 1);
      mlLastTimestamp = timestamp;
      // Accumulate on exactly the frames whose deltas were recorded, so the
      // amortized denominator (rendered frames) matches the numerator.
      const measuring = step.recordMs !== null;
      try {
        rt.drawFrame(mlFrameIndex);
        const handStart = performance.now();
        rt.detectHands(rt.hand, rt.video, timestamp);
        const handMs = performance.now() - handStart;
        let poseMs = 0;
        if (mlFrameIndex % 2 === 1) {
          const poseStart = performance.now();
          rt.detectPoseAndHead(rt.pose, rt.video, timestamp);
          poseMs = performance.now() - poseStart;
        }
        if (measuring) {
          mlTotals.handMs += handMs;
          mlTotals.poseMs += poseMs;
        }
      } catch (err) {
        console.warn('perf gate: ML detection failed mid-run, disabling ML', err);
        disposeMlRuntime(rt);
        mlRuntime = null;
      }
      mlFrameIndex++;
    }

    // World systems.
    manager?.update(dt);
    fire.update(dt);
    arena.update(dt, elapsed);

    // Slow authored camera pan (no player input in the harness).
    camera.position.set(
      Math.sin(elapsed * 0.12) * 1.4,
      1.6 + Math.sin(elapsed * 0.08) * 0.2,
      3.4,
    );
    camera.lookAt(0, 1.3, -6);

    post.render(dt);

    // step.finish fires exactly once (the 'done' phase absorbs all later
    // steps), after this frame's render so renderer.info is fresh.
    if (step.finish) finish();
  };

  const onResize = (): void => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    post.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  renderer.setAnimationLoop(tick);

  return () => {
    disposed = true;
    renderer.setAnimationLoop(null);
    window.removeEventListener('resize', onResize);
    if (mlRuntime) {
      disposeMlRuntime(mlRuntime);
      mlRuntime = null;
    }
    lightA?.release();
    lightB?.release();
    manager?.dispose();
    physics?.dispose();
    fire.dispose();
    arena.dispose();
    post.dispose();
    renderer.dispose();
    container.replaceChildren();
  };
}
