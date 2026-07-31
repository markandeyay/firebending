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
 * Scheduling: hand detection every video frame, pose detection every 2nd
 * frame (~15 Hz, offset to odd frames so it never stacks on a face frame),
 * face detection every 4th frame (~15 Hz). Degrade rule: if the rolling
 * average (60 frames) of total ML time per frame exceeds the 7 ms budget,
 * the ladder inside this source steps in ORDER: pose drops to every 4th
 * frame FIRST, then (still over budget on the new configuration) face drops
 * to every 8th. Hands are never degraded. Pose and face are sample-and-held
 * between detections.
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

import type {
  FaceLandmarker,
  HandLandmarker,
  PoseLandmarker,
} from '@mediapipe/tasks-vision';
import type {
  FaceFrame,
  FrameListener,
  LandmarkFrame,
  LandmarkSource,
  PoseFrame,
} from './types';
import type { HandFrame, PoseArm } from './types';
import { createHandLandmarker, detectHands, detectTopHand } from './handSource';
import { createFaceLandmarker, detectFace } from './faceSource';
import { createPoseLandmarker, detectPose } from './poseSource';
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
const FACE_INTERVAL_NORMAL = 4;
const FACE_INTERVAL_DEGRADED = 8;
const POSE_INTERVAL_NORMAL = 2;
const POSE_INTERVAL_DEGRADED = 4;

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
  /** Rolling average face inference time (frames where it ran), ms. */
  faceMs: number;
  /** Rolling average pose inference time (frames where it ran), ms. */
  poseMs: number;
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
  private faceLandmarker: FaceLandmarker | null = null;
  private poseLandmarker: PoseLandmarker | null = null;
  private running = false;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private startTime = 0;
  private lastTimestamp = -1;
  private lastFrameTime = 0;
  private frameIndex = 0;
  private faceInterval = FACE_INTERVAL_NORMAL;
  private poseInterval = POSE_INTERVAL_NORMAL;
  /** Degrade-ladder multiplier on the face interval (T070). 1 = normal. */
  private faceIntervalMult = 1;
  /** Degrade-ladder multiplier on the pose interval. 1 = normal. */
  private poseIntervalMult = 1;
  private lastFace: FaceFrame | null = null;
  private lastPose: PoseFrame | null = null;
  private handMsAvg = new RollingAverage(ROLLING_WINDOW);
  private faceMsAvg = new RollingAverage(ROLLING_WINDOW);
  private poseMsAvg = new RollingAverage(ROLLING_WINDOW);
  private cropMsAvg = new RollingAverage(ROLLING_WINDOW);
  private totalMsAvg = new RollingAverage(ROLLING_WINDOW);
  private fpsAvg = new RollingAverage(ROLLING_WINDOW);
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
      faceMs: this.faceMsAvg.average,
      poseMs: this.poseMsAvg.average,
      fps: this.fpsAvg.average,
      cropMs: this.cropMsAvg.average,
      cropActive: {
        left: this.cropSides.left.active,
        right: this.cropSides.right.active,
      },
    };
  }

  /** True once the degrade rule has dropped face detection to every 8th frame. */
  get faceDegraded(): boolean {
    return this.faceInterval === FACE_INTERVAL_DEGRADED;
  }

  /** True once the degrade rule has dropped pose detection to every 4th frame. */
  get poseDegraded(): boolean {
    return this.poseInterval === POSE_INTERVAL_DEGRADED;
  }

  /**
   * Degrade-ladder hook (T070, append-only): multiply the face detection
   * interval. 1 restores the normal schedule; 2 halves the face rate
   * (nominal 7.5 Hz). Composes with the internal ML-budget degrade above;
   * hands are never touched. Replay sources have no such method and the
   * ladder wiring treats that as a no-op.
   */
  setFaceIntervalMultiplier(multiplier: number): void {
    this.faceIntervalMult = Math.max(1, Math.round(multiplier));
  }

  /**
   * Degrade-ladder hook, sibling of setFaceIntervalMultiplier: multiply the
   * pose detection interval. 1 restores the normal schedule (~15 Hz); 2
   * halves the pose rate (~7.5 Hz). The external ladder degrades pose
   * BEFORE face, matching this source's internal ML-budget order.
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

    const [hand, face, pose, cropLeft, cropRight] = await Promise.all([
      createHandLandmarker(),
      createFaceLandmarker(),
      createPoseLandmarker(),
      createHandLandmarker(1),
      createHandLandmarker(1),
    ]);
    this.handLandmarker = hand;
    this.faceLandmarker = face;
    this.poseLandmarker = pose;
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
    this.faceLandmarker?.close();
    this.faceLandmarker = null;
    this.poseLandmarker?.close();
    this.poseLandmarker = null;
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
    // uses the freshest wrist. It stays on frames ODD relative to its
    // interval so it never stacks on a face frame (face frames are
    // multiples of 4). Sample-and-hold between detections; PoseFrame.t is
    // re-stamped into frame time so downstream freshness and
    // angular-velocity math share the frame clock.
    const poseEvery = this.poseInterval * this.poseIntervalMult;
    if (this.poseLandmarker && this.frameIndex % poseEvery === 1) {
      const poseStart = performance.now();
      const pose = detectPose(this.poseLandmarker, video, timestamp);
      this.lastPose = pose ? { ...pose, t: now - this.startTime } : null;
      const poseMs = performance.now() - poseStart;
      this.poseMsAvg.push(poseMs);
      totalMs += poseMs;
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

    const faceEvery = this.faceInterval * this.faceIntervalMult;
    if (this.faceLandmarker && this.frameIndex % faceEvery === 0) {
      const faceStart = performance.now();
      this.lastFace = detectFace(this.faceLandmarker, video, timestamp);
      const faceMs = performance.now() - faceStart;
      this.faceMsAvg.push(faceMs);
      totalMs += faceMs;
    }

    this.totalMsAvg.push(totalMs);
    if (this.totalMsAvg.full && this.totalMsAvg.average > ML_BUDGET_MS) {
      // Over budget consistently. Internal ML-budget ladder, in order:
      // pose first (every 4th frame), then face (every 8th); hands never.
      // The window resets after each step so the next verdict measures the
      // new configuration instead of the old one's backlog.
      if (this.poseInterval === POSE_INTERVAL_NORMAL) {
        this.poseInterval = POSE_INTERVAL_DEGRADED;
        this.totalMsAvg.reset();
      } else if (this.faceInterval === FACE_INTERVAL_NORMAL) {
        this.faceInterval = FACE_INTERVAL_DEGRADED;
        this.totalMsAvg.reset();
      }
    }

    const frame: LandmarkFrame = {
      t: now - this.startTime,
      left: hands.left,
      right: hands.right,
      face: this.lastFace,
      pose: this.lastPose,
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
