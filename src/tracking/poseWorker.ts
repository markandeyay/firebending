/**
 * Dedicated pose-detection Worker (Round 3 Phase 2). Owns the MediaPipe
 * PoseLandmarker so detectForVideo's synchronous cost never lands on the
 * main thread's frame budget.
 *
 * Protocol (all messages are plain structured-clone data):
 *   main -> worker  { type: 'init', variant: 'lite' | 'full' }
 *   worker -> main  { type: 'ready' } | { type: 'init-error', message }
 *   main -> worker  { type: 'frame', bitmap: ImageBitmap, timestampMs }
 *                   (bitmap is TRANSFERRED, never copied)
 *   worker -> main  { type: 'result', landmarks, worldLandmarks,
 *                     timestampMs, detectMs }
 *                   landmarks are the RAW MediaPipe arrays (plain
 *                   {x,y,z,visibility} objects); the MAIN thread runs the
 *                   pure extraction (extractPoseFrame + headPoseFromPose)
 *                   so all coordinate math stays unit-testable in one place.
 *
 * BACKPRESSURE is the caller's job: LiveLandmarkSource keeps at most ONE
 * frame in flight and skips capture while waiting, so the achieved pose rate
 * self-regulates to what this worker can sustain. The worker itself just
 * answers every frame it is handed, in order (timestamps must be strictly
 * increasing for VIDEO mode; the caller guarantees it).
 *
 * MediaPipe is imported dynamically inside init (via createPoseLandmarker)
 * so the worker script itself stays tiny and headless tests never load WASM.
 */

import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { createPoseLandmarker } from './poseSource';
import type { PoseModelVariant, RawPoseLandmark } from './poseSource';

export interface PoseWorkerInitMsg {
  type: 'init';
  variant: PoseModelVariant;
}

export interface PoseWorkerFrameMsg {
  type: 'frame';
  bitmap: ImageBitmap;
  timestampMs: number;
}

export type PoseWorkerRequest = PoseWorkerInitMsg | PoseWorkerFrameMsg;

export interface PoseWorkerReadyMsg {
  type: 'ready';
}

export interface PoseWorkerInitErrorMsg {
  type: 'init-error';
  message: string;
}

export interface PoseWorkerResultMsg {
  type: 'result';
  /** Raw normalized landmarks (33 points) or null when no body detected. */
  landmarks: RawPoseLandmark[] | null;
  /** Raw world landmarks (meters, hip-centered) or null. */
  worldLandmarks: RawPoseLandmark[] | null;
  timestampMs: number;
  /** Wall-clock detect cost inside the worker, ms (stats only). */
  detectMs: number;
}

export type PoseWorkerResponse =
  | PoseWorkerReadyMsg
  | PoseWorkerInitErrorMsg
  | PoseWorkerResultMsg;

/** Strip MediaPipe landmark objects to plain clonable data. */
function plainLandmarks(
  lms: ReadonlyArray<{ x: number; y: number; z: number; visibility?: number }> | undefined,
): RawPoseLandmark[] | null {
  if (!lms || lms.length === 0) return null;
  return lms.map((p) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    ...(typeof p.visibility === 'number' ? { visibility: p.visibility } : {}),
  }));
}

let landmarker: PoseLandmarker | null = null;

const scope = self as unknown as {
  postMessage(msg: PoseWorkerResponse): void;
  onmessage: ((e: MessageEvent<PoseWorkerRequest>) => void) | null;
};

scope.onmessage = (e: MessageEvent<PoseWorkerRequest>): void => {
  const msg = e.data;
  if (msg.type === 'init') {
    void createPoseLandmarker(msg.variant).then(
      (lm) => {
        landmarker = lm;
        scope.postMessage({ type: 'ready' });
      },
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
  const { bitmap, timestampMs } = msg;
  try {
    if (!landmarker) {
      scope.postMessage({
        type: 'result',
        landmarks: null,
        worldLandmarks: null,
        timestampMs,
        detectMs: 0,
      });
      return;
    }
    const start = performance.now();
    const result = landmarker.detectForVideo(bitmap, timestampMs);
    const detectMs = performance.now() - start;
    scope.postMessage({
      type: 'result',
      landmarks: plainLandmarks(result.landmarks[0]),
      worldLandmarks: plainLandmarks(result.worldLandmarks[0]),
      timestampMs,
      detectMs,
    });
  } finally {
    bitmap.close();
  }
};
