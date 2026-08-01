/**
 * Debug HUD (D key in the arena): a translucent charcoal overlay panel in the
 * top-right corner showing the PHASE ENGINE's live internals (the position
 * state machines of the 2026-07-31 rebuild). Per arm: the machine state
 * (RETRACTED / EXTENDING / EXTENDED, with PAUSED flagged while confidence
 * froze it), the normalized extension with a tiny textual bar, the body zone
 * the wrist sits in, and the last transition with its timing
 * ("EXTENDING>EXTENDED 180ms"). Then the AIM READOUT: the last emitted aim
 * vector as yaw/pitch degrees plus its raw screen-space components and the
 * last move name, the engine state line (active sustain, Breath), the live
 * learned per-arm reach against the profile's calibrated seeds, the raw head
 * pose, the camera rig's parallax state, and the measured pipeline RATES
 * block.
 *
 * The legacy velocity displays (pose-score/speed/growth fusion vs
 * thresholds, the derived MotionThresholds, the near-miss trace ring) died
 * with the velocity engine: the phase engine has no velocities and no
 * near-miss ring, so those sections are removed outright rather than dashed
 * out ("I need to see the state machine, not velocity numbers").
 *
 * Budget: pointer-events none, text updated via textContent at most
 * REFRESH_HZ times a second and only when the text changed, so the DOM cost
 * stays far under a millisecond. Data is pulled, never pushed: the arena's
 * tick calls update() every frame and the HUD throttles itself. The engine's
 * debugState children are REUSED in place by the engine; compose() reads
 * fields immediately and never retains them.
 */

import type { LandmarkFrame, Vec3 } from '../tracking/types';
import type { Percentiles } from '../tracking/meters';
import type { ArmDebugState, PhaseMoveEngine } from '../gestures/phaseEngine';
import type { MotionProfile } from '../gestures/profile';

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

// ---------------------------------------------------------------------------
// Phase-machine block formatting (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Cells in the tiny textual extension bar. */
export const EXT_BAR_CELLS = 8;

/**
 * Extension that fills the bar completely. Punches normalize to ~0.7..1.1
 * and the jab overdrive gate sits at 1.35, so a saturated bar reads as
 * "past any plausible forward punch" (a hanging arm pegs it instantly).
 */
export const EXT_BAR_FULL = 1.2;

/** Tiny textual extension bar, e.g. "[#####---]". Junk input renders empty
 *  rather than corrupting the panel's column widths. Pure. */
export function extensionBar(ext: number): string {
  const frac = Number.isFinite(ext) ? Math.min(Math.max(ext / EXT_BAR_FULL, 0), 1) : 0;
  const fill = Math.round(frac * EXT_BAR_CELLS);
  return `[${'#'.repeat(fill)}${'-'.repeat(EXT_BAR_CELLS - fill)}]`;
}

/** Always-signed fixed-point ("+12.4" / "-3.1") for the degree readout. */
export function signedFixed(value: number, digits: number): string {
  const s = value.toFixed(digits);
  return s.startsWith('-') ? s : `+${s}`;
}

/**
 * Aim vector (screen space: x right, y DOWN, z negative toward the enemy)
 * as yaw/pitch degrees: yaw positive to the player's right, pitch positive
 * up, (0, 0) dead ahead. Pure.
 */
export function aimAnglesDeg(aim: Vec3): { yawDeg: number; pitchDeg: number } {
  const yaw = Math.atan2(aim.x, -aim.z);
  const pitch = Math.atan2(-aim.y, Math.hypot(aim.x, aim.z));
  return { yawDeg: (yaw * 180) / Math.PI, pitchDeg: (pitch * 180) / Math.PI };
}

/**
 * The two lines of one arm's state-machine readout, exactly:
 *   "L EXTENDED  ext 0.94 [######--] zone CHEST"
 *   "  EXTENDING>EXTENDED 180ms"
 * with " PAUSED" appended to the first line while confidence froze the
 * machine, and "-" on the second before any transition happened. The state
 * token is padded so the ext column never shifts between states. A
 * zero-duration transition is an instantaneous phase ENTRY edge, not a
 * timed traversal, so its "0ms" is suppressed (review r5p2 LOW: constant
 * "RETRACTED>EXTENDING 0ms" read like a timing bug next to the real
 * traversal timings). Pure.
 */
export function formatArmDebug(label: string, arm: ArmDebugState): [string, string] {
  const paused = arm.paused ? ' PAUSED' : '';
  const line1 =
    `${label} ${arm.state.padEnd(9, ' ')} ext ${arm.extension.toFixed(2)} ` +
    `${extensionBar(arm.extension)} zone ${arm.zone}${paused}`;
  const tr = arm.lastTransition;
  const line2 =
    tr === null
      ? '  -'
      : tr.tookMs > 0
        ? `  ${tr.from}>${tr.to} ${tr.tookMs.toFixed(0)}ms`
        : `  ${tr.from}>${tr.to}`;
  return [line1, line2];
}

/**
 * After this long without a new engine frame the input line reads STALE.
 * Longer than one HUD refresh interval and several 14fps frame gaps, so a
 * normal capture cadence never flickers the flag; genuine input death (the
 * tracking-loss overlay pausing engine updates, a camera stall) shows
 * within a second (review r5p2 MEDIUM: frozen arm lines were
 * indistinguishable from a deliberately held pose).
 */
export const INPUT_STALE_AFTER_MS = 600;

/** The input freshness line: "input  live", "input  STALE 12.3s", or the
 *  before-any-frames placeholder. Pure. */
export function formatInputLine(hasFrames: boolean, staleForMs: number): string {
  if (!hasFrames) return 'input  - (no frames yet)';
  if (staleForMs < INPUT_STALE_AFTER_MS) return 'input  live';
  return `input  STALE ${(staleForMs / 1000).toFixed(1)}s`;
}

export interface DebugHudInputs {
  engine: PhaseMoveEngine;
  frame: LandmarkFrame | null;
  profile: MotionProfile | null;
  parallax: { yaw: number; pitch: number; offset: { x: number; y: number; z: number } };
  parallaxYawSign: number;
  /** Measured pipeline rates; omit/null on paths without live tracking. */
  rates?: RatesBlock | null;
}

export class DebugHud {
  private readonly el: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly ratesEl: HTMLElement;
  private lastUpdateMs = -Infinity;
  private lastText = '';
  private lastRatesText = '';
  private visibleState = false;
  /** Wall-clock staleness tracking: the engine's lastFrameT is a frame-time
   *  value, so freshness is measured by WHEN it last changed on our clock. */
  private lastSeenFrameT: number | null = null;
  private frameTChangedWallMs = -Infinity;
  /** Wall-clock age of the last emitted aim/move (review r5p2 LOW: the
   *  readout persisted unchanged with no way to tell how old it was). */
  private lastMoveKey = '';
  private lastMoveWallMs = -Infinity;

  constructor(root: HTMLElement) {
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.top = '12px';
    el.style.right = '12px';
    // FIXED width (review r5p2 MEDIUM): with only max-width set, the
    // right-anchored box resized with the longest line and its left edge
    // lurched as zone tokens swapped (CHEST vs LATERAL_INNER). Wide enough
    // for the longest state line (padded state + ext + bar + ABOVE_SHOULDER
    // + PAUSED) at 11px Consolas; border-box keeps the footprint at the
    // 420px the panel already established.
    el.style.width = '420px';
    el.style.boxSizing = 'border-box';
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
    // Two children: the fixed-line-count engine text block, then the RATES
    // block LAST (its own element so the degraded-handHz reading can carry a
    // color span, and so any variable content can never shift the state
    // block above it). The near-miss log is gone: the phase engine has no
    // near-miss ring.
    const textEl = document.createElement('div');
    const ratesEl = document.createElement('div');
    el.append(textEl, ratesEl);
    root.appendChild(el);
    this.el = el;
    this.textEl = textEl;
    this.ratesEl = ratesEl;
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

    // Freshness bookkeeping runs on every refresh, cheap scalar compares.
    const frameT = inputs.engine.lastFrameT;
    if (frameT !== this.lastSeenFrameT) {
      this.lastSeenFrameT = frameT;
      this.frameTChangedWallMs = nowMs;
    }
    const d = inputs.engine.debugState;
    const aim = d.lastAim;
    const moveKey =
      d.lastMove === null || aim === null
        ? ''
        : `${d.lastMove}|${aim.x.toFixed(3)},${aim.y.toFixed(3)},${aim.z.toFixed(3)}`;
    if (moveKey !== this.lastMoveKey) {
      this.lastMoveKey = moveKey;
      this.lastMoveWallMs = nowMs;
    }

    const text = this.compose(inputs, nowMs);
    if (text !== this.lastText) {
      this.lastText = text;
      this.textEl.textContent = text;
    }
    this.updateRates(inputs.rates ?? null);
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

  private compose(inputs: DebugHudInputs, nowMs: number): string {
    const { engine, frame, profile, parallax, parallaxYawSign } = inputs;
    const lines: string[] = [];

    // Input freshness first: a frozen arm block below must be attributable
    // to dead input at a glance, not mistaken for a held pose.
    lines.push(
      formatInputLine(this.lastSeenFrameT !== null, nowMs - this.frameTChangedWallMs),
    );

    // Per-arm phase machines. The debugState children are reused in place
    // by the engine: fields are read into strings here and never retained.
    const d = engine.debugState;
    lines.push(...formatArmDebug('L', d.left));
    lines.push(...formatArmDebug('R', d.right));

    // AIM READOUT: the last emitted aim as yaw/pitch degrees plus its raw
    // screen-space components, then the move that carried it. Fixed line
    // count in both states so the blocks below never shift.
    const aim = d.lastAim;
    if (aim !== null) {
      const ang = aimAnglesDeg(aim);
      lines.push(
        `aim  yaw ${signedFixed(ang.yawDeg, 1)}deg pitch ${signedFixed(ang.pitchDeg, 1)}deg`,
      );
      lines.push(`  raw ${aim.x.toFixed(3)} ${aim.y.toFixed(3)} ${aim.z.toFixed(3)}`);
    } else {
      lines.push('aim  - (no move emitted yet)');
      lines.push('  raw -');
    }
    // The move line carries its age once it is a second old: the readout
    // legitimately persists between moves and needed a way to say so.
    const ageMs = nowMs - this.lastMoveWallMs;
    const ageSuffix =
      d.lastMove !== null && Number.isFinite(ageMs) && ageMs >= 1000
        ? ` (${(ageMs / 1000).toFixed(0)}s ago)`
        : '';
    lines.push(`last move  ${d.lastMove ?? '-'}${ageSuffix}`);

    // Engine state, live learned reach, and the profile's calibrated seeds
    // (shoulder-width units; "-" for a profile predating the reach fields).
    lines.push(
      `state  sustain:${engine.activeSustain ?? '-'} breath:${engine.breath.toFixed(0)}`,
    );
    const reach = engine.learnedReach;
    lines.push(`reach  L ${reach.left.toFixed(2)}sw R ${reach.right.toFixed(2)}sw`);
    if (profile) {
      const seed = (v: number | undefined): string =>
        v !== undefined ? `${v.toFixed(2)}sw` : '-';
      lines.push(
        `profile  seeds L ${seed(profile.maxReachLeftSw)} R ${seed(profile.maxReachRightSw)}`,
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
}
