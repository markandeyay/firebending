/**
 * LiveLandmarkSource: the real-camera implementation of LandmarkSource.
 *
 * WORKER DECISION (revised, quality round Phase 1): BOTH models now run in
 * dedicated Workers. Pose kept its worker (poseWorker.ts); hands moved into
 * handWorker.ts, which owns all three HandLandmarker instances (2-hand
 * full-frame + two 1-hand ROI crop instances) and the two OffscreenCanvas
 * crop targets. The previous revision ran hand inference SYNCHRONOUSLY
 * inside requestVideoFrameCallback (up to two crop detects plus a full-frame
 * detect per frame), which collapsed the video frame callback rate to
 * whatever inference allowed (~14 fps observed in studio recordings). Now
 * the main thread only: grabs frames with createImageBitmap(video)
 * (transferable, no copy), computes the pure crop-box math, and runs the
 * pure result extraction, so main-thread ML cost is bookkeeping only.
 *
 * EMISSION (decoupled): exactly ONE LandmarkFrame is emitted per fresh
 * hand-worker result. Hands are the fast channel: the emission rate equals
 * the achieved hand Hz (target: the camera's 30 Hz), independent of the
 * render loop. Pose interpolates onto each emitted frame as before
 * (lerpPoseFrames, `interpolated` flag, elbow tracker skips interpolated).
 *
 * BACKPRESSURE (hands): LATEST-FRAME-WINS via LatestWinsChannel: at most one
 * frame in flight to the worker; a newer capture REPLACES a parked pending
 * one (its bitmap is closed), so latency stays bounded at one worker
 * round-trip plus one capture and never queues. Pose keeps its classic
 * one-in-flight skip-while-busy rule.
 *
 * FALLBACK: if Worker/OffscreenCanvas/createImageBitmap are unavailable or a
 * worker fails (init or runtime), that model falls back to the exact
 * pre-worker main-thread path (sync hand detection per frame, pose every
 * 2nd frame), same graceful-failure style for both.
 *
 * CAPTURE TIMESTAMP: every emitted frame carries captureTs, the
 * performance.now()-domain capture time of the source video frame
 * (rvfc metadata.captureTime, else presentationTime, else the callback
 * now). Fixtures/recordings lack it; absence is fully supported downstream.
 *
 * PREDICTION: predictedHands(nowMs) extrapolates the last two REAL emitted
 * hand samples by constant wrist velocity (rigid whole-hand offset, capped
 * at +100 ms; see predict.ts) so the glove render path can sample hands at
 * render rate. Gesture code keeps consuming real emitted frames only.
 *
 * HEAD POSE: derived from pose samples (headPoseFromPose), unchanged.
 *
 * DEGRADE: the internal ML-budget rule (7 ms) protects the MAIN THREAD and
 * therefore keeps evaluating main-thread cost only (on the worker paths
 * that is crop math + extraction, ~0); worker-side detect costs are
 * reported separately in stats. setPoseIntervalMultiplier still works on
 * both pose paths.
 *
 * ROI CROP HAND PATH: unchanged in substance: per side, when the held pose
 * is FRESH and that wrist is visible, the hand detector runs on a square
 * crop around the pose wrist; the box math and the crop->player mapping are
 * the same pure roiCrop.ts functions, now split main/worker: the MAIN
 * thread computes and keeps the smoothed boxes and maps results back to
 * player space; the worker only draws the region and detects. Sides
 * without a box are covered by one full-frame 2-hand detect (only when at
 * least one side lacks a box). The frame slot comes from the POSE side.
 *
 * CROP ARCHITECTURE CHOICE (unchanged): two dedicated 1-hand HandLandmarker
 * instances, one per side, each keeping its own temporal tracking state and
 * trivially monotonic per-instance timestamps; cost is one extra hand-model
 * instance in memory.
 */

import type { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type {
  FaceFrame,
  FrameListener,
  HandFrame,
  LandmarkFrame,
  LandmarkSource,
  PoseFrame,
} from './types';
import type { PoseArm } from './types';
import {
  createHandLandmarker,
  detectHands,
  detectTopHand,
  normalizeHands,
} from './handSource';
import {
  createPoseLandmarker,
  detectPoseAndHead,
  extractPoseFrame,
  headPoseFromPose,
  lerpPoseFrames,
} from './poseSource';
import type { PoseWorkerRequest, PoseWorkerResponse } from './poseWorker';
import type { HandWorkerRequest, HandWorkerResponse } from './handWorker';
import {
  CROP_SIZE_PX,
  CropSmoother,
  POSE_FRESH_MS,
  WRIST_VISIBILITY_MIN,
  cropBoxForWrist,
  cropHandToPlayer,
  frameSlotForPoseSide,
  playerToRaw,
  selectHandPath,
  type CropBox,
} from './roiCrop';
import { LatestWinsChannel } from './latestWins';
import { HandPredictor, type PredictedHands } from './predict';
import { LatencyMeter, RateMeter, type Percentiles } from './meters';

/** Combined ML budget per frame in ms (Section 14). MAIN-THREAD only: the
 * budget exists to protect the frame loop, and worker-side detect cost never
 * touches it (reported separately in rateStats). */
const ML_BUDGET_MS = 7;
const ROLLING_WINDOW = 60;
const POSE_INTERVAL_NORMAL = 2;
const POSE_INTERVAL_DEGRADED = 4;
/** Target worker-path pose cadence: one capture every 40 ms (~25 Hz). The
 * one-in-flight backpressure rule lowers the achieved rate automatically on
 * slower machines. */
export const POSE_WORKER_INTERVAL_MS = 40;

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

  reset(): void {
    this.values.length = 0;
    this.sum = 0;
    this.cursor = 0;
  }
}

export interface LiveSourceStats {
  /** Rolling average MAIN-THREAD hand-path time per frame, ms. On the
   * worker path this is crop-box math + capture bookkeeping (~0); on the
   * fallback it is the full synchronous crop + detect cost as before. */
  handMs: number;
  /** Rolling average pose inference time per detection, ms (worker path:
   * measured inside the worker, off the main thread). */
  poseMs: number;
  /** Rolling average ACHIEVED pose sample rate, Hz (worker path; the
   * one-in-flight backpressure makes this self-regulating). 0 before the
   * first two samples and on the main-thread fallback. */
  poseHz: number;
  /** True while pose runs in the dedicated worker; false on the fallback. */
  poseWorkerActive: boolean;
  /** True while hands run in the dedicated worker; false on the fallback. */
  handWorkerActive: boolean;
  /** Rolling average frames per second of the video frame callback loop. */
  fps: number;
  /** Rolling average main-thread crop-path time (frames where crops ran), ms. */
  cropMs: number;
  /** Whether each side used the ROI crop path on the most recent frame. */
  cropActive: { left: boolean; right: boolean };
}

/** Measured rates and latencies (exact p50/p95 over ~240-sample windows). */
export interface LiveRateStats {
  /** Video frame callback cadence (the camera's delivered rate). */
  cameraHz: Percentiles;
  /** Fresh hand results = emitted LandmarkFrames per second. */
  handHz: Percentiles;
  /** Achieved pose sample rate. */
  poseHz: Percentiles;
  /** Emit wallclock minus captureTs, per emitted frame, ms. */
  photonToEmitMs: Percentiles;
  /** Rolling average MAIN-THREAD ML/bookkeeping ms per video frame (the
   * degrade rule's input; ~0 when both workers run). */
  mainMlMs: number;
  /** Rolling average in-worker hand draw+detect ms (0 on the fallback,
   * where the cost is main-thread and lives in mainMlMs). */
  workerHandDetectMs: number;
  /** Rolling average in-worker pose detect ms (0 on the fallback). */
  workerPoseDetectMs: number;
  handWorkerActive: boolean;
  poseWorkerActive: boolean;
}

/** Per-side state for the ROI crop path (main-thread fallback canvases; the
 * worker path only uses the smoother and the active flag). */
interface CropSide {
  landmarker: HandLandmarker | null;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  smoother: CropSmoother;
  active: boolean;
}

/** One captured video frame on its way to (or through) the hand worker.
 * The main thread KEEPS the crop boxes: they are needed to map the crop
 * results back to full-frame space when the worker answers. */
interface HandCapture {
  bitmap: ImageBitmap;
  timestampMs: number;
  /** Frame-clock time (ms since source start) of the capture. */
  frameT: number;
  /** performance.now()-domain capture time of the video frame. */
  captureTs: number;
  crops: { left: CropBox | null; right: CropBox | null };
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
  private poseLandmarker: PoseLandmarker | null = null;
  private running = false;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private startTime = 0;
  private lastTimestamp = -1;
  private lastFrameTime = 0;
  private frameIndex = 0;
  private poseInterval = POSE_INTERVAL_NORMAL;
  /** Degrade-ladder multiplier on the pose interval. 1 = normal. */
  private poseIntervalMult = 1;
  /** Sample-and-held head pose derived from the latest pose sample. */
  private lastFace: FaceFrame | null = null;
  /** Latest RAW pose sample (never interpolated); crop path + fallback hold. */
  private lastPose: PoseFrame | null = null;
  private handMsAvg = new RollingAverage(ROLLING_WINDOW);
  private poseMsAvg = new RollingAverage(ROLLING_WINDOW);
  private poseHzAvg = new RollingAverage(ROLLING_WINDOW);
  private cropMsAvg = new RollingAverage(ROLLING_WINDOW);
  private totalMsAvg = new RollingAverage(ROLLING_WINDOW);
  private fpsAvg = new RollingAverage(ROLLING_WINDOW);
  private workerHandMsAvg = new RollingAverage(ROLLING_WINDOW);

  // --- Rate/latency meters (quality round Phase 1) -------------------------
  private readonly cameraRate = new RateMeter();
  private readonly handRate = new RateMeter();
  private readonly poseRate = new RateMeter();
  private readonly photonToEmit = new LatencyMeter();

  // --- Pose worker state ---------------------------------------------------
  private poseWorker: Worker | null = null;
  private poseWorkerReady = false;
  /** Backpressure: at most ONE frame in flight to the pose worker. */
  private poseInFlight = false;
  private lastPoseSendAt = -Infinity;
  /** Frame-clock time of the capture currently in flight. */
  private pendingPoseFrameT = 0;
  /** Frame-clock time of the previous worker result (for achieved Hz). */
  private lastPoseResultFrameT: number | null = null;
  /** Last two RAW pose samples for per-frame interpolation. */
  private poseSamplePrev: PoseFrame | null = null;
  private poseSampleLast: PoseFrame | null = null;
  /** True exactly until the newest raw sample has been emitted once. */
  private poseSampleFresh = false;

  // --- Hand worker state ---------------------------------------------------
  private handWorker: Worker | null = null;
  private handWorkerReady = false;
  /** Latest-frame-wins channel; send transfers the bitmap to the worker. */
  private handChannel: LatestWinsChannel<HandCapture> | null = null;
  /** The capture whose result we are waiting on (its crop boxes map the
   * answer back to player space). */
  private inFlightHandCapture: HandCapture | null = null;
  /** Monotonic guard on offered captures (createImageBitmap resolution
   * order is FIFO in practice; this makes out-of-order impossible). */
  private lastOfferedTimestamp = -1;
  private readonly predictor = new HandPredictor();

  private readonly cropSides: { left: CropSide; right: CropSide } = {
    left: LiveLandmarkSource.emptyCropSide(),
    right: LiveLandmarkSource.emptyCropSide(),
  };

  private static emptyCropSide(): CropSide {
    return {
      landmarker: null,
      canvas: null,
      ctx: null,
      smoother: new CropSmoother(),
      active: false,
    };
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get stats(): LiveSourceStats {
    return {
      handMs: this.handMsAvg.average,
      poseMs: this.poseMsAvg.average,
      poseHz: this.poseHzAvg.average,
      poseWorkerActive: this.poseWorker !== null && this.poseWorkerReady,
      handWorkerActive: this.handWorker !== null && this.handWorkerReady,
      fps: this.fpsAvg.average,
      cropMs: this.cropMsAvg.average,
      cropActive: {
        left: this.cropSides.left.active,
        right: this.cropSides.right.active,
      },
    };
  }

  /** Measured rates and latencies (see LiveRateStats). */
  get rateStats(): LiveRateStats {
    const poseWorkerActive = this.poseWorker !== null && this.poseWorkerReady;
    return {
      cameraHz: this.cameraRate.hz,
      handHz: this.handRate.hz,
      poseHz: this.poseRate.hz,
      photonToEmitMs: this.photonToEmit.ms,
      mainMlMs: this.totalMsAvg.average,
      workerHandDetectMs: this.workerHandMsAvg.average,
      workerPoseDetectMs: poseWorkerActive ? this.poseMsAvg.average : 0,
      handWorkerActive: this.handWorker !== null && this.handWorkerReady,
      poseWorkerActive,
    };
  }

  /**
   * Per-side hands extrapolated to `perfNowMs` (performance.now() domain)
   * from the last two REAL emitted samples: constant wrist velocity applied
   * as a rigid offset to the whole hand, horizon-capped at +100 ms (see
   * predict.ts). RENDER-ONLY: the glove path samples this at render rate;
   * gesture code must keep consuming emitted frames. The returned HandFrames
   * are reused across calls; consume immediately.
   */
  predictedHands(perfNowMs: number): PredictedHands {
    return this.predictor.predict(perfNowMs - this.startTime);
  }

  /** True once the degrade rule has halved the pose detection rate. */
  get poseDegraded(): boolean {
    return this.poseInterval === POSE_INTERVAL_DEGRADED;
  }

  /**
   * Degrade-ladder hook (T070): multiply the pose detection interval.
   * 1 restores the normal schedule; 2 halves the pose rate (worker cadence
   * and main-thread fallback both respect it). Composes with the internal
   * ML-budget degrade; hands are never touched. Replay sources have no such
   * method and the ladder wiring treats that as a no-op.
   */
  setPoseIntervalMultiplier(multiplier: number): void {
    this.poseIntervalMult = Math.max(1, Math.round(multiplier));
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
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

    // Workers when the platform supports them; classic main-thread paths
    // otherwise. Both workers initialize in the background: frames flow
    // immediately (hands/pose absent until each worker reports ready), and
    // an init failure swaps in the matching main-thread fallback.
    const poseWorkerCapable =
      typeof Worker === 'function' && typeof createImageBitmap === 'function';
    const handWorkerCapable =
      poseWorkerCapable && typeof OffscreenCanvas === 'function';
    if (poseWorkerCapable) this.startPoseWorker();
    if (handWorkerCapable) this.startHandWorker();

    if (!handWorkerCapable) {
      const [hand, cropLeft, cropRight] = await Promise.all([
        createHandLandmarker(),
        createHandLandmarker(1),
        createHandLandmarker(1),
      ]);
      this.handLandmarker = hand;
      this.initCropSide('left', cropLeft);
      this.initCropSide('right', cropRight);
    }
    if (!poseWorkerCapable) {
      this.poseLandmarker = await createPoseLandmarker();
    }

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
    this.poseLandmarker?.close();
    this.poseLandmarker = null;
    if (this.poseWorker) {
      this.poseWorker.terminate();
      this.poseWorker = null;
    }
    this.poseWorkerReady = false;
    this.poseInFlight = false;
    this.lastPoseSendAt = -Infinity;
    this.lastPoseResultFrameT = null;
    this.poseSamplePrev = null;
    this.poseSampleLast = null;
    this.poseSampleFresh = false;
    if (this.handWorker) {
      // An in-flight bitmap was transferred and dies with the worker.
      this.handWorker.terminate();
      this.handWorker = null;
    }
    this.handWorkerReady = false;
    this.handChannel?.reset(); // closes any parked pending bitmap via onDrop
    this.handChannel = null;
    this.inFlightHandCapture = null;
    this.lastOfferedTimestamp = -1;
    this.predictor.reset();
    for (const side of ['left', 'right'] as const) {
      const crop = this.cropSides[side];
      crop.landmarker?.close();
      crop.landmarker = null;
      crop.canvas = null;
      crop.ctx = null;
      crop.smoother.reset();
      crop.active = false;
    }
    this.lastFace = null;
    this.lastPose = null;
  }

  /** Wire one side's crop landmarker and its reused upscale canvas
   * (main-thread fallback path only). */
  private initCropSide(side: 'left' | 'right', landmarker: HandLandmarker): void {
    const crop = this.cropSides[side];
    crop.landmarker = landmarker;
    const canvas = document.createElement('canvas');
    canvas.width = CROP_SIZE_PX;
    canvas.height = CROP_SIZE_PX;
    crop.canvas = canvas;
    crop.ctx = canvas.getContext('2d');
    crop.smoother.reset();
    crop.active = false;
  }

  // -------------------------------------------------------------------------
  // Pose worker plumbing
  // -------------------------------------------------------------------------

  /**
   * Spin up the dedicated pose worker (Vite worker syntax). Failures at any
   * stage (constructor throw, init-error message, runtime error event) tear
   * the worker down and lazily create the main-thread fallback landmarker,
   * so pose keeps working exactly as before workers existed.
   */
  private startPoseWorker(): void {
    try {
      const worker = new Worker(new URL('./poseWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.poseWorker = worker;
      worker.onmessage = (e: MessageEvent<PoseWorkerResponse>) =>
        this.onPoseWorkerMessage(e.data);
      worker.onerror = (err) => {
        console.warn('pose worker error, falling back to main-thread pose', err);
        this.failPoseWorker();
      };
      const init: PoseWorkerRequest = { type: 'init', variant: 'lite' };
      worker.postMessage(init);
    } catch (err) {
      console.warn('pose worker unavailable, falling back to main-thread pose', err);
      this.failPoseWorker();
    }
  }

  /** Tear down the worker and adopt the main-thread pose path. */
  private failPoseWorker(): void {
    if (this.poseWorker) {
      this.poseWorker.terminate();
      this.poseWorker = null;
    }
    this.poseWorkerReady = false;
    this.poseInFlight = false;
    if (this.poseLandmarker) return;
    void createPoseLandmarker().then(
      (lm) => {
        // video is null only after stop(); during start() it is already set,
        // so a fast-arriving fallback landmarker is never dropped.
        if (this.video === null) {
          lm.close();
          return;
        }
        this.poseLandmarker = lm;
      },
      (err: unknown) => console.warn('main-thread pose fallback failed', err),
    );
  }

  private onPoseWorkerMessage(msg: PoseWorkerResponse): void {
    if (msg.type === 'ready') {
      this.poseWorkerReady = true;
      return;
    }
    if (msg.type === 'init-error') {
      console.warn('pose worker init failed, falling back', msg.message);
      this.failPoseWorker();
      return;
    }
    // 'result': release the in-flight slot, then run the pure extraction on
    // the main side (keeps the math unit-testable) and record achieved Hz.
    this.poseInFlight = false;
    if (!this.running) return;
    const frameT = this.pendingPoseFrameT;
    this.poseMsAvg.push(msg.detectMs);
    this.poseRate.push(performance.now());
    if (this.lastPoseResultFrameT !== null) {
      const dt = frameT - this.lastPoseResultFrameT;
      if (dt > 0) this.poseHzAvg.push(1000 / dt);
    }
    this.lastPoseResultFrameT = frameT;

    if (!msg.landmarks) {
      // No body in frame: drop the samples so interpolation stops and the
      // held head pose clears, exactly like a null detection did before.
      this.lastPose = null;
      this.lastFace = null;
      this.poseSamplePrev = null;
      this.poseSampleLast = null;
      this.poseSampleFresh = false;
      return;
    }
    const pose = extractPoseFrame(msg.landmarks, msg.worldLandmarks, frameT);
    this.lastFace = headPoseFromPose(msg.landmarks);
    if (!pose) {
      this.lastPose = null;
      this.poseSamplePrev = null;
      this.poseSampleLast = null;
      this.poseSampleFresh = false;
      return;
    }
    this.lastPose = pose;
    this.poseSamplePrev = this.poseSampleLast;
    this.poseSampleLast = pose;
    this.poseSampleFresh = true;
  }

  /**
   * Pose worker-path capture: at most one frame in flight, target cadence
   * POSE_WORKER_INTERVAL_MS scaled by the degrade multipliers. The bitmap
   * is transferable, so the post is copy-free.
   */
  private maybeSendPoseFrame(video: HTMLVideoElement, now: number, timestamp: number): void {
    if (!this.poseWorkerReady || this.poseInFlight) return;
    if (video.videoWidth <= 0) return;
    const interval =
      POSE_WORKER_INTERVAL_MS *
      this.poseIntervalMult *
      (this.poseInterval / POSE_INTERVAL_NORMAL);
    if (now - this.lastPoseSendAt < interval) return;
    this.poseInFlight = true;
    this.lastPoseSendAt = now;
    this.pendingPoseFrameT = now - this.startTime;
    void createImageBitmap(video).then(
      (bitmap) => {
        const worker = this.poseWorker;
        if (!this.running || !worker) {
          bitmap.close();
          this.poseInFlight = false;
          return;
        }
        const msg: PoseWorkerRequest = {
          type: 'frame',
          bitmap,
          timestampMs: timestamp,
        };
        worker.postMessage(msg, [bitmap]);
      },
      () => {
        this.poseInFlight = false;
      },
    );
  }

  /**
   * The PoseFrame to emit on this frame:
   * - the frame right after a worker result emits the RAW sample (the elbow
   *   tracker differences these);
   * - between results, the last two samples interpolate to the frame time
   *   (lerpPoseFrames caps extrapolation at 80 ms) with interpolated: true;
   * - a single sample (or the main-thread fallback) sample-and-holds.
   */
  private poseForEmit(frameT: number): PoseFrame | null {
    if (this.poseWorker === null) return this.lastPose; // fallback: held sample
    const last = this.poseSampleLast;
    if (last === null) return null;
    if (this.poseSampleFresh) {
      this.poseSampleFresh = false;
      return last;
    }
    const prev = this.poseSamplePrev;
    if (prev === null) return last;
    return lerpPoseFrames(prev, last, frameT);
  }

  // -------------------------------------------------------------------------
  // Hand worker plumbing
  // -------------------------------------------------------------------------

  /** Spin up the dedicated hand worker; failures fall back to the classic
   * synchronous main-thread path (same style as the pose worker). */
  private startHandWorker(): void {
    try {
      const worker = new Worker(new URL('./handWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.handWorker = worker;
      this.handChannel = new LatestWinsChannel<HandCapture>(
        (capture) => {
          this.inFlightHandCapture = capture;
          const msg: HandWorkerRequest = {
            type: 'frame',
            bitmap: capture.bitmap,
            timestampMs: capture.timestampMs,
            crops: capture.crops,
          };
          worker.postMessage(msg, [capture.bitmap]);
        },
        (dropped) => dropped.bitmap.close(),
      );
      worker.onmessage = (e: MessageEvent<HandWorkerResponse>) =>
        this.onHandWorkerMessage(e.data);
      worker.onerror = (err) => {
        console.warn('hand worker error, falling back to main-thread hands', err);
        this.failHandWorker();
      };
      const init: HandWorkerRequest = { type: 'init', cropSizePx: CROP_SIZE_PX };
      worker.postMessage(init);
    } catch (err) {
      console.warn('hand worker unavailable, falling back to main-thread hands', err);
      this.failHandWorker();
    }
  }

  /** Tear down the hand worker and adopt the main-thread hand path. */
  private failHandWorker(): void {
    if (this.handWorker) {
      this.handWorker.terminate();
      this.handWorker = null;
    }
    this.handWorkerReady = false;
    this.handChannel?.reset();
    this.handChannel = null;
    this.inFlightHandCapture = null;
    if (this.handLandmarker) return;
    void Promise.all([
      createHandLandmarker(),
      createHandLandmarker(1),
      createHandLandmarker(1),
    ]).then(
      ([hand, cropLeft, cropRight]) => {
        if (this.video === null) {
          hand.close();
          cropLeft.close();
          cropRight.close();
          return;
        }
        this.handLandmarker = hand;
        this.initCropSide('left', cropLeft);
        this.initCropSide('right', cropRight);
      },
      (err: unknown) => console.warn('main-thread hand fallback failed', err),
    );
  }

  /**
   * A hand-worker answer: run the PURE extraction on the main thread
   * (cropHandToPlayer with the boxes this side kept, normalizeHands for the
   * full-frame remainder), then EMIT exactly one LandmarkFrame. This is the
   * emission point of the worker path: emission rate = achieved hand Hz.
   */
  private onHandWorkerMessage(msg: HandWorkerResponse): void {
    if (msg.type === 'ready') {
      this.handWorkerReady = true;
      return;
    }
    if (msg.type === 'init-error') {
      console.warn('hand worker init failed, falling back', msg.message);
      this.failHandWorker();
      return;
    }
    // 'result'
    const capture = this.inFlightHandCapture;
    this.inFlightHandCapture = null;
    if (!this.running || capture === null) return; // stop() raced the answer
    this.workerHandMsAvg.push(msg.detectMs);

    const hands: { left: HandFrame | null; right: HandFrame | null } = {
      left: null,
      right: null,
    };
    for (const side of ['left', 'right'] as const) {
      const box = capture.crops[side];
      if (box === null) continue;
      const raw = msg.crop[side];
      if (!raw) continue;
      hands[frameSlotForPoseSide(side)] = cropHandToPlayer(
        raw.landmarks,
        raw.world,
        raw.score,
        box,
      );
    }
    if (msg.full) {
      const full = normalizeHands(msg.full);
      if (capture.crops.left === null) hands.left = full.left;
      if (capture.crops.right === null) hands.right = full.right;
    }

    const frame: LandmarkFrame = {
      t: capture.frameT,
      left: hands.left,
      right: hands.right,
      face: this.lastFace,
      pose: this.poseForEmit(capture.frameT),
      captureTs: capture.captureTs,
    };
    this.predictor.feed(capture.frameT, hands.left, hands.right);
    const emitNow = performance.now();
    this.handRate.push(emitNow);
    this.photonToEmit.push(emitNow - capture.captureTs);
    this.frameIndex++;
    for (const l of this.listeners) l(frame);

    // Release the slot LAST: settle() may immediately send the parked
    // pending capture, which re-fills inFlightHandCapture via the channel's
    // send callback.
    this.handChannel?.settle();
  }

  /**
   * Worker-path capture: compute the pure crop boxes from the held pose
   * (smoothers live on the main thread so they see every capture), grab the
   * frame as a transferable bitmap, and offer it to the latest-wins channel.
   * Returns the main-thread cost of the box math (the only ML-adjacent work
   * left on this thread).
   */
  private captureForHandWorker(
    video: HTMLVideoElement,
    now: number,
    timestamp: number,
    captureTs: number,
  ): number {
    const mainStart = performance.now();
    const frameT = now - this.startTime;
    const pose = this.lastPose;
    const poseFresh = pose !== null && frameT - pose.t <= POSE_FRESH_MS;
    const crops: { left: CropBox | null; right: CropBox | null } = {
      left: null,
      right: null,
    };
    for (const side of ['left', 'right'] as const) {
      const crop = this.cropSides[side];
      const visibility = pose?.wristVisibility?.[side] ?? 1;
      const path = selectHandPath(poseFresh, visibility > WRIST_VISIBILITY_MIN);
      if (path === 'crop' && pose !== null && video.videoWidth > 0) {
        const arm: PoseArm = side === 'left' ? pose.left : pose.right;
        const rawWrist = playerToRaw(arm.wrist);
        const rawElbow = playerToRaw(arm.elbow);
        const target = cropBoxForWrist(
          rawWrist,
          rawElbow,
          video.videoWidth / video.videoHeight,
        );
        crops[side] = crop.smoother.update(target, rawWrist, now);
        crop.active = true;
      } else {
        crop.active = false;
        crop.smoother.reset();
      }
    }
    const mainMs = performance.now() - mainStart;

    void createImageBitmap(video).then(
      (bitmap) => {
        if (!this.running || !this.handWorkerReady || this.handChannel === null) {
          bitmap.close();
          return;
        }
        // Monotonic guard: never offer an older capture after a newer one.
        if (timestamp <= this.lastOfferedTimestamp) {
          bitmap.close();
          return;
        }
        this.lastOfferedTimestamp = timestamp;
        this.handChannel.offer({ bitmap, timestampMs: timestamp, frameT, captureTs, crops });
      },
      () => {
        /* a failed grab simply skips this frame */
      },
    );
    return mainMs;
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private scheduleNext(): void {
    const video = this.video;
    if (!this.running || !video) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      this.rvfcHandle = video.requestVideoFrameCallback((now, meta) =>
        this.processFrame(meta.captureTime ?? meta.presentationTime ?? now),
      );
    } else {
      this.rafHandle = requestAnimationFrame((now) => this.processFrame(now));
    }
  }

  private processFrame(captureTs: number): void {
    const video = this.video;
    if (!this.running || !video) return;

    const now = performance.now();
    // MediaPipe VIDEO mode requires strictly increasing timestamps.
    const timestamp = Math.max(now, this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;

    this.cameraRate.push(now);
    if (this.frameIndex > 0) {
      const dt = now - this.lastFrameTime;
      if (dt > 0) this.fpsAvg.push(1000 / dt);
    }
    this.lastFrameTime = now;

    let totalMs = 0;

    // Pose runs FIRST within the frame so the ROI crop path below always
    // uses the freshest wrist.
    if (this.poseWorker !== null) {
      this.maybeSendPoseFrame(video, now, timestamp);
    } else {
      const poseEvery = this.poseInterval * this.poseIntervalMult;
      if (this.poseLandmarker && this.frameIndex % poseEvery === 1) {
        const poseStart = performance.now();
        const { pose, face } = detectPoseAndHead(this.poseLandmarker, video, timestamp);
        this.lastPose = pose ? { ...pose, t: now - this.startTime } : null;
        this.lastFace = face;
        const poseMs = performance.now() - poseStart;
        this.poseMsAvg.push(poseMs);
        totalMs += poseMs;
      }
    }

    if (this.handWorker !== null) {
      // WORKER PATH: capture-and-post only; the frame EMITS when the worker
      // answers (onHandWorkerMessage), decoupling emission from this loop.
      // Until the worker reports ready no frames are emitted (hands are the
      // emission channel), matching the pre-worker behavior where start()
      // blocked until the landmarkers existed.
      if (this.handWorkerReady) {
        totalMs += this.captureForHandWorker(video, now, timestamp, captureTs);
      }
      this.totalMsAvg.push(totalMs);
      this.stepDegrade();
      this.frameIndex++;
      this.scheduleNext();
      return;
    }

    // FALLBACK PATH (no hand worker): the classic synchronous per-frame
    // detection and emission, exactly as before workers existed.
    const frameT = now - this.startTime;
    const pose = this.lastPose;
    const poseFresh = pose !== null && frameT - pose.t <= POSE_FRESH_MS;
    const hands: { left: HandFrame | null; right: HandFrame | null } = {
      left: null,
      right: null,
    };
    const handStart = performance.now();
    let cropMs = 0;
    let cropRan = false;
    let needFull = false;
    for (const side of ['left', 'right'] as const) {
      const crop = this.cropSides[side];
      const visibility = pose?.wristVisibility?.[side] ?? 1;
      const path = selectHandPath(poseFresh, visibility > WRIST_VISIBILITY_MIN);
      const ready =
        crop.landmarker !== null && crop.ctx !== null && video.videoWidth > 0;
      if (path === 'crop' && ready && pose !== null) {
        const cropStart = performance.now();
        const arm = side === 'left' ? pose.left : pose.right;
        hands[frameSlotForPoseSide(side)] = this.detectCropSide(side, arm, timestamp, now);
        cropMs += performance.now() - cropStart;
        cropRan = true;
        crop.active = true;
      } else {
        // Reset the smoother so the next crop activation snaps fresh
        // instead of easing from a stale box.
        crop.active = false;
        crop.smoother.reset();
        needFull = true;
      }
    }
    if (needFull && this.handLandmarker) {
      const full = detectHands(this.handLandmarker, video, timestamp);
      if (!this.cropSides.left.active) hands.left = full.left;
      if (!this.cropSides.right.active) hands.right = full.right;
    }
    const handMs = performance.now() - handStart;
    this.handMsAvg.push(handMs);
    if (cropRan) this.cropMsAvg.push(cropMs);
    totalMs += handMs;

    this.totalMsAvg.push(totalMs);
    this.stepDegrade();

    const frame: LandmarkFrame = {
      t: frameT,
      left: hands.left,
      right: hands.right,
      face: this.lastFace,
      pose: this.poseForEmit(frameT),
      captureTs,
    };
    this.predictor.feed(frameT, hands.left, hands.right);
    const emitNow = performance.now();
    this.handRate.push(emitNow);
    this.photonToEmit.push(emitNow - captureTs);
    this.frameIndex++;
    for (const l of this.listeners) l(frame);

    this.scheduleNext();
  }

  /** Internal ML-budget ladder: halve the pose rate when the rolling
   * MAIN-THREAD ML cost per frame exceeds the budget (hands never degrade).
   * The window resets after the step so the next verdict measures the new
   * configuration instead of the old one's backlog. */
  private stepDegrade(): void {
    if (this.totalMsAvg.full && this.totalMsAvg.average > ML_BUDGET_MS) {
      if (this.poseInterval === POSE_INTERVAL_NORMAL) {
        this.poseInterval = POSE_INTERVAL_DEGRADED;
        this.totalMsAvg.reset();
      }
    }
  }

  /**
   * Run one side's ROI crop detection on the MAIN-THREAD FALLBACK: smooth
   * the crop box around the pose wrist (unmirrored back into raw image
   * space), draw that video region upscaled into the side's reused
   * CROP_SIZE_PX canvas, detect the single hand, and map it back to player
   * space. Returns null when the crop contains no hand.
   */
  private detectCropSide(
    side: 'left' | 'right',
    arm: PoseArm,
    timestampMs: number,
    nowMs: number,
  ): HandFrame | null {
    const crop = this.cropSides[side];
    const video = this.video;
    if (!crop.landmarker || !crop.ctx || !crop.canvas || !video) return null;

    const rawWrist = playerToRaw(arm.wrist);
    const rawElbow = playerToRaw(arm.elbow);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const target = cropBoxForWrist(rawWrist, rawElbow, vw / vh);
    const box = crop.smoother.update(target, rawWrist, nowMs);

    crop.ctx.drawImage(
      video,
      box.x * vw,
      box.y * vh,
      box.w * vw,
      box.h * vh,
      0,
      0,
      CROP_SIZE_PX,
      CROP_SIZE_PX,
    );
    const hand = detectTopHand(crop.landmarker, crop.canvas, timestampMs);
    if (!hand) return null;
    return cropHandToPlayer(hand.landmarks, hand.world, hand.score, box);
  }
}
