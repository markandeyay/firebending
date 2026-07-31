/**
 * Region-of-interest (ROI) cropping math for hand tracking.
 *
 * THE FRAMING TENSION THIS SOLVES: standing close to the camera gives the
 * hand model big, crisp hands but crops the body so pose elbows get noisy;
 * standing far gives clean pose but hands too small for reliable landmarks.
 * The fix: pose finds the wrists on the FULL frame (it only needs large
 * joints), then hand detection runs on an upscaled square CROP around each
 * wrist, so the hand model always sees a large hand regardless of player
 * distance. This module is the pure math for that pipeline: crop box
 * placement, temporal smoothing of the box, exact crop<->full coordinate
 * mapping, per-frame path selection, and the pose-side to frame-slot
 * handedness mapping. No DOM, no MediaPipe; everything is unit-testable
 * headless. The impure plumbing (canvases, detectForVideo) lives in
 * liveSource.ts.
 *
 * COORDINATE SPACE: all boxes and points here are normalized [0..1] in the
 * RAW (unmirrored) camera image, top-left origin, x right, y down. The
 * caller unmirrors player-space pose joints with playerToRaw() before
 * calling in, and mirrors detected hand landmarks back to player space
 * after mapCropToFull (see cropHandToPlayer).
 *
 * HANDEDNESS ON THE CROP PATH (mapping table, derived from the convention
 * documented in handSource.ts):
 *
 *   pose side        raw-image location   crop feeds   frame slot
 *   ---------        ------------------   ----------   ----------
 *   left  (anat.)    image RIGHT half     left crop    frame.left
 *   right (anat.)    image LEFT half      right crop   frame.right
 *
 * PoseLandmarker indices are ANATOMICAL (landmark 15 is the person's own
 * left wrist, wherever it appears in the image), so the hand found inside
 * the pose-left wrist crop IS the player's left hand, and after the same
 * x -> 1 - x mirroring the full-frame path uses, it lands on the left of
 * the mirrored view, exactly where frame.left belongs. The MediaPipe
 * handedness label (which the full-frame path must invert, label Right ->
 * frame.left) is IGNORED on the crop path: the pose side is ground truth,
 * which eliminates handedness-label flips entirely. frameSlotForPoseSide()
 * is therefore the identity, kept as a named function so the mapping is
 * explicit and unit-tested rather than implicit.
 */

import type { HandFrame, Vec3 } from './types';
import { HAND_LANDMARK_COUNT } from './types';
import type { RawLandmark } from './handSource';
import { mirrorLandmarks, mirrorWorldLandmarks } from './handSource';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Crop side = forearm length times this (hand plus generous margin). */
export const CROP_SIDE_SCALE = 2.4;
/** Minimum crop side, normalized width units (far player, tiny forearm). */
export const CROP_SIDE_MIN = 0.14;
/** Maximum crop side, normalized width units (close player). */
export const CROP_SIDE_MAX = 0.5;
/** Center shift toward the fingers, as a fraction of the side. */
export const CROP_FORWARD_SHIFT = 0.15;
/** Exponential smoothing time constant for the crop box, ms. */
export const CROP_TAU_MS = 120;
/** Ignore center moves smaller than this fraction of the current side. */
export const CROP_CENTER_DEADBAND = 0.04;
/** Ignore relative size changes smaller than this fraction. */
export const CROP_SIZE_DEADBAND = 0.08;
/** Pose sample older than this is stale; that side falls back to full frame. */
export const POSE_FRESH_MS = 250;
/** Minimum pose wrist visibility for the crop path. */
export const WRIST_VISIBILITY_MIN = 0.5;
/** Pixel size of the square canvas each crop is upscaled into. */
export const CROP_SIZE_PX = 256;

// ---------------------------------------------------------------------------
// Crop box
// ---------------------------------------------------------------------------

/**
 * A crop rectangle in normalized raw-image coordinates, top-left origin.
 * The box is SQUARE IN PIXELS, not in normalized units: with frame aspect
 * a = width/height, h = w * a so that w * frameWidth === h * frameHeight.
 * Pixel-squareness matters because the crop is upscaled into a square
 * CROP_SIZE_PX canvas; a normalized-square box would stretch the hand.
 */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A 2D point (z ignored); Vec3 works too. */
export interface Point2 {
  x: number;
  y: number;
}

/**
 * Clamp a box inside [0,1] x [0,1] by shifting it, shrinking (uniformly,
 * preserving pixel-squareness) only when a dimension simply cannot fit.
 * Pure; returns a fresh box.
 */
export function clampBoxToFrame(box: CropBox): CropBox {
  let { x, y, w, h } = box;
  // Shrink only if the box is bigger than the frame in some dimension.
  const scale = Math.min(1, 1 / w, 1 / h);
  if (scale < 1) {
    // Shrink about the center so the subject stays centered.
    const cx = x + w / 2;
    const cy = y + h / 2;
    w *= scale;
    h *= scale;
    x = cx - w / 2;
    y = cy - h / 2;
  }
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > 1) x = 1 - w;
  if (y + h > 1) y = 1 - h;
  return { x, y, w, h };
}

/**
 * Compute the crop box for one wrist from the pose wrist and elbow (raw
 * image space, normalized). Side = clamp(forearmLength * CROP_SIDE_SCALE,
 * CROP_SIDE_MIN, CROP_SIDE_MAX) in normalized width units; the box is
 * square in pixels (h = w * frameAspect, frameAspect = width/height). The
 * center is the wrist shifted CROP_FORWARD_SHIFT * side along the
 * elbow->wrist direction, because the hand extends beyond the wrist toward
 * the fingers, not back along the forearm. The result is clamped inside
 * the frame without changing size unless the frame is too small to hold it.
 */
export function cropBoxForWrist(
  wrist: Point2,
  elbow: Point2,
  frameAspect: number,
): CropBox {
  const fx = wrist.x - elbow.x;
  const fy = wrist.y - elbow.y;
  const forearm = Math.sqrt(fx * fx + fy * fy);
  const side = Math.min(CROP_SIDE_MAX, Math.max(CROP_SIDE_MIN, forearm * CROP_SIDE_SCALE));

  let cx = wrist.x;
  let cy = wrist.y;
  if (forearm > 1e-9) {
    const shift = (CROP_FORWARD_SHIFT * side) / forearm;
    cx += fx * shift;
    cy += fy * shift;
  }

  const w = side;
  const h = side * frameAspect;
  return clampBoxToFrame({ x: cx - w / 2, y: cy - h / 2, w, h });
}

/** True when the point lies inside the box (inclusive edges). */
export function pointInBox(p: Point2, box: CropBox): boolean {
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}

// ---------------------------------------------------------------------------
// Temporal smoothing
// ---------------------------------------------------------------------------

export interface CropSmootherOptions {
  tauMs?: number;
  centerDeadbandFrac?: number;
  sizeDeadbandFrac?: number;
}

/**
 * Temporal smoother for a per-side crop box, so the crop neither jitters
 * (which would shake the hand inside the crop and defeat the hand model's
 * VIDEO-mode temporal tracking) nor breathes with pose noise.
 *
 * - Center and size converge exponentially toward the target with time
 *   constant tauMs (~120 ms).
 * - Deadbands: a target center within CROP_CENTER_DEADBAND of the current
 *   side is ignored (no drift), and a relative size change under
 *   CROP_SIZE_DEADBAND is ignored (no breathing).
 * - Snap-out: if the wrist has EXITED the current smoothed box (fast punch
 *   outran the smoothing), the smoother snaps to the target box immediately
 *   so the hand is never cropped out of its own crop.
 *
 * The output is re-clamped inside the frame because the deadbands can move
 * center and size independently of each other.
 */
export class CropSmoother {
  private readonly tauMs: number;
  private readonly centerDeadband: number;
  private readonly sizeDeadband: number;

  private cx = 0;
  private cy = 0;
  private w = 0;
  private h = 0;
  private lastTMs: number | null = null;

  constructor(options: CropSmootherOptions = {}) {
    this.tauMs = options.tauMs ?? CROP_TAU_MS;
    this.centerDeadband = options.centerDeadbandFrac ?? CROP_CENTER_DEADBAND;
    this.sizeDeadband = options.sizeDeadbandFrac ?? CROP_SIZE_DEADBAND;
  }

  /** The current smoothed box, or null before the first update. */
  get current(): CropBox | null {
    if (this.lastTMs === null) return null;
    return { x: this.cx - this.w / 2, y: this.cy - this.h / 2, w: this.w, h: this.h };
  }

  /**
   * Advance toward `target` given the wrist position (same raw normalized
   * space) and a monotonic timestamp in ms. Returns the smoothed box.
   */
  update(target: CropBox, wrist: Point2, tMs: number): CropBox {
    const current = this.current;
    if (current === null || !pointInBox(wrist, current)) {
      // First frame, or the wrist escaped the smoothed box: snap.
      const snapped = clampBoxToFrame(target);
      this.adopt(snapped);
      this.lastTMs = tMs;
      return snapped;
    }

    const dt = Math.max(0, tMs - (this.lastTMs ?? tMs));
    this.lastTMs = tMs;
    const alpha = 1 - Math.exp(-dt / this.tauMs);

    const tcx = target.x + target.w / 2;
    const tcy = target.y + target.h / 2;
    const dx = tcx - this.cx;
    const dy = tcy - this.cy;
    if (Math.sqrt(dx * dx + dy * dy) >= this.centerDeadband * this.w) {
      this.cx += dx * alpha;
      this.cy += dy * alpha;
    }

    if (this.w > 0 && Math.abs(target.w - this.w) / this.w >= this.sizeDeadband) {
      this.w += (target.w - this.w) * alpha;
      this.h += (target.h - this.h) * alpha;
    }

    const out = clampBoxToFrame({
      x: this.cx - this.w / 2,
      y: this.cy - this.h / 2,
      w: this.w,
      h: this.h,
    });
    // Keep the internal center consistent with the clamped output so the
    // snap-out test compares against the box that was actually cropped.
    this.cx = out.x + out.w / 2;
    this.cy = out.y + out.h / 2;
    this.w = out.w;
    this.h = out.h;
    return out;
  }

  private adopt(box: CropBox): void {
    this.cx = box.x + box.w / 2;
    this.cy = box.y + box.h / 2;
    this.w = box.w;
    this.h = box.h;
  }

  reset(): void {
    this.lastTMs = null;
  }
}

// ---------------------------------------------------------------------------
// Coordinate mapping
// ---------------------------------------------------------------------------

/**
 * Map a landmark from crop-normalized space (as detected on the crop
 * canvas) into full-frame normalized space. Exact inverse of
 * mapFullToCrop. Z PASSES THROUGH UNSCALED: the screen-landmark z is a
 * model-relative depth hint, not a metric coordinate, and no linear crop
 * rescale would make it one; downstream depth reasoning uses the hand
 * WORLD landmarks, which are metric, hand-centered, and completely
 * unaffected by where in the image the hand was detected.
 */
export function mapCropToFull(lm: Vec3, box: CropBox): Vec3 {
  return { x: box.x + lm.x * box.w, y: box.y + lm.y * box.h, z: lm.z };
}

/** Map a full-frame normalized landmark into crop space. Inverse of mapCropToFull. */
export function mapFullToCrop(lm: Vec3, box: CropBox): Vec3 {
  return { x: (lm.x - box.x) / box.w, y: (lm.y - box.y) / box.h, z: lm.z };
}

/**
 * Unmirror a player-space point back into raw image space (x -> 1 - x).
 * Pose joints in PoseFrame are player space; the crop is drawn from the
 * raw video, so wrist and elbow go through this before cropBoxForWrist.
 */
export function playerToRaw(p: Vec3): Vec3 {
  return { x: 1 - p.x, y: p.y, z: p.z };
}

/**
 * Convert a hand detected on a crop into a player-space HandFrame:
 * crop -> full-frame raw coords (mapCropToFull), then the exact same
 * mirroring the full-frame path applies (mirrorLandmarks). World
 * landmarks are metric and hand-centered, so they skip the crop mapping
 * entirely and only get the standard world mirror. The MediaPipe
 * handedness label plays no part here; the caller assigns the frame slot
 * from the pose side (see frameSlotForPoseSide).
 */
export function cropHandToPlayer(
  landmarks: readonly RawLandmark[],
  world: readonly RawLandmark[] | undefined,
  score: number,
  box: CropBox,
): HandFrame {
  const full: Vec3[] = [];
  for (const lm of landmarks) full.push(mapCropToFull(lm, box));
  return {
    landmarks: mirrorLandmarks(full),
    confidence: score,
    ...(world && world.length >= HAND_LANDMARK_COUNT
      ? { world: mirrorWorldLandmarks(world) }
      : {}),
  };
}

/**
 * Frame slot for a pose-side crop. Identity by construction (see the
 * mapping table in the module doc): pose sides are anatomical, frame slots
 * are anatomical, and the mirroring that makes frame.left draw on the left
 * of the mirrored view is applied to the coordinates, not the labels.
 */
export function frameSlotForPoseSide(side: 'left' | 'right'): 'left' | 'right' {
  return side;
}

// ---------------------------------------------------------------------------
// Path selection
// ---------------------------------------------------------------------------

/**
 * Per-side, per-frame choice between the ROI crop path and the legacy
 * full-frame 2-hand path. Crop requires BOTH a fresh pose sample (within
 * POSE_FRESH_MS) and a visible wrist (visibility above
 * WRIST_VISIBILITY_MIN); anything less falls back to the full frame.
 * The caller must never run both paths for the same side in one frame:
 * a 'full' verdict means that side's slot comes from the (single) shared
 * full-frame detection, and 'crop' means it comes from that side's crop
 * detection only.
 */
export function selectHandPath(
  poseFresh: boolean,
  wristVisible: boolean,
): 'crop' | 'full' {
  return poseFresh && wristVisible ? 'crop' : 'full';
}
