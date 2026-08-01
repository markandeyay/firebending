/**
 * Debug HUD (D key in the arena): a translucent charcoal overlay panel in the
 * top-right corner showing the move engine's live internals per hand (pose
 * scores + active flags, windowed speed, bbox growth, thrust/whip arming,
 * the per-hand punch-fusion signals vs thresholds with pose freshness),
 * the global state machine (active sustain, lockout, cooldowns, Breath), the
 * derived MotionThresholds and the loaded MotionProfile, the raw head pose,
 * the camera rig's parallax state, and the engine's near-miss trace ring
 * ("JAB: speed 0.42 vs threshold 0.61 FAIL").
 *
 * Budget: pointer-events none, a single text node updated via textContent at
 * most REFRESH_HZ times a second and only when the text changed, so the DOM
 * cost stays far under a millisecond. Data is pulled, never pushed: the
 * arena's tick calls update() every frame and the HUD throttles itself.
 */

import type { LandmarkFrame } from '../tracking/types';
import type { Percentiles } from '../tracking/meters';
import type {
  MoveEngine,
  MoveName,
  NearMissRecord,
  PoseScores,
} from '../gestures/moves';
import type { MotionProfile } from '../gestures/profile';
import type { Handedness } from '../gestures/poses';

/** Maximum text refresh rate. */
export const REFRESH_HZ = 10;

/**
 * handHz p50 below this reads as degraded. Matches the capture sparsity
 * gate (RATE_GATE_FPS): ~14 fps is the normal sustained hand rate on the
 * reference machine and detection is framerate-independent, so only
 * genuinely sparse capture is flagged.
 */
export const HAND_HZ_BAD_BELOW = 10;

/** Warm ink-red for degraded readings (firelight family, never neon). */
const BAD_COLOR = '#d0532f';

/** Newline constant (kept out of template literals for tooling clarity). */
const NL = String.fromCharCode(10);

/**
 * Measured pipeline rates for the RATES block (quality round Phase 1).
 * Percentile fields render as "name p50/p95"; a null block hides the
 * section entirely (replay paths without a live source).
 */
export interface RatesBlock {
  cameraHz: Percentiles;
  handHz: Percentiles;
  poseHz: Percentiles;
  renderHz: Percentiles;
  photonToEmitMs: Percentiles;
  photonToFireMs: Percentiles;
  /** Rolling averages (ms), not percentiles. */
  mainMlMs: number;
  workerHandDetectMs: number;
  workerPoseDetectMs: number;
  handWorkerActive: boolean;
  poseWorkerActive: boolean;
}

/** "p50/p95" with one decimal, or "-" before any sample exists. Pure. */
export function formatPercentiles(p: Percentiles): string {
  if (p.count === 0) return '-';
  return `${p.p50.toFixed(1)}/${p.p95.toFixed(1)}`;
}

/** Short move labels for near-miss lines. */
const SHORT_NAME: Partial<Record<MoveName, string>> = {
  'jab-blast': 'JAB',
  'rising-flame': 'RISING',
  'fire-whip': 'WHIP',
  'twin-cannon': 'TWIN',
};

export interface DebugHudInputs {
  engine: MoveEngine;
  frame: LandmarkFrame | null;
  profile: MotionProfile | null;
  parallax: { yaw: number; pitch: number; offset: { x: number; y: number; z: number } };
  parallaxYawSign: number;
  /** Measured pipeline rates; omit/null on paths without live tracking. */
  rates?: RatesBlock | null;
}

/**
 * One near-miss line, formatted exactly as specified. Fusion conditions name
 * the specific failing signal: "JAB: elbowVel 2.10 vs threshold 3.60 FAIL"
 * or, for a primary that passed with no secondary,
 * "JAB: no secondary: speed 0.51/0.90, growth 0.40/1.35".
 */
export function formatNearMiss(rec: NearMissRecord): string {
  const name = SHORT_NAME[rec.move] ?? rec.move.toUpperCase();
  if (rec.condition === 'secondary') {
    const g = rec.value2 ?? 0;
    const gt = rec.threshold2 ?? 0;
    return (
      `${name}: no secondary: speed ${rec.value.toFixed(2)}/${rec.threshold.toFixed(2)}, ` +
      `growth ${g.toFixed(2)}/${gt.toFixed(2)}`
    );
  }
  return (
    `${name}: ${rec.condition} ${rec.value.toFixed(2)}` +
    ` vs threshold ${rec.threshold.toFixed(2)} FAIL`
  );
}

export class DebugHud {
  private readonly el: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly ratesEl: HTMLElement;
  private missEl!: HTMLElement;
  private lastUpdateMs = -Infinity;
  private lastText = '';
  private lastRatesText = '';
  private lastMissText = '';
  private readonly missScratch: NearMissRecord[] = [];
  private visibleState = false;

  constructor(root: HTMLElement) {
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.top = '12px';
    el.style.right = '12px';
    // Wide enough for the longest fusion line (elbow+speed+bbox each with a
    // PASS/FAIL token) at 11px Consolas; 360px clipped the verdicts.
    el.style.maxWidth = '420px';
    el.style.padding = '10px 14px';
    el.style.background = 'rgba(26, 21, 18, 0.85)';
    el.style.border = '1px solid rgba(201, 119, 46, 0.4)';
    el.style.borderRadius = '3px';
    el.style.color = '#c9772e';
    el.style.font = '11px/1.45 Consolas, "Courier New", monospace';
    el.style.whiteSpace = 'pre';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '50';
    el.style.display = 'none';
    // Three children: the engine text block, then the fixed-size RATES block
    // (its own element so the degraded-handHz reading can carry a color
    // span), then the variable-length near-miss log LAST so its 10 Hz
    // appear/expire churn never shifts the blocks above it.
    const textEl = document.createElement('div');
    const ratesEl = document.createElement('div');
    const missEl = document.createElement('div');
    el.append(textEl, ratesEl, missEl);
    root.appendChild(el);
    this.el = el;
    this.textEl = textEl;
    this.ratesEl = ratesEl;
    this.missEl = missEl;
  }

  get visible(): boolean {
    return this.visibleState;
  }

  show(): void {
    this.visibleState = true;
    this.el.style.display = 'block';
    this.lastUpdateMs = -Infinity; // refresh immediately on the next update
  }

  hide(): void {
    this.visibleState = false;
    this.el.style.display = 'none';
  }

  dispose(): void {
    this.el.remove();
  }

  /** Call every frame; internally throttled to REFRESH_HZ. */
  update(nowMs: number, inputs: DebugHudInputs): void {
    if (!this.visibleState) return;
    if (nowMs - this.lastUpdateMs < 1000 / REFRESH_HZ) return;
    this.lastUpdateMs = nowMs;

    const text = this.compose(inputs);
    if (text !== this.lastText) {
      this.lastText = text;
      this.textEl.textContent = text;
    }
    this.updateRates(inputs.rates ?? null);
    const missText = this.composeMisses(inputs.engine);
    if (missText !== this.lastMissText) {
      this.lastMissText = missText;
      this.missEl.textContent = missText;
    }
  }

  /** Render the RATES block: each metric as "name p50/p95"; handHz gets the
   * degraded color when its p50 falls below HAND_HZ_BAD_BELOW, and a live
   * probe with ZERO hand samples is the worst state, so it reads degraded
   * too. A null block (replay paths) shows a one-line explanation instead
   * of vanishing silently. */
  private updateRates(rates: RatesBlock | null): void {
    if (rates === null) {
      const absent = `${NL}rates  - (no live probe)`;
      if (this.lastRatesText !== absent) {
        this.lastRatesText = absent;
        this.ratesEl.textContent = absent;
      }
      return;
    }
    const handStr = `hand ${formatPercentiles(rates.handHz)}Hz`;
    const before = [
      `rates (p50/p95)`,
      `  camera ${formatPercentiles(rates.cameraHz)}Hz  `,
    ].join(NL);
    const after = [
      ``,
      `  pose ${formatPercentiles(rates.poseHz)}Hz  render ${formatPercentiles(rates.renderHz)}Hz`,
      `  photon>emit ${formatPercentiles(rates.photonToEmitMs)}ms  photon>fire ${formatPercentiles(rates.photonToFireMs)}ms`,
      `  main ml ${rates.mainMlMs.toFixed(1)}ms  wk hand ${rates.workerHandDetectMs.toFixed(1)}ms  wk pose ${rates.workerPoseDetectMs.toFixed(1)}ms`,
      `  workers  hand:${rates.handWorkerActive ? 'on' : 'OFF'}  pose:${rates.poseWorkerActive ? 'on' : 'OFF'}`,
    ].join(NL);
    const bad = rates.handHz.count === 0 || rates.handHz.p50 < HAND_HZ_BAD_BELOW;
    const key = `${before}${handStr}${after}|${bad}`;
    if (key === this.lastRatesText) return;
    this.lastRatesText = key;
    // Plain text around a single span carrying the handHz reading.
    const span = document.createElement('span');
    span.textContent = handStr;
    if (bad) span.style.color = BAD_COLOR;
    this.ratesEl.replaceChildren(
      document.createTextNode(NL + before),
      span,
      document.createTextNode(after),
    );
  }

  private compose(inputs: DebugHudInputs): string {
    const { engine, frame, profile, parallax, parallaxYawSign } = inputs;
    const t = engine.lastFrameT ?? 0;
    const scores = engine.currentPoseScores;
    const lines: string[] = [];

    const hand = (label: string, which: Handedness, s: PoseScores | null): void => {
      const m = engine.handMotionDebug(which);
      if (!m.present || s === null) {
        lines.push(`${label}  absent`);
        return;
      }
      const flag = (on: boolean): string => (on ? '*' : ' ');
      lines.push(
        `${label}  fist ${s.fist.toFixed(2)}${flag(s.fistActive)} ` +
          `grip ${s.grip.toFixed(2)}${flag(s.gripActive)}`,
      );
      lines.push(
        `    speed ${m.speed.toFixed(2)} growth ${m.growth.toFixed(2)} ` +
          `thrust:${m.thrustArmed ? 'armed' : '-'} whip:${m.whipArmed ? 'armed' : '-'}`,
      );
    };

    hand('L', 'left', scores.left);
    hand('R', 'right', scores.right);

    // Punch-fusion block: each signal vs its threshold with PASS/FAIL, plus
    // whether pose is fresh (fresh = primary+one-secondary rule; stale =
    // both-secondaries fallback).
    const fusion = engine.fusionState;
    lines.push(`fusion  pose ${fusion.left.elbowFresh ? 'FRESH' : 'stale/absent'}`);
    const fusionLine = (label: string, f: typeof fusion.left): void => {
      const pf = (v: number, th: number): string =>
        `${v.toFixed(2)}/${th.toFixed(2)} ${v >= th ? 'PASS' : 'FAIL'}`;
      lines.push(
        `  ${label} elbow ${pf(f.elbowVel, f.elbowThreshold)} ` +
          `speed ${pf(f.wristSpeed, f.speedThreshold)} ` +
          `bbox ${pf(f.bboxGrowth, f.growthThreshold)}`,
      );
    };
    fusionLine('L', fusion.left);
    fusionLine('R', fusion.right);

    // State machine.
    const lockoutMs = Math.max(0, engine.lockoutUntilT - t);
    lines.push(
      `state  sustain:${engine.activeSustain ?? '-'} ` +
        `lockout:${lockoutMs > 0 ? `${lockoutMs.toFixed(0)}ms` : '-'} ` +
        `breath:${engine.breath.toFixed(0)}`,
    );
    const cds: string[] = [];
    for (const [move, until] of engine.cooldownView) {
      const left = until - t;
      if (left > 0) cds.push(`${move} ${(left / 1000).toFixed(1)}s`);
    }
    lines.push(`cooldowns  ${cds.length > 0 ? cds.join('  ') : '-'}`);

    // Thresholds and profile.
    const th = engine.thresholds;
    lines.push(
      `thresholds  spike ${th.spikeSpeed.toFixed(2)}/${th.spikeGrowth.toFixed(2)} ` +
        `retract ${th.retractShrink.toFixed(2)} elbow ${th.elbowExtendVel.toFixed(2)}`,
    );
    lines.push(
      `  rise ${th.risingUpVel.toFixed(2)} whipVx ${th.whipSwingVx.toFixed(2)} ` +
        `static ${th.whipStaticMax.toFixed(2)}/${th.breathStaticMax.toFixed(2)} ` +
        `aim ${th.aimMinSpeed.toFixed(2)}`,
    );
    if (profile) {
      lines.push(
        `profile  punch ${profile.peakPunchSpeed.toFixed(2)}u/s ` +
          `${profile.peakPunchBboxGrowth.toFixed(2)}/s ` +
          `palm ${profile.peakPalmSpeed.toFixed(2)}u/s ` +
          `${profile.peakPalmBboxGrowth.toFixed(2)}/s`,
      );
      lines.push(
        `  elbow ${profile.peakElbowVel.toFixed(2)}rad/s ` +
          `neutral ${profile.neutralSpeed.toFixed(3)}u/s ` +
          `${profile.neutralBboxGrowth.toFixed(3)}/s ` +
          `${profile.neutralElbowVel.toFixed(3)}rad/s`,
      );
    } else {
      lines.push('profile  default');
    }

    // Head pose and camera rig parallax.
    const face = frame?.face ?? null;
    lines.push(
      `head  yaw ${face ? face.yaw.toFixed(3) : '-'} ` +
        `pitch ${face ? face.pitch.toFixed(3) : '-'}`,
    );
    lines.push(
      `parallax  yaw ${parallax.yaw.toFixed(3)} pitch ${parallax.pitch.toFixed(3)} ` +
        `sign ${parallaxYawSign > 0 ? '+1' : '-1'}`,
    );
    lines.push(
      `  offset ${parallax.offset.x.toFixed(3)} ${parallax.offset.y.toFixed(3)} ` +
        `${parallax.offset.z.toFixed(3)}`,
    );

    return lines.join('\n');
  }

  /** The variable-length near-miss trace, rendered last so its churn never
   * shifts the fixed blocks above it. */
  private composeMisses(engine: MoveEngine): string {
    const lines: string[] = ['near misses'];
    const misses = engine.nearMisses(this.missScratch);
    if (misses.length === 0) {
      lines.push('  -');
    } else {
      for (const rec of misses) lines.push(`  ${formatNearMiss(rec)}`);
    }
    return NL + lines.join('\n');
  }
}
