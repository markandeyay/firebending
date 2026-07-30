/**
 * Debug HUD (D key in the arena): a translucent charcoal overlay panel in the
 * top-right corner showing the move engine's live internals per hand (pose
 * scores + active flags, windowed speed, span growth, thrust/whip arming),
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

/** Short move labels for near-miss lines. */
const SHORT_NAME: Partial<Record<MoveName, string>> = {
  'jab-blast': 'JAB',
  'palm-wave': 'PALM',
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
}

/** One near-miss line, formatted exactly as specified. */
export function formatNearMiss(rec: NearMissRecord): string {
  const name = SHORT_NAME[rec.move] ?? rec.move.toUpperCase();
  return (
    `${name}: ${rec.condition} ${rec.value.toFixed(2)}` +
    ` vs threshold ${rec.threshold.toFixed(2)} FAIL`
  );
}

export class DebugHud {
  private readonly el: HTMLElement;
  private lastUpdateMs = -Infinity;
  private lastText = '';
  private readonly missScratch: NearMissRecord[] = [];
  private visibleState = false;

  constructor(root: HTMLElement) {
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.top = '12px';
    el.style.right = '12px';
    el.style.maxWidth = '360px';
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
    root.appendChild(el);
    this.el = el;
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
      this.el.textContent = text;
    }
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
          `palm ${s.palm.toFixed(2)}${flag(s.palmActive)} ` +
          `grip ${s.grip.toFixed(2)}${flag(s.gripActive)}`,
      );
      lines.push(
        `    speed ${m.speed.toFixed(2)} growth ${m.growth.toFixed(2)} ` +
          `thrust:${m.thrustFamily ?? '-'} whip:${m.whipArmed ? 'armed' : '-'}`,
      );
    };

    hand('L', 'left', scores.left);
    hand('R', 'right', scores.right);

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
        `retract ${th.retractShrink.toFixed(2)}`,
    );
    lines.push(
      `  rise ${th.risingUpVel.toFixed(2)} whipVx ${th.whipSwingVx.toFixed(2)} ` +
        `static ${th.whipStaticMax.toFixed(2)}/${th.breathStaticMax.toFixed(2)} ` +
        `aim ${th.aimMinSpeed.toFixed(2)}`,
    );
    if (profile) {
      lines.push(
        `profile  punch ${profile.peakPunchSpeed.toFixed(2)}u/s ` +
          `${profile.peakPunchGrowth.toFixed(2)}/s ` +
          `palm ${profile.peakPalmSpeed.toFixed(2)}u/s ` +
          `${profile.peakPalmGrowth.toFixed(2)}/s`,
      );
      lines.push(
        `  neutral ${profile.neutralSpeed.toFixed(3)}u/s ` +
          `${profile.neutralGrowth.toFixed(3)}/s`,
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

    // Near-miss trace.
    lines.push('near misses');
    const misses = engine.nearMisses(this.missScratch);
    if (misses.length === 0) {
      lines.push('  -');
    } else {
      for (const rec of misses) lines.push(`  ${formatNearMiss(rec)}`);
    }

    return lines.join('\n');
  }
}
