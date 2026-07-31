/**
 * Dedicated hand-detection Worker (quality round Phase 1). Owns ALL THREE
 * HandLandmarker instances (the 2-hand full-frame fallback plus the two
 * 1-hand ROI crop instances) and the two OffscreenCanvas crop targets, so
 * detectForVideo's synchronous cost never lands on the main thread's frame
 * budget. Before this worker, hand inference ran synchronously inside
 * requestVideoFrameCallback and collapsed the frame callback rate to
 * whatever inference allowed (~14 fps observed in studio recordings).
 *
 * Protocol (all messages are plain structured-clone data):
 *   main -> worker  { type: 'init', cropSizePx }
 *   worker -> main  { type: 'ready' } | { type: 'init-error', message }
 *   main -> worker  { type: 'frame', bitmap: ImageBitmap (TRANSFERRED),
 *                     timestampMs, crops: { left, right } }
 *                   crops.<side> is the normalized raw-image CropBox to run
 *                   that side's 1-hand crop detect on, or null to leave the
 *                   side to the full-frame 2-hand detect. The MAIN thread
 *                   computes the boxes (pure roiCrop.ts math on the held
 *                   pose) and KEEPS them: it needs the exact box to map crop
 *                   landmarks back to full-frame space when the result
 *                   returns.
 *   worker -> main  { type: 'result', timestampMs, crop: { left, right },
 *                     full, detectMs }
 *                   crop.<side>: the RAW top-scoring hand detected in that
 *                   side's crop ({ landmarks, world?, score }, crop-local
 *                   normalized coords) or null (no box sent / no hand).
 *                   full: RAW labeled hands from the full-frame detect
 *                   (null when both sides had crop boxes and it never ran).
 *                   detectMs: total in-worker detect+draw cost (stats only).
 *                   ALL pure coordinate math (cropHandToPlayer, mirroring,
 *                   normalizeHands, frameSlotForPoseSide) runs on the MAIN
 *                   thread so it stays unit-testable, exactly like the pose
 *                   worker's extraction split.
 *
 * BACKPRESSURE is the caller's job (LatestWinsChannel in liveSource.ts):
 * at most ONE frame in flight, a newer capture REPLACES a parked pending
 * one. The worker itself answers every frame it is handed, in order.
 * Timestamps are strictly increasing PER INSTANCE (VIDEO mode requirement):
 * each landmarker keeps its own monotonic clamp because the crop instances
 * are not called on every frame.
 *
 * MediaPipe is imported dynamically inside init (via createHandLandmarker)
 * so the worker script stays tiny and headless tests never load WASM.
 */

import type { HandLandmarker } from '@mediapipe/tasks-vision';
import { installWorkerWasmShim } from './workerWasmShim';
import { createHandLandmarker } from './handSource';
import type { RawHand, RawLandmark } from './handSource';
import type { CropBox } from './roiCrop';
import { HAND_LANDMARK_COUNT } from './types';

export interface HandWorkerInitMsg {
  type: 'init';
  /** Pixel edge of the square crop canvases (CROP_SIZE_PX). */
  cropSizePx: number;
}

export interface HandWorkerFrameMsg {
  type: 'frame';
  bitmap: ImageBitmap;
  timestampMs: number;
  crops: { left: CropBox | null; right: CropBox | null };
}

export type HandWorkerRequest = HandWorkerInitMsg | HandWorkerFrameMsg;

export interface HandWorkerReadyMsg {
  type: 'ready';
}

export interface HandWorkerInitErrorMsg {
  type: 'init-error';
  message: string;
}

/** The raw top-scoring hand from a crop detect (crop-local coords). */
export interface RawCropHand {
  landmarks: RawLandmark[];
  world?: RawLandmark[];
  score: number;
}

export interface HandWorkerResultMsg {
  type: 'result';
  timestampMs: number;
  crop: { left: RawCropHand | null; right: RawCropHand | null };
  /** Raw labeled hands from the full-frame 2-hand detect, or null when it
   * did not run (both sides were covered by crops). */
  full: RawHand[] | null;
  /** Wall-clock draw+detect cost inside the worker, ms (stats only). */
  detectMs: number;
}

export type HandWorkerResponse =
  | HandWorkerReadyMsg
  | HandWorkerInitErrorMsg
  | HandWorkerResultMsg;

/** Strip MediaPipe landmark objects to plain clonable data. */
function plain(lms: ReadonlyArray<{ x: number; y: number; z: number }>): RawLandmark[] {
  return lms.map((p) => ({ x: p.x, y: p.y, z: p.z }));
}

interface DetectResultLike {
  landmarks: ReadonlyArray<ReadonlyArray<{ x: number; y: number; z: number }>>;
  worldLandmarks: ReadonlyArray<ReadonlyArray<{ x: number; y: number; z: number }>>;
  handedness: ReadonlyArray<ReadonlyArray<{ categoryName: string; score: number }>>;
}

/** Top-scoring raw hand of a detect result (the crop instances run 1-hand,
 * but defensively pick the max). Mirrors detectTopHand's selection. */
function topRawHand(result: DetectResultLike): RawCropHand | null {
  let best: RawCropHand | null = null;
  for (let i = 0; i < result.landmarks.length; i++) {
    const landmarks = result.landmarks[i];
    if (!landmarks || landmarks.length < HAND_LANDMARK_COUNT) continue;
    const score = result.handedness[i]?.[0]?.score ?? 1;
    if (best !== null && score <= best.score) continue;
    const world = result.worldLandmarks[i];
    best = {
      landmarks: plain(landmarks),
      score,
      ...(world ? { world: plain(world) } : {}),
    };
  }
  return best;
}

/** Raw labeled hands of the full-frame detect (plain-data RawHand[]). */
function rawLabeledHands(result: DetectResultLike): RawHand[] {
  const out: RawHand[] = [];
  for (let i = 0; i < result.landmarks.length; i++) {
    const landmarks = result.landmarks[i];
    const category = result.handedness[i]?.[0];
    if (!landmarks || !category) continue;
    const label = category.categoryName === 'Right' ? 'Right' : 'Left';
    const world = result.worldLandmarks[i];
    out.push({
      landmarks: plain(landmarks),
      label,
      score: category.score,
      ...(world ? { world: plain(world) } : {}),
    });
  }
  return out;
}

interface SideState {
  landmarker: HandLandmarker | null;
  canvas: OffscreenCanvas | null;
  ctx: OffscreenCanvasRenderingContext2D | null;
  /** Per-instance strictly-increasing timestamp clamp (VIDEO mode). */
  lastTs: number;
}

let fullLandmarker: HandLandmarker | null = null;
let fullLastTs = -1;
const sides: { left: SideState; right: SideState } = {
  left: { landmarker: null, canvas: null, ctx: null, lastTs: -1 },
  right: { landmarker: null, canvas: null, ctx: null, lastTs: -1 },
};

const scope = self as unknown as {
  postMessage(msg: HandWorkerResponse): void;
  onmessage: ((e: MessageEvent<HandWorkerRequest>) => void) | null;
};

// MODULE-worker wasm loading fix; must run before any createHandLandmarker.
installWorkerWasmShim();

function initSide(side: 'left' | 'right', landmarker: HandLandmarker, size: number): void {
  const s = sides[side];
  s.landmarker = landmarker;
  s.canvas = new OffscreenCanvas(size, size);
  s.ctx = s.canvas.getContext('2d');
  s.lastTs = -1;
}

/** Run one side's crop: draw the box region of the bitmap upscaled into the
 * side's canvas, then the 1-hand detect. Null when the side has no box or
 * the instance is not ready. */
function detectCropSide(
  side: 'left' | 'right',
  bitmap: ImageBitmap,
  box: CropBox | null,
  timestampMs: number,
): RawCropHand | null {
  const s = sides[side];
  if (!box || !s.landmarker || !s.ctx || !s.canvas) return null;
  const size = s.canvas.width;
  s.ctx.drawImage(
    bitmap,
    box.x * bitmap.width,
    box.y * bitmap.height,
    box.w * bitmap.width,
    box.h * bitmap.height,
    0,
    0,
    size,
    size,
  );
  const ts = Math.max(timestampMs, s.lastTs + 1);
  s.lastTs = ts;
  return topRawHand(s.landmarker.detectForVideo(s.canvas, ts) as DetectResultLike);
}

scope.onmessage = (e: MessageEvent<HandWorkerRequest>): void => {
  const msg = e.data;
  if (msg.type === 'init') {
    // SEQUENTIAL creation: MediaPipe's loader sets a ModuleFactory global
    // that each createFromOptions consumes and clears; parallel creations
    // race each other for it (observed as spurious "ModuleFactory not set"
    // GPU-delegate failures on the main thread's Promise.all path).
    void (async () => {
      fullLandmarker = await createHandLandmarker();
      initSide('left', await createHandLandmarker(1), msg.cropSizePx);
      initSide('right', await createHandLandmarker(1), msg.cropSizePx);
    })().then(
      () => scope.postMessage({ type: 'ready' }),
      (err: unknown) => {
        scope.postMessage({
          type: 'init-error',
          message: err instanceof Error ? err.message : String(err),
        });
      },
    );
    return;
  }
  // 'frame'
  const { bitmap, timestampMs, crops } = msg;
  try {
    const start = performance.now();
    const cropLeft = detectCropSide('left', bitmap, crops.left, timestampMs);
    const cropRight = detectCropSide('right', bitmap, crops.right, timestampMs);
    // Full-frame 2-hand detect covers only the sides WITHOUT a crop box; it
    // is skipped entirely when both sides cropped (the common tracked case).
    let full: RawHand[] | null = null;
    const needFull = crops.left === null || crops.right === null;
    if (needFull && fullLandmarker) {
      const ts = Math.max(timestampMs, fullLastTs + 1);
      fullLastTs = ts;
      full = rawLabeledHands(
        fullLandmarker.detectForVideo(bitmap, ts) as DetectResultLike,
      );
    }
    const detectMs = performance.now() - start;
    scope.postMessage({
      type: 'result',
      timestampMs,
      crop: { left: cropLeft, right: cropRight },
      full,
      detectMs,
    });
  } catch (err) {
    // Answer even on failure so the caller's one-in-flight slot releases;
    // an empty result reads as "no hands this frame".
    console.warn('hand worker detect failed', err);
    scope.postMessage({
      type: 'result',
      timestampMs,
      crop: { left: null, right: null },
      full: null,
      detectMs: 0,
    });
  } finally {
    bitmap.close();
  }
};
