/**
 * Webcam picture-in-picture panel (Phase 2, Task 2a): a lacquered-wood
 * corner panel in the bottom-right of the arena showing the player as in a
 * mirror, with both hands' full 21-point landmark skeletons and the pose
 * arms drawn over it in warm ember amber (aesthetic law: firelight, never
 * neon).
 *
 * Live path: the camera MediaStream is drawn MIRRORED (ctx.scale(-1, 1)),
 * so the panel behaves like a mirror; landmarks are already mirrored into
 * player space, so they draw at (x * w, y * h) directly on top. Replay
 * path (no stream): the panel fills with near-black lacquer and the
 * skeletons still draw, which keeps the overlay verifiable headless.
 *
 * Cheap by construction: one 2D canvas, one hidden <video>, no per-frame
 * allocations beyond canvas path drawing. render() is driven from the
 * arena's animation loop (display rate) and returns immediately while
 * hidden. Toggled with the C key (wired in ArenaScreen); ON by default.
 */

import type { LandmarkFrame, PoseArm, Vec3 } from '../tracking/types';
import { LM } from '../tracking/types';
import type { FramingGateState } from '../game/framingGate';

/** Standard MediaPipe hand topology: wrist->finger chains + palm arcs. */
export const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [LM.WRIST, LM.THUMB_CMC],
  [LM.THUMB_CMC, LM.THUMB_MCP],
  [LM.THUMB_MCP, LM.THUMB_IP],
  [LM.THUMB_IP, LM.THUMB_TIP],
  [LM.WRIST, LM.INDEX_MCP],
  [LM.INDEX_MCP, LM.INDEX_PIP],
  [LM.INDEX_PIP, LM.INDEX_DIP],
  [LM.INDEX_DIP, LM.INDEX_TIP],
  [LM.INDEX_MCP, LM.MIDDLE_MCP],
  [LM.MIDDLE_MCP, LM.MIDDLE_PIP],
  [LM.MIDDLE_PIP, LM.MIDDLE_DIP],
  [LM.MIDDLE_DIP, LM.MIDDLE_TIP],
  [LM.MIDDLE_MCP, LM.RING_MCP],
  [LM.RING_MCP, LM.RING_PIP],
  [LM.RING_PIP, LM.RING_DIP],
  [LM.RING_DIP, LM.RING_TIP],
  [LM.RING_MCP, LM.PINKY_MCP],
  [LM.WRIST, LM.PINKY_MCP],
  [LM.PINKY_MCP, LM.PINKY_PIP],
  [LM.PINKY_PIP, LM.PINKY_DIP],
  [LM.PINKY_DIP, LM.PINKY_TIP],
];

// Warm ember palette (theme.css family). NOT neon.
const BONE_COLOR = '#e0a458';
const JOINT_COLOR = '#ffb36b';
const GLOW_COLOR = 'rgba(201, 119, 46, 0.8)';
const ARM_COLOR = '#8a5a32';
const LABEL_COLOR = '#d8c8a8';
const LACQUER = '#0d0a08';

// Framing-guide palette (Round 3 Phase 3). Aesthetic law: NEVER green; a
// satisfied region reads parchment, a missing one dim ember, and the whole
// silhouette warms toward muted gold as the gate counts down.
const GUIDE_SATISFIED = 'rgba(216, 200, 168, 0.9)'; // parchment
const GUIDE_MISSING = 'rgba(138, 90, 50, 0.55)'; // dim ember
const GUIDE_ALL_GOOD = 'rgba(224, 183, 106, 0.95)'; // warm muted gold

/** Canvas backing-store resolution (CSS box is 300x225 in theme.css). */
const PIP_W = 600;
const PIP_H = 450;

export class WebcamPip {
  private readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private video: HTMLVideoElement | null = null;
  private frame: LandmarkFrame | null = null;
  private shown = true;
  private framing: FramingGateState | null = null;
  private readonly captionEl: HTMLDivElement;

  constructor(root: HTMLElement, stream?: MediaStream) {
    this.el = document.createElement('div');
    this.el.className = 'fb-pip';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fb-pip-canvas';
    this.canvas.width = PIP_W;
    this.canvas.height = PIP_H;
    this.el.appendChild(this.canvas);
    // Framing corrective line, rendered under the panel; empty while no
    // gate is active (see setFramingState).
    this.captionEl = document.createElement('div');
    this.captionEl.className = 'fb-pip-caption';
    this.el.appendChild(this.captionEl);
    root.appendChild(this.el);
    this.ctx = this.canvas.getContext('2d');

    if (stream) {
      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      video.srcObject = stream;
      void video.play().catch(() => {
        /* headless / autoplay refusal: panel falls back to lacquer fill */
      });
      this.video = video;
    }
  }

  /** Latest processed landmark frame (stored, drawn on next render()). */
  setFrame(frame: LandmarkFrame): void {
    this.frame = frame;
  }

  /**
   * Framing-gate state for the silhouette guide (Round 3 Phase 3). Non-null
   * while a gate is active (calibration framing step, mid-game framing
   * loss): the guide is drawn over the mirror and the corrective line
   * appears under the panel. Null hides both.
   */
  setFramingState(state: FramingGateState | null): void {
    this.framing = state;
    const text =
      state === null ? '' : state.top !== null ? state.top.text : 'Hold your stance.';
    if (this.captionEl.textContent !== text) this.captionEl.textContent = text;
    this.captionEl.classList.toggle('is-on', state !== null);
  }

  get visible(): boolean {
    return this.shown;
  }

  /** C-key toggle. Returns the new visibility. */
  toggle(): boolean {
    this.shown = !this.shown;
    this.el.classList.toggle('is-off', !this.shown);
    return this.shown;
  }

  /** Draw one panel frame. Skips all work while hidden. */
  render(): void {
    if (!this.shown) return;
    const ctx = this.ctx;
    if (!ctx) return;

    // Backdrop: mirrored live feed, or near-black lacquer on replay.
    ctx.shadowBlur = 0;
    const video = this.video;
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, -PIP_W, 0, PIP_W, PIP_H);
      ctx.restore();
      // Sit the feed into the scene: a light warm-dark wash.
      ctx.fillStyle = 'rgba(13, 10, 8, 0.28)';
      ctx.fillRect(0, 0, PIP_W, PIP_H);
    } else {
      ctx.fillStyle = LACQUER;
      ctx.fillRect(0, 0, PIP_W, PIP_H);
    }

    // Framing guide under the skeletons: the required-region silhouette.
    if (this.framing) this.drawGuide(ctx, this.framing);

    const frame = this.frame;
    if (!frame) return;

    // Pose arms first (dimmer, thinner, under the hand skeletons).
    const pose = frame.pose;
    if (pose) {
      this.drawArm(ctx, pose.left);
      this.drawArm(ctx, pose.right);
    }

    if (frame.left) this.drawHand(ctx, frame.left.landmarks, 'L');
    if (frame.right) this.drawHand(ctx, frame.right.landmarks, 'R');
  }

  /**
   * Required-region silhouette (Round 3 Phase 3): a simple rounded human
   * outline spanning the framing box the gate demands (head top ~8%,
   * hips ~72%, shoulder span ~36% of the panel width). Each region strokes
   * parchment when its requirement is satisfied and dim ember while it is
   * missing; once every requirement holds the whole outline warms to muted
   * gold for the 2 s countdown. No green, ever.
   */
  private drawGuide(ctx: CanvasRenderingContext2D, state: FramingGateState): void {
    const allGood = state.failures.length === 0;
    const color = (satisfied: boolean): string =>
      allGood ? GUIDE_ALL_GOOD : satisfied ? GUIDE_SATISFIED : GUIDE_MISSING;
    const X = (nx: number): number => nx * PIP_W;
    const Y = (ny: number): number => ny * PIP_H;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = 0;
    ctx.setLineDash([10, 8]);

    // Head: circle centered at (0.5, 0.17).
    ctx.strokeStyle = color(state.regions.head);
    ctx.beginPath();
    ctx.arc(X(0.5), Y(0.17), Y(0.09), 0, Math.PI * 2);
    ctx.stroke();

    // Shoulders: neck-to-shoulder arcs across (0.32..0.68, ~0.34).
    ctx.strokeStyle = color(state.regions.shoulders);
    ctx.beginPath();
    ctx.moveTo(X(0.44), Y(0.28));
    ctx.quadraticCurveTo(X(0.36), Y(0.3), X(0.32), Y(0.38));
    ctx.moveTo(X(0.56), Y(0.28));
    ctx.quadraticCurveTo(X(0.64), Y(0.3), X(0.68), Y(0.38));
    ctx.stroke();

    // Torso sides down to the hips, closing in a rounded hip line at 0.72.
    ctx.strokeStyle = color(state.regions.hips);
    ctx.beginPath();
    ctx.moveTo(X(0.33), Y(0.42));
    ctx.quadraticCurveTo(X(0.35), Y(0.6), X(0.38), Y(0.72));
    ctx.quadraticCurveTo(X(0.5), Y(0.78), X(0.62), Y(0.72));
    ctx.quadraticCurveTo(X(0.65), Y(0.6), X(0.67), Y(0.42));
    ctx.stroke();

    // Hands: open circles beside the torso at mid height.
    ctx.strokeStyle = color(state.regions.hands);
    ctx.beginPath();
    ctx.arc(X(0.22), Y(0.55), Y(0.05), 0, Math.PI * 2);
    ctx.moveTo(X(0.78) + Y(0.05), Y(0.55));
    ctx.arc(X(0.78), Y(0.55), Y(0.05), 0, Math.PI * 2);
    ctx.stroke();

    // Legs: two strokes from the hips to the frame bottom (standing).
    ctx.strokeStyle = color(state.regions.standing);
    ctx.beginPath();
    ctx.moveTo(X(0.43), Y(0.78));
    ctx.lineTo(X(0.41), Y(0.96));
    ctx.moveTo(X(0.57), Y(0.78));
    ctx.lineTo(X(0.59), Y(0.96));
    ctx.stroke();

    ctx.restore();
  }

  private drawArm(ctx: CanvasRenderingContext2D, arm: PoseArm): void {
    ctx.strokeStyle = ARM_COLOR;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(arm.shoulder.x * PIP_W, arm.shoulder.y * PIP_H);
    ctx.lineTo(arm.elbow.x * PIP_W, arm.elbow.y * PIP_H);
    ctx.lineTo(arm.wrist.x * PIP_W, arm.wrist.y * PIP_H);
    ctx.stroke();
  }

  private drawHand(
    ctx: CanvasRenderingContext2D,
    landmarks: readonly Vec3[],
    tag: 'L' | 'R',
  ): void {
    // Bones: warm amber lines with a small ember glow.
    ctx.strokeStyle = BONE_COLOR;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 6;
    ctx.shadowColor = GLOW_COLOR;
    ctx.beginPath();
    for (const bone of HAND_BONES) {
      const a = landmarks[bone[0]];
      const b = landmarks[bone[1]];
      if (!a || !b) continue;
      ctx.moveTo(a.x * PIP_W, a.y * PIP_H);
      ctx.lineTo(b.x * PIP_W, b.y * PIP_H);
    }
    ctx.stroke();

    // Joints: small filled dots.
    ctx.fillStyle = JOINT_COLOR;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    for (const lm of landmarks) {
      ctx.moveTo(lm.x * PIP_W + 3.5, lm.y * PIP_H);
      ctx.arc(lm.x * PIP_W, lm.y * PIP_H, 3.5, 0, Math.PI * 2);
    }
    ctx.fill();

    // Tiny serif L/R tag near the wrist.
    const wrist = landmarks[LM.WRIST];
    if (wrist) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = LABEL_COLOR;
      ctx.font = '20px Georgia, serif';
      ctx.fillText(tag, wrist.x * PIP_W + 10, wrist.y * PIP_H + 22);
    }
  }

  dispose(): void {
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.el.remove();
    this.frame = null;
  }
}
