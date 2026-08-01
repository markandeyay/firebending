/**
 * Frame-stream resampling for the framerate stress harness (phase-engine
 * eval, 2026-07-31 rebuild). The claim under test: the phase engine reads
 * POSITIONS and uses time only as sanity windows, so the same recorded
 * trajectory sampled at 10, 14, 20 or 30 fps must fire the same events.
 * This module manufactures those alternate samplings from one real take.
 *
 * DOWNSAMPLE (target rate at or below the recording's native rate):
 * nearest-frame decimation on t. Real frames are KEPT VERBATIM, never
 * blended: a decimated stream is exactly what a slower camera would have
 * delivered, dropped frames and all.
 *
 * UPSAMPLE (target rate above native): a uniform grid where every grid time
 * that does not coincide with a real frame is LINEARLY INTERPOLATED between
 * its two bracketing real frames. Positions interpolate (that is the point:
 * position signals survive resampling, derivatives do not); confidences
 * lerp; a hand present on only one side of the gap stays null (an appearing
 * or vanishing hand is a tracking event, not a position to invent).
 * Interpolated POSE frames get pose.interpolated = true and pose.t = the
 * interpolation target time, mirroring the live worker path
 * (tracking/types.ts PoseFrame), so consumers that must skip lerped samples
 * (BodyFrameTracker, the legacy elbow tracker) see exactly the live shape.
 */

import type {
  HandFrame,
  LandmarkFrame,
  PoseArm,
  PoseFrame,
  Vec3,
} from '../src/tracking/types';

/** Time tolerance for "grid point coincides with a real frame", ms. */
const T_EPS = 1e-6;

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function lerpVec3(a: Vec3, b: Vec3, u: number): Vec3 {
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u) };
}

function lerpArm(a: PoseArm, b: PoseArm, u: number): PoseArm {
  return {
    shoulder: lerpVec3(a.shoulder, b.shoulder, u),
    elbow: lerpVec3(a.elbow, b.elbow, u),
    wrist: lerpVec3(a.wrist, b.wrist, u),
    hip: lerpVec3(a.hip, b.hip, u),
  };
}

/**
 * Interpolated hand: both neighbors must carry the hand with the same
 * landmark count, else null (absence is a tracking event; the drill's fast
 * punches lose the hand, and inventing one would fake a signal the live
 * pipeline never has).
 */
function lerpHand(a: HandFrame | null, b: HandFrame | null, u: number): HandFrame | null {
  if (a === null || b === null) return null;
  if (a.landmarks.length !== b.landmarks.length) return null;
  const out: HandFrame = {
    landmarks: a.landmarks.map((p, i) => lerpVec3(p, b.landmarks[i] ?? p, u)),
    confidence: lerp(a.confidence, b.confidence, u),
  };
  const aw = a.world;
  const bw = b.world;
  if (aw !== undefined && bw !== undefined && aw.length === bw.length) {
    out.world = aw.map((p, i) => lerpVec3(p, bw[i] ?? p, u));
  }
  return out;
}

/**
 * Interpolated pose sample: positions lerp, interpolated = true, t = the
 * grid target (the live worker path's contract for lerped samples). A pose
 * present on only one side is sample-and-held; identical neighbor sample
 * timestamps mean no new detection crossed the gap, so the held sample is
 * returned as-is (holding is the live behavior, and BodyFrameTracker
 * already dedupes on pose.t).
 */
function lerpPose(
  a: PoseFrame | null,
  b: PoseFrame | null,
  u: number,
  targetT: number,
): PoseFrame | null {
  if (a === null && b === null) return null;
  if (a === null || b === null) return a ?? b;
  if (a.t === b.t) return a;
  const out: PoseFrame = {
    t: targetT,
    left: lerpArm(a.left, b.left, u),
    right: lerpArm(a.right, b.right, u),
    world:
      a.world !== null && b.world !== null
        ? {
            left: lerpArm(a.world.left, b.world.left, u),
            right: lerpArm(a.world.right, b.world.right, u),
          }
        : null,
    confidence: lerp(a.confidence, b.confidence, u),
    interpolated: true,
  };
  const av = a.wristVisibility;
  const bv = b.wristVisibility;
  if (av !== undefined && bv !== undefined) {
    out.wristVisibility = {
      left: lerp(av.left, bv.left, u),
      right: lerp(av.right, bv.right, u),
    };
  }
  return out;
}

function lerpFrame(a: LandmarkFrame, b: LandmarkFrame, u: number, targetT: number): LandmarkFrame {
  return {
    t: targetT,
    left: lerpHand(a.left, b.left, u),
    right: lerpHand(a.right, b.right, u),
    face: null,
    pose: lerpPose(a.pose ?? null, b.pose ?? null, u, targetT),
  };
}

function decimate(frames: LandmarkFrame[], stepMs: number): LandmarkFrame[] {
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (first === undefined || last === undefined) return [];
  const out: LandmarkFrame[] = [];
  let idx = 0;
  let lastIdx = -1;
  for (let target = first.t; target <= last.t + T_EPS; target += stepMs) {
    // Advance to the frame nearest the grid time (targets ascend, so the
    // walk is monotonic and each frame is visited at most once).
    while (idx + 1 < frames.length) {
      const cur = frames[idx];
      const next = frames[idx + 1];
      if (cur === undefined || next === undefined) break;
      if (Math.abs(next.t - target) <= Math.abs(cur.t - target)) idx++;
      else break;
    }
    if (idx !== lastIdx) {
      const f = frames[idx];
      if (f !== undefined) out.push(f);
      lastIdx = idx;
    }
  }
  return out;
}

function interpolate(frames: LandmarkFrame[], stepMs: number): LandmarkFrame[] {
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (first === undefined || last === undefined) return [];
  const out: LandmarkFrame[] = [];
  let i = 0;
  for (let target = first.t; target <= last.t + T_EPS; target += stepMs) {
    while (i + 1 < frames.length) {
      const next = frames[i + 1];
      if (next !== undefined && next.t <= target) i++;
      else break;
    }
    const a = frames[i];
    const b = frames[Math.min(i + 1, frames.length - 1)];
    if (a === undefined || b === undefined) continue;
    if (Math.abs(a.t - target) < T_EPS || b.t <= a.t) {
      out.push(a); // grid point sits on a real frame: keep it verbatim
      continue;
    }
    const u = (target - a.t) / (b.t - a.t);
    out.push(lerpFrame(a, b, u, target));
  }
  return out;
}

/** Median inter-frame gap of a stream, ms (0 for streams under 2 frames). */
export function medianGapMs(frames: LandmarkFrame[]): number {
  if (frames.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const cur = frames[i];
    if (prev !== undefined && cur !== undefined) gaps.push(cur.t - prev.t);
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 0;
}

/**
 * Resample a frame stream to the target rate: decimation when the target
 * step is at or above the stream's native median gap (a slower camera),
 * grid interpolation when below (a faster one). Returns a new array; the
 * input is never mutated, and decimated output shares frame objects with
 * the input by design.
 */
export function resampleFrames(frames: LandmarkFrame[], fps: number): LandmarkFrame[] {
  if (frames.length < 2 || !(fps > 0) || !Number.isFinite(fps)) return frames.slice();
  const stepMs = 1000 / fps;
  const native = medianGapMs(frames);
  return stepMs >= native - T_EPS ? decimate(frames, stepMs) : interpolate(frames, stepMs);
}
