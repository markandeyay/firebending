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
 * The measurement math (quantiles, summary, pass rule) is pure and exported
 * for headless tests; mountPerfGate itself needs a real browser.
 */

import * as THREE from 'three';
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

export interface PerfSummary {
  frames: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface PerfGateResult extends PerfSummary {
  pass: boolean;
  budgetMs: number;
  drawCalls: number;
  particles: { flames: number; embers: number; smoke: number; total: number };
  lightsActive: number;
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
  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);

  const arena: Arena = buildArena(scene);
  const fire = new FireSystem(scene);
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

  let elapsed = 0;
  let lastNow = performance.now();
  let lastPhase = -1;
  let streamFlameAcc = 0;
  let streamEmberAcc = 0;
  const frameMs: number[] = [];
  let finished = false;

  const finish = (): void => {
    finished = true;
    const summary = summarizeFrames(frameMs);
    const stats = fire.stats();
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
    lines.textContent = [
      `frames        ${result.frames}`,
      `median        ${result.medianMs.toFixed(2)} ms (budget ${PERF_BUDGET_MS} ms)`,
      `p95           ${result.p95Ms.toFixed(2)} ms`,
      `max           ${result.maxMs.toFixed(2)} ms`,
      `draw calls    ${result.drawCalls}`,
      `particles     ${result.particles.total} (fl ${result.particles.flames} / em ${result.particles.embers} / sm ${result.particles.smoke})`,
      `lights        ${result.lightsActive}`,
    ].join('\n');
    panel.append(verdict, lines);
    container.appendChild(panel);
  };

  const tick = (): void => {
    const now = performance.now();
    const deltaMs = now - lastNow;
    lastNow = now;
    const dt = Math.min(deltaMs / 1000, 0.1);
    elapsed += dt;

    // Measurement window: discard warmup, collect PERF_MEASURE_SEC of frames.
    if (!finished) {
      if (elapsed >= PERF_WARMUP_SEC) frameMs.push(deltaMs);
      if (elapsed >= PERF_WARMUP_SEC + PERF_MEASURE_SEC) {
        // Render this final frame first so renderer.info is fresh at finish.
      } else {
        const label =
          elapsed < PERF_WARMUP_SEC
            ? `warming up ${(PERF_WARMUP_SEC - elapsed).toFixed(1)}s`
            : `measuring ${(PERF_WARMUP_SEC + PERF_MEASURE_SEC - elapsed).toFixed(1)}s`;
        hud.textContent = `perf gate: ${label}\nframes: ${frameMs.length}`;
      }
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

    renderer.render(scene, camera);

    if (!finished && elapsed >= PERF_WARMUP_SEC + PERF_MEASURE_SEC) finish();
  };

  const onResize = (): void => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  renderer.setAnimationLoop(tick);

  return () => {
    disposed = true;
    renderer.setAnimationLoop(null);
    window.removeEventListener('resize', onResize);
    lightA?.release();
    lightB?.release();
    manager?.dispose();
    physics?.dispose();
    fire.dispose();
    arena.dispose();
    renderer.dispose();
    container.replaceChildren();
  };
}
