/**
 * Calibration ritual (spec Section 8). Shows a dimmed mirrored webcam feed
 * (or a plain dark backdrop in replay mode), two ink-outline hands, and the
 * prompt "Raise your hands." Frames come from a provided LandmarkSource;
 * per-hand ConfidenceGates decide when tracking is stable (Section 5 gating:
 * 10 consecutive frames above 0.7). When both hands are tracked the outlines
 * snap to the player's wrists and ignite, the prompt swaps to "Bender
 * recognized.", and a 2 second window of frames is captured and reduced to
 * CalibrationStats. The screen then resolves its `calibrated` promise and
 * calls ctx.onComplete; the orchestrator transitions out with the flame wipe.
 *
 * Timing is frame-driven (LandmarkFrame.t), so replay fixtures stepped
 * synchronously calibrate deterministically.
 */

import type { Screen } from './screenManager';
import type { LandmarkFrame, LandmarkSource } from '../tracking/types';
import { LM } from '../tracking/types';
import { ConfidenceGate } from '../tracking/filters';
import {
  captureCalibration,
  type CalibrationStats,
} from '../gestures/calibrationStats';
import '../ui/theme.css';

export interface CalibrationContext {
  /** Frame stream. Pass the raw (ungated) source; this screen gates itself. */
  source: LandmarkSource;
  /** Optional live preview: an existing video element showing the camera. */
  video?: HTMLVideoElement;
  /** Or the raw camera stream; a video element is created around it. */
  stream?: MediaStream;
  /** Called once with the captured stats. The `calibrated` promise also resolves. */
  onComplete?: (stats: CalibrationStats) => void;
  /**
   * Called once when both hands gate in and the outlines ignite (the whoosh
   * moment). Added at T062 integration so the flow can fire engine.ignite().
   */
  onIgnite?: () => void;
}

/** Length of the stat capture window after ignition, in frame time. */
export const CAPTURE_WINDOW_MS = 2000;

/** Resting positions for the hand outlines before tracking locks on. */
const REST_LEFT = { x: 0.32, y: 0.55 };
const REST_RIGHT = { x: 0.68, y: 0.55 };

/**
 * Simple brush-outline open hand, thumb toward the outside. Drawn for the
 * right hand; the left is mirrored in CSS.
 */
const HAND_PATH =
  'M28 116 C26 102 24 94 23 82 L14 60 C12 54 17 50 21 54 L30 70 L30 34 ' +
  'C30 28 38 28 38 34 L38 64 L40 22 C40 16 48 16 48 22 L48 62 L52 28 ' +
  'C53 22 60 23 60 29 L57 64 L64 42 C66 36 73 39 71 45 L62 78 ' +
  'C60 92 58 104 56 116';

function handOutline(side: 'left' | 'right'): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `fb-hand fb-hand--${side}`;
  el.innerHTML =
    `<svg viewBox="0 0 90 120" aria-hidden="true">` +
    `<path d="${HAND_PATH}"></path>` +
    `</svg>`;
  return el;
}

type Phase = 'waiting' | 'capturing' | 'done';

export class CalibrationScreen implements Screen {
  private readonly leftGate = new ConfidenceGate();
  private readonly rightGate = new ConfidenceGate();
  private phase: Phase = 'waiting';
  private captureStartT = 0;
  private captured: LandmarkFrame[] = [];

  private detachFrames: (() => void) | null = null;
  private ctx: CalibrationContext | null = null;
  private ownVideo: HTMLVideoElement | null = null;
  private leftHandEl: HTMLElement | null = null;
  private rightHandEl: HTMLElement | null = null;
  private textEl: HTMLElement | null = null;

  private resolveStats: ((stats: CalibrationStats) => void) | null = null;
  private completion: Promise<CalibrationStats>;

  constructor() {
    this.completion = new Promise((resolve) => {
      this.resolveStats = resolve;
    });
  }

  /** Resolves with the captured stats once the ritual completes. */
  get calibrated(): Promise<CalibrationStats> {
    return this.completion;
  }

  enter(root: HTMLElement, ctx?: unknown): void {
    const c = ctx as CalibrationContext | undefined;
    if (!c || !c.source) {
      throw new Error('CalibrationScreen requires a ctx with a LandmarkSource');
    }
    this.ctx = c;

    // Reset for re-entry (a fresh promise if the last run already finished).
    this.leftGate.reset();
    this.rightGate.reset();
    this.captured = [];
    if (this.phase === 'done') {
      this.completion = new Promise((resolve) => {
        this.resolveStats = resolve;
      });
    }
    this.phase = 'waiting';

    root.classList.add('fb-cal');

    // Dimmed mirrored camera feed when available; replay mode shows only the
    // dark lacquer backdrop and the ritual still works.
    const video = c.video ?? (c.stream ? this.makeVideo(c.stream) : null);
    if (video) {
      video.classList.add('fb-cal-video');
      root.appendChild(video);
      void video.play?.().catch(() => undefined);
    }

    const shade = document.createElement('div');
    shade.className = 'fb-cal-shade';
    root.appendChild(shade);

    this.leftHandEl = handOutline('left');
    this.rightHandEl = handOutline('right');
    this.placeHand(this.leftHandEl, REST_LEFT.x, REST_LEFT.y);
    this.placeHand(this.rightHandEl, REST_RIGHT.x, REST_RIGHT.y);
    root.appendChild(this.leftHandEl);
    root.appendChild(this.rightHandEl);

    this.textEl = document.createElement('div');
    this.textEl.className = 'fb-cal-text';
    this.textEl.textContent = 'Raise your hands.';
    root.appendChild(this.textEl);

    this.detachFrames = c.source.onFrame((frame) => this.handleFrame(frame));
  }

  exit(): void {
    this.detachFrames?.();
    this.detachFrames = null;
    if (this.ownVideo) {
      this.ownVideo.srcObject = null;
      this.ownVideo = null;
    }
    this.ctx = null;
    this.leftHandEl = null;
    this.rightHandEl = null;
    this.textEl = null;
  }

  private makeVideo(stream: MediaStream): HTMLVideoElement {
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.srcObject = stream;
    this.ownVideo = video;
    return video;
  }

  private handleFrame(frame: LandmarkFrame): void {
    if (this.phase === 'done') return;

    if (this.phase === 'waiting') {
      const leftTracked = this.leftGate.update(
        frame.left ? frame.left.confidence : null,
      );
      const rightTracked = this.rightGate.update(
        frame.right ? frame.right.confidence : null,
      );
      if (leftTracked && rightTracked) this.ignite(frame);
      return;
    }

    // Capturing. Frames missing a hand still get recorded;
    // captureCalibration filters them per hand.
    this.captured.push(frame);
    this.followWrists(frame);
    if (frame.t - this.captureStartT >= CAPTURE_WINDOW_MS) this.finish();
  }

  private ignite(frame: LandmarkFrame): void {
    this.ctx?.onIgnite?.();
    this.phase = 'capturing';
    this.captureStartT = frame.t;
    this.captured = [frame];
    this.followWrists(frame);
    this.leftHandEl?.classList.add('ignited');
    this.rightHandEl?.classList.add('ignited');
    if (this.textEl) {
      this.textEl.textContent = 'Bender recognized.';
      // Restart the entry animation for the swapped line.
      this.textEl.style.animation = 'none';
      void this.textEl.offsetWidth;
      this.textEl.style.animation = '';
    }
  }

  private finish(): void {
    this.phase = 'done';
    const stats = captureCalibration(this.captured);
    this.resolveStats?.(stats);
    this.ctx?.onComplete?.(stats);
  }

  /** Snap the outlines to the tracked wrists. Coordinates are normalized. */
  private followWrists(frame: LandmarkFrame): void {
    const lw = frame.left?.landmarks[LM.WRIST];
    if (lw && this.leftHandEl) this.placeHand(this.leftHandEl, lw.x, lw.y);
    const rw = frame.right?.landmarks[LM.WRIST];
    if (rw && this.rightHandEl) this.placeHand(this.rightHandEl, rw.x, rw.y);
  }

  private placeHand(el: HTMLElement, nx: number, ny: number): void {
    el.style.left = `${(nx * 100).toFixed(2)}%`;
    el.style.top = `${(ny * 100).toFixed(2)}%`;
  }
}
