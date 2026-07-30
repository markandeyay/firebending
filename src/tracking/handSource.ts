/**
 * Live hand tracking source: wraps MediaPipe HandLandmarker (Tasks Vision).
 *
 * All MediaPipe symbols are imported type-only or dynamically inside the
 * factory so this module can be imported by headless tests (vitest in node)
 * without ever touching the WASM runtime. The coordinate/handedness
 * transformations are exported pure functions operating on plain arrays.
 *
 * HANDEDNESS CONVENTION (worked through carefully, do not "fix" casually):
 * The raw getUserMedia frame is unmirrored: it is a photo of the player, so
 * the player's actual left hand appears on the RIGHT side of the image as the
 * viewer sees it. MediaPipe's hand model classifies handedness assuming the
 * input image is mirrored (selfie view, flipped horizontally). Since we feed
 * the UNMIRRORED frame, the reported label is the anatomical opposite:
 *   - MediaPipe label "Left"  => player's actual RIGHT hand
 *   - MediaPipe label "Right" => player's actual LEFT hand
 * Therefore normalizeHands() swaps labels: "Right" fills the `left` slot and
 * "Left" fills the `right` slot. Invariant: when the player raises the hand
 * on their own left side, frame.left is populated.
 *
 * COORDINATES: MediaPipe gives normalized image coords (x right in the raw
 * image, y down, z negative toward the camera). Player space per types.ts is
 * the mirrored view, so x -> 1 - x, y and z unchanged.
 */

import type { HandLandmarker } from '@mediapipe/tasks-vision';
import type { HandFrame, Vec3 } from './types';
import { HAND_LANDMARK_COUNT } from './types';

/** Official Google CDN model asset (float16). */
export const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** WASM runtime location, pinned to the installed package version. */
export const VISION_WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';

/** Minimal structural type for a landmark coming off MediaPipe. */
export interface RawLandmark {
  x: number;
  y: number;
  z: number;
}

/** One detected hand as reported by MediaPipe, before normalization. */
export interface RawHand {
  landmarks: readonly RawLandmark[];
  /** MediaPipe handedness label for the unmirrored frame. */
  label: 'Left' | 'Right';
  /** Handedness/presence score 0..1. */
  score: number;
}

/**
 * Mirror raw image-space landmarks into player space: x -> 1 - x,
 * y down unchanged, z (negative toward camera) unchanged.
 * Pure; returns fresh plain Vec3 objects.
 */
export function mirrorLandmarks(landmarks: readonly RawLandmark[]): Vec3[] {
  const out: Vec3[] = [];
  for (const lm of landmarks) {
    out.push({ x: 1 - lm.x, y: lm.y, z: lm.z });
  }
  return out;
}

/**
 * Map MediaPipe's handedness label (unmirrored-frame convention, see module
 * doc) to the player-space slot it belongs in.
 */
export function playerSlotForLabel(label: 'Left' | 'Right'): 'left' | 'right' {
  return label === 'Right' ? 'left' : 'right';
}

/**
 * Convert raw MediaPipe hands into the {left, right} player-space slots:
 * mirrors landmarks and swaps handedness per the module convention.
 * If two hands claim the same slot (misclassification), the higher-score
 * hand keeps the slot and the other spills into the free slot if any.
 * Pure and unit-testable without MediaPipe.
 */
export function normalizeHands(hands: readonly RawHand[]): {
  left: HandFrame | null;
  right: HandFrame | null;
} {
  const slots: { left: HandFrame | null; right: HandFrame | null } = {
    left: null,
    right: null,
  };
  const sorted = [...hands]
    .filter((h) => h.landmarks.length >= HAND_LANDMARK_COUNT)
    .sort((a, b) => b.score - a.score);
  for (const hand of sorted) {
    const frame: HandFrame = {
      landmarks: mirrorLandmarks(hand.landmarks),
      confidence: hand.score,
    };
    const preferred = playerSlotForLabel(hand.label);
    const fallback = preferred === 'left' ? 'right' : 'left';
    if (slots[preferred] === null) {
      slots[preferred] = frame;
    } else if (slots[fallback] === null) {
      slots[fallback] = frame;
    }
    // Both slots taken: drop the extra (numHands is 2, rare).
  }
  return slots;
}

/**
 * Create a HandLandmarker: 2 hands, VIDEO mode, GPU delegate with CPU
 * fallback. MediaPipe is dynamically imported here so tests never load it.
 */
export async function createHandLandmarker(): Promise<HandLandmarker> {
  const vision = await import('@mediapipe/tasks-vision');
  const fileset = await vision.FilesetResolver.forVisionTasks(VISION_WASM_URL);
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
    runningMode: 'VIDEO' as const,
    numHands: 2,
  });
  try {
    return await vision.HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('HandLandmarker GPU delegate failed, falling back to CPU', err);
    return await vision.HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

/**
 * Run hand detection on a video frame and return player-space hands.
 * timestampMs must be monotonically increasing (VIDEO mode requirement).
 */
export function detectHands(
  landmarker: HandLandmarker,
  video: HTMLVideoElement,
  timestampMs: number,
): { left: HandFrame | null; right: HandFrame | null } {
  const result = landmarker.detectForVideo(video, timestampMs);
  const raw: RawHand[] = [];
  for (let i = 0; i < result.landmarks.length; i++) {
    const landmarks = result.landmarks[i];
    const category = result.handedness[i]?.[0];
    if (!landmarks || !category) continue;
    const label = category.categoryName === 'Right' ? 'Right' : 'Left';
    raw.push({ landmarks, label, score: category.score });
  }
  return normalizeHands(raw);
}
