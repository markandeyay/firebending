/**
 * LiveLandmarkSource: the real-camera implementation of LandmarkSource.
 *
 * WORKER DECISION (Section 5, Phase 1): trackers run on the MAIN THREAD.
 * Rationale: transferring VideoFrames to a worker plus spinning up a
 * WASM/GPU delegate context per worker adds complexity and copy cost;
 * the MediaPipe GPU delegate already runs its inference off the JS thread.
 * Revisit only if profiling shows main-thread stalls attributable to the
 * detectForVideo call sites.
 *
 * Scheduling: hand detection every video frame, face detection every 4th
 * frame (~15 Hz). Degrade rule: if the rolling average (60 frames) of total
 * ML time per frame exceeds the 7 ms budget, face drops to every 8th frame.
 * Hands are never degraded.
 */

import type { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';
import type {
  FaceFrame,
  FrameListener,
  LandmarkFrame,
  LandmarkSource,
} from './types';
import { createHandLandmarker, detectHands } from './handSource';
import { createFaceLandmarker, detectFace } from './faceSource';

/** Combined ML budget per frame in ms (Section 14). */
const ML_BUDGET_MS = 7;
const ROLLING_WINDOW = 60;
const FACE_INTERVAL_NORMAL = 4;
const FACE_INTERVAL_DEGRADED = 8;

/** Fixed-size rolling average, O(1) push. */
class RollingAverage {
  private values: number[] = [];
  private sum = 0;
  private cursor = 0;

  constructor(private readonly size: number) {}

  push(v: number): void {
    if (this.values.length < this.size) {
      this.values.push(v);
      this.sum += v;
    } else {
      this.sum += v - (this.values[this.cursor] ?? 0);
      this.values[this.cursor] = v;
      this.cursor = (this.cursor + 1) % this.size;
    }
  }

  get average(): number {
    return this.values.length === 0 ? 0 : this.sum / this.values.length;
  }

  get full(): boolean {
    return this.values.length >= this.size;
  }
}

export interface LiveSourceStats {
  /** Rolling average hand inference time, ms. */
  handMs: number;
  /** Rolling average face inference time (frames where it ran), ms. */
  faceMs: number;
  /** Rolling average frames per second of the emit loop. */
  fps: number;
}

export class LiveLandmarkSource implements LandmarkSource {
  private listeners = new Set<FrameListener>();
  private stream: MediaStream | null = null;

  /** Camera stream for UI preview (calibration's dimmed feed). Null before start(). */
  get mediaStream(): MediaStream | null {
    return this.stream;
  }
  private video: HTMLVideoElement | null = null;
  private handLandmarker: HandLandmarker | null = null;
  private faceLandmarker: FaceLandmarker | null = null;
  private running = false;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private startTime = 0;
  private lastTimestamp = -1;
  private lastFrameTime = 0;
  private frameIndex = 0;
  private faceInterval = FACE_INTERVAL_NORMAL;
  private lastFace: FaceFrame | null = null;
  private handMsAvg = new RollingAverage(ROLLING_WINDOW);
  private faceMsAvg = new RollingAverage(ROLLING_WINDOW);
  private totalMsAvg = new RollingAverage(ROLLING_WINDOW);
  private fpsAvg = new RollingAverage(ROLLING_WINDOW);

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get stats(): LiveSourceStats {
    return {
      handMs: this.handMsAvg.average,
      faceMs: this.faceMsAvg.average,
      fps: this.fpsAvg.average,
    };
  }

  /** True once the degrade rule has dropped face detection to every 8th frame. */
  get faceDegraded(): boolean {
    return this.faceInterval === FACE_INTERVAL_DEGRADED;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
      },
      audio: false,
    });

    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.style.position = 'absolute';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.srcObject = this.stream;
    document.body.appendChild(video);
    this.video = video;
    await video.play();

    const [hand, face] = await Promise.all([
      createHandLandmarker(),
      createFaceLandmarker(),
    ]);
    this.handLandmarker = hand;
    this.faceLandmarker = face;

    this.running = true;
    this.startTime = performance.now();
    this.lastFrameTime = this.startTime;
    this.frameIndex = 0;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.video) {
      if (this.rvfcHandle !== null && 'cancelVideoFrameCallback' in this.video) {
        this.video.cancelVideoFrameCallback(this.rvfcHandle);
      }
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
    this.rvfcHandle = null;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.handLandmarker?.close();
    this.handLandmarker = null;
    this.faceLandmarker?.close();
    this.faceLandmarker = null;
    this.lastFace = null;
  }

  private scheduleNext(): void {
    const video = this.video;
    if (!this.running || !video) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      this.rvfcHandle = video.requestVideoFrameCallback(() => this.processFrame());
    } else {
      this.rafHandle = requestAnimationFrame(() => this.processFrame());
    }
  }

  private processFrame(): void {
    const video = this.video;
    if (!this.running || !video || !this.handLandmarker) return;

    const now = performance.now();
    // MediaPipe VIDEO mode requires strictly increasing timestamps.
    const timestamp = Math.max(now, this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;

    if (this.frameIndex > 0) {
      const dt = now - this.lastFrameTime;
      if (dt > 0) this.fpsAvg.push(1000 / dt);
    }
    this.lastFrameTime = now;

    let totalMs = 0;

    const handStart = performance.now();
    const hands = detectHands(this.handLandmarker, video, timestamp);
    const handMs = performance.now() - handStart;
    this.handMsAvg.push(handMs);
    totalMs += handMs;

    if (this.faceLandmarker && this.frameIndex % this.faceInterval === 0) {
      const faceStart = performance.now();
      this.lastFace = detectFace(this.faceLandmarker, video, timestamp);
      const faceMs = performance.now() - faceStart;
      this.faceMsAvg.push(faceMs);
      totalMs += faceMs;
    }

    this.totalMsAvg.push(totalMs);
    if (
      this.faceInterval === FACE_INTERVAL_NORMAL &&
      this.totalMsAvg.full &&
      this.totalMsAvg.average > ML_BUDGET_MS
    ) {
      // Over budget consistently: halve the face rate, never touch hands.
      this.faceInterval = FACE_INTERVAL_DEGRADED;
    }

    const frame: LandmarkFrame = {
      t: now - this.startTime,
      left: hands.left,
      right: hands.right,
      face: this.lastFace,
    };
    this.frameIndex++;
    for (const l of this.listeners) l(frame);

    this.scheduleNext();
  }
}
