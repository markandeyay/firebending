/**
 * Shared synthesis helpers for the phase-engine suite: build LandmarkFrames
 * with BODY POSE from a continuous trajectory sampled at ARBITRARY fps.
 * The point of the sampling helper is to prove framerate independence: the
 * same trajectory run at 10 and 30 fps must fire the same events, because
 * the phase engine reads positions and uses time only as sanity windows.
 *
 * Geometry: a player squarely facing the camera, shoulders at y 0.35 and
 * 0.32 apart (the reference shoulder width), hips at y 0.72. All canonical
 * wrist positions below are chosen against the phase-engine constants and
 * annotated with their extension / zone so tests stay readable.
 */

import type {
  HandFrame,
  LandmarkFrame,
  PoseArm,
  PoseFrame,
} from '../src/tracking/types';
import { placePose, type PoseName } from '../fixtures/lib';
import type { MoveEvent } from '../src/gestures/moves';
import { PhaseMoveEngine, type PhaseMoveEngineConfig } from '../src/gestures/phaseEngine';

export interface Pt {
  x: number;
  y: number;
}

export const L_SHOULDER: Pt = { x: 0.34, y: 0.35 };
export const R_SHOULDER: Pt = { x: 0.66, y: 0.35 };
export const L_HIP_JOINT: Pt = { x: 0.4, y: 0.72 };
export const R_HIP_JOINT: Pt = { x: 0.6, y: 0.72 };
/** Shoulder width of the synthetic body (the body-space scale unit). */
export const SHOULDER_W = 0.32;

// Canonical wrist positions (extension figures assume the uncalibrated
// forward-punch prior maxReach 0.85 sw, i.e. 0.272 screen units of reach).
/** Guard/chamber: ~0.30 extension, RETRACTED. */
export const GUARD_L: Pt = { x: 0.38, y: 0.42 };
export const GUARD_R: Pt = { x: 0.62, y: 0.42 };
/** Forward punch: ~0.87 extension, CHEST zone. */
export const PUNCH_L: Pt = { x: 0.4, y: 0.58 };
export const PUNCH_R: Pt = { x: 0.6, y: 0.58 };
/** Wrists parked at the hips: HIP zone, ~1.48 extension (foreshortening:
 *  a hanging arm reads far beyond a forward punch). */
export const HIPS_L: Pt = { x: 0.38, y: 0.75 };
export const HIPS_R: Pt = { x: 0.62, y: 0.75 };
/** Overhead: ABOVE_SHOULDER zone, ~0.57 extension. */
export const OVERHEAD_L: Pt = { x: 0.38, y: 0.2 };
export const OVERHEAD_R: Pt = { x: 0.62, y: 0.2 };
/** Twin chamber: wrists together at the sternum, CHEST zone, 0.10 apart. */
export const TWIN_L: Pt = { x: 0.45, y: 0.44 };
export const TWIN_R: Pt = { x: 0.55, y: 0.44 };
/** Twin thrust targets: both arms extended forward, CHEST zone. */
export const TWIN_PUNCH_L: Pt = { x: 0.42, y: 0.58 };
export const TWIN_PUNCH_R: Pt = { x: 0.58, y: 0.58 };
/** Whip hold (right arm): LATERAL_INNER band, raised. */
export const WHIP_HOLD_R: Pt = { x: 0.8, y: 0.45 };
/** Whip swing target: LATERAL_OUTER band. */
export const WHIP_OUT_R: Pt = { x: 0.95, y: 0.45 };
/** Deep hanging rest (arms dropped to the sides): HIP zone, ~1.84 ext. */
export const HANG_L: Pt = { x: 0.36, y: 0.85 };
export const HANG_R: Pt = { x: 0.64, y: 0.85 };

/** One trajectory sample: wrist positions plus optional hand poses (null /
 *  absent hand = untracked, the drill's normal state during fast motion). */
export interface TrajSample {
  left: Pt;
  right: Pt;
  leftHand?: PoseName | null;
  rightHand?: PoseName | null;
  /** Pose confidence override (default 1). */
  confidence?: number;
}

export type Trajectory = (tMs: number) => TrajSample;

function arm(sh: Pt, hip: Pt, wrist: Pt): PoseArm {
  return {
    shoulder: { x: sh.x, y: sh.y, z: 0 },
    elbow: { x: (sh.x + wrist.x) / 2, y: (sh.y + wrist.y) / 2, z: 0 },
    wrist: { x: wrist.x, y: wrist.y, z: 0 },
    hip: { x: hip.x, y: hip.y, z: 0 },
  };
}

/** A pose SAMPLE at time t (every frame is a real sample in these tests). */
export function poseAt(t: number, lw: Pt, rw: Pt, confidence = 1): PoseFrame {
  return {
    t,
    left: arm(L_SHOULDER, L_HIP_JOINT, lw),
    right: arm(R_SHOULDER, R_HIP_JOINT, rw),
    world: null,
    confidence,
  };
}

export function handAt(pose: PoseName, wrist: Pt, side: 'left' | 'right'): HandFrame {
  return {
    landmarks: placePose(pose, { x: wrist.x, y: wrist.y, z: -0.05 }, side),
    confidence: 0.95,
  };
}

export function frameAt(t: number, s: TrajSample): LandmarkFrame {
  return {
    t,
    left: s.leftHand ? handAt(s.leftHand, s.left, 'left') : null,
    right: s.rightHand ? handAt(s.rightHand, s.right, 'right') : null,
    face: null,
    pose: poseAt(t, s.left, s.right, s.confidence ?? 1),
  };
}

/** Sample a trajectory at the given fps into LandmarkFrames. */
export function sampleFrames(
  traj: Trajectory,
  durationMs: number,
  fps: number,
): LandmarkFrame[] {
  const dt = 1000 / fps;
  const frames: LandmarkFrame[] = [];
  for (let t = 0; t <= durationMs; t += dt) {
    frames.push(frameAt(t, traj(t)));
  }
  return frames;
}

/** Keyframe for piecewise-linear trajectories. Wrists lerp between keys;
 *  hand poses come from the SEGMENT-START key (no hand interpolation). */
export interface TrajKey {
  t: number;
  left: Pt;
  right: Pt;
  leftHand?: PoseName | null;
  rightHand?: PoseName | null;
  confidence?: number;
}

function lerpPt(a: Pt, b: Pt, u: number): Pt {
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

/** Build a piecewise-linear trajectory from keyframes (sorted by t). */
export function keyframeTraj(keys: TrajKey[]): Trajectory {
  return (tMs: number): TrajSample => {
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (!first || !last) throw new Error('keyframeTraj needs keys');
    if (tMs <= first.t) return sampleFrom(first, first, 0);
    if (tMs >= last.t) return sampleFrom(last, last, 0);
    for (let i = 0; i + 1 < keys.length; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (!a || !b) continue;
      if (tMs >= a.t && tMs < b.t) {
        const u = (tMs - a.t) / (b.t - a.t);
        return sampleFrom(a, b, u);
      }
    }
    return sampleFrom(last, last, 0);
  };
}

function sampleFrom(a: TrajKey, b: TrajKey, u: number): TrajSample {
  const s: TrajSample = {
    left: lerpPt(a.left, b.left, u),
    right: lerpPt(a.right, b.right, u),
  };
  if (a.leftHand !== undefined) s.leftHand = a.leftHand;
  if (a.rightHand !== undefined) s.rightHand = a.rightHand;
  if (a.confidence !== undefined) s.confidence = a.confidence;
  return s;
}

/** Drive frames through a fresh PhaseMoveEngine. */
export function runPhaseEngine(
  frames: LandmarkFrame[],
  config?: PhaseMoveEngineConfig,
): { events: MoveEvent[]; engine: PhaseMoveEngine } {
  const engine = new PhaseMoveEngine(config);
  const events: MoveEvent[] = [];
  for (const f of frames) events.push(...engine.update(f));
  return { events, engine };
}

/** Compact (move, kind, hand) signature for cross-fps comparisons. */
export function signature(events: MoveEvent[]): string[] {
  return events
    .filter((e) => e.kind === 'trigger' || e.kind === 'sustain-start' || e.kind === 'sustain-end')
    .map((e) => `${e.move}:${e.kind}:${e.hand}`);
}
