/**
 * LiveLandmarkSource: the real-camera implementation of LandmarkSource.
 *
 * WORKER DECISION (revised, Round 3 Phase 2): HANDS run on the main thread
 * (the MediaPipe GPU delegate already runs inference off the JS thread and
 * the ROI crop path needs the video element + 2d canvases); POSE runs in a
 * dedicated Worker (poseWorker.ts) that owns its own PoseLandmarker. The
 * main thread grabs frames with createImageBitmap(video) (transferable, no
 * copy) at a target 25 Hz cadence and posts them over; the worker answers
 * with the RAW landmark arrays and the main thread runs the pure extraction
 * (extractPoseFrame + headPoseFromPose) so all coordinate math stays
 * unit-testable. BACKPRESSURE: never more than ONE frame in flight; while
 * the worker is busy, capture is skipped, so the achieved pose Hz (reported
 * in stats) self-regulates to what the machine can do. If Worker or
 * createImageBitmap is unavailable (or worker init fails), pose falls back
 * to the main thread on the classic every-2nd-frame schedule.
 *
 * HEAD POSE: FaceLandmarker is GONE (Phase 2). Every pose sample also
 * derives frame.face via headPoseFromPose (nose + ears), sample-and-held at
 * pose rate. FaceFrame and all its consumers are unchanged.
 *
 * POSE INTERPOLATION (worker path): between worker results, per-frame
 * emission linearly interpolates the last two pose samples
 * (lerpPoseFrames, extrapolation capped at 80 ms) so downstream consumers
 * see smooth per-frame pose. Interpolated frames carry `interpolated:
 * true`; the move engine's elbow angular-velocity tracker skips them and
 * differences only real samples. The frame on which a fresh sample arrives
 * emits the RAW sample itself.
 *
 * Scheduling: hand detection every video frame; pose per the worker cadence
 * above (fallback: every 2nd frame ~15 Hz, every 4th when degraded).
 * Degrade rule: if the rolling average (60 frames) of total MAIN-THREAD ML
 * time per frame exceeds the 7 ms budget, the internal ladder halves the
 * pose rate (worker cadence and fallback interval both respect it). Hands
 * are never degraded.
 *
 * ROI CROP HAND PATH (Round 3 Phase 1): per side, when the held pose is
 * FRESH (sample within POSE_FRESH_MS) and that wrist is visible, the hand
 * detector runs on a square crop around the pose wrist, drawn upscaled into
 * a reused 256x256 canvas, instead of on the full frame. Landmarks map back
 * to full-frame space (roiCrop.ts) and then get the exact same mirroring as
 * before; the frame slot comes from the POSE side, not the MediaPipe
 * handedness label, which removes label flips entirely on this path. Sides
 * whose pose is stale or wrist not visible fall back to the legacy
 * full-frame 2-hand detection, which stays alive for that purpose; the two
 * paths never both run for the same side in one frame.
 *
 * CROP ARCHITECTURE CHOICE: (a) two dedicated 1-hand HandLandmarker
 * instances, one per side, VIDEO mode, rather than (b) one 2-hand instance
 * over a composite side-by-side canvas. Rationale: each instance keeps its
 * own temporal tracking state locked to one hand's crop stream, so tracking
 * continuity survives the other hand appearing/disappearing; there is no
 * composite-canvas bookkeeping, no gap tuning, and no ambiguity when a
 * detection straddles the split line; timestamps are trivially monotonic
 * per instance (each is called at most once per frame with the shared
 * strictly-increasing frame timestamp). The cost is one extra hand-model
 * instance in memory (a few MB), which profiling has not shown to matter.
 */

import type { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type {
  FaceFrame,
  FrameListener,
  LandmarkFrame,
  LandmarkSource,
  PoseFrame,
} from './types';
import type { HandFrame, PoseArm } from './types';
import { createHandLandmarker, detectHands, detectTopHand } from './handSource';
import {
  createPoseLandmarker,
  detectPoseAndHead,
  extractPoseFrame,
  headPoseFromPose,
  lerpPoseFrames,
} from './poseSource';
import type { PoseWorkerRequest, PoseWorkerResponse } from './poseWorker';
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
} from './roiCrop';

/** Combined ML budget per frame in ms (Section 14). */
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
  /** Rolling average TOTAL hand-path time per frame (crop + fallback), ms. */
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
  /** Rolling average frames per second of the emit loop. */
  fps: number;
  /** Rolling average ROI crop draw+detect time (frames where crops ran), ms. */
  cropMs: number;
  /** Whether each side used the ROI crop path on the most recent frame. */
  cropActive: { left: boolean; right: boolean };
}

/** Per-side state for the ROI crop path. */
interface CropSide {
  landmarker: HandLandmarker | null;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  smoother: CropSmoother;
  active: boolean;
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

  // --- Pose worker state (see the header WORKER DECISION note) -------------
  private poseWorker: Worker | null = null;
  private poseWorkerReady = false;
  /** Backpressure: at most ONE frame in flight to the worker. */
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
      fps: this.fpsAvg.average,
      cropMs: this.cropMsAvg.average,
      cropActive: {
        left: this.cropSides.left.active,
        right: this.cropSides.right.active,
      },
    };
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
   * method and the ladder wiring treats that as a no-op. (The old
   * setFaceIntervalMultiplier hook is gone with FaceLandmarker: head pose
   * now rides the pose samples for free.)
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

    // Pose: dedicated worker when the platform supports it (Worker +
    // createImageBitmap), main-thread landmarker otherwise. The worker
    // initializes in the background; pose frames are simply absent until it
    // reports ready, and an init failure swaps in the main-thread fallback.
    const workerCapable =
      typeof Worker === 'function' && typeof createImageBitmap === 'function';
    if (workerCapable) this.startPoseWorker();

    const [hand, cropLeft, cropRight] = await Promise.all([
      createHandLandmarker(),
      createHandLandmarker(1),
      createHandLandmarker(1),
    ]);
    this.handLandmarker = hand;
    if (!workerCapable) {
      this.poseLandmarker = await createPoseLandmarker();
    }
    this.initCropSide('left', cropLeft);
    this.initCropSide('right', cropRight);

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

  /** Wire one side's crop landmarker and its reused upscale canvas. */
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
   * Worker-path capture: at most one frame in flight, target cadence
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
   * The PoseFrame to emit on this video frame:
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

    // Pose runs FIRST within the frame so the ROI crop path below always
    // uses the freshest wrist.
    // Worker path: post a bitmap when the cadence and the one-in-flight
    // backpressure allow; results land asynchronously in
    // onPoseWorkerMessage, which also derives the head-pose FaceFrame.
    // Fallback path: main-thread detection every poseInterval-th frame,
    // sample-and-held; PoseFrame.t is re-stamped into frame time so
    // downstream freshness and angular-velocity math share the frame clock.
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

    // Hand path selection, per side: ROI crop when the held pose is fresh
    // and that wrist is visible, legacy full-frame otherwise. The two
    // paths never both run for the same side in one frame: a full-frame
    // detection (at most one per frame) only fills the slots of the sides
    // that did NOT run a crop.
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
    if (needFull) {
      const full = detectHands(this.handLandmarker, video, timestamp);
      if (!this.cropSides.left.active) hands.left = full.left;
      if (!this.cropSides.right.active) hands.right = full.right;
    }
    const handMs = performance.now() - handStart;
    this.handMsAvg.push(handMs);
    if (cropRan) this.cropMsAvg.push(cropMs);
    totalMs += handMs;

    this.totalMsAvg.push(totalMs);
    if (this.totalMsAvg.full && this.totalMsAvg.average > ML_BUDGET_MS) {
      // Over budget consistently. Internal ML-budget ladder: halve the pose
      // rate (hands never degrade; face is free since it rides the pose
      // samples). The window resets after the step so the next verdict
      // measures the new configuration instead of the old one's backlog.
      if (this.poseInterval === POSE_INTERVAL_NORMAL) {
        this.poseInterval = POSE_INTERVAL_DEGRADED;
        this.totalMsAvg.reset();
      }
    }

    const frame: LandmarkFrame = {
      t: frameT,
      left: hands.left,
      right: hands.right,
      face: this.lastFace,
      pose: this.poseForEmit(frameT),
    };
    this.frameIndex++;
    for (const l of this.listeners) l(frame);

    this.scheduleNext();
  }

  /**
   * Run one side's ROI crop detection: smooth the crop box around the pose
   * wrist (unmirrored back into raw image space), draw that video region
   * upscaled into the side's reused CROP_SIZE_PX canvas, detect the single
   * hand, and map it back to player space. Returns null when the crop
   * contains no hand.
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
