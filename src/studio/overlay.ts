/**
 * Stage overlay for the studio: hand landmark webs + pose skeleton in warm
 * ember amber, plus the framing silhouette guide while in live preview.
 * Landmarks are player-space normalized (already mirrored), and the stage
 * video is CSS-mirrored, so points draw directly at (x * w, y * h) inside
 * the letterboxed video rect (object-fit: contain).
 */

import type { LandmarkFrame, PoseArm, PoseFrame, Vec3 } from '../tracking/types';
import { LM } from '../tracking/types';
import { HAND_BONES } from '../ui/pip';
import type { FramingEval } from '../game/framingGate';

const BONE_COLOR = '#e0a458';
const JOINT_COLOR = '#ffb36b';
const GLOW_COLOR = 'rgba(201, 119, 46, 0.8)';
const ARM_COLOR = '#b07a42';
const LINE_COLOR = 'rgba(176, 122, 66, 0.55)';
const GUIDE_OK = 'rgba(216, 200, 168, 0.85)';
const GUIDE_BAD = 'rgba(138, 90, 50, 0.55)';

/** The video's letterboxed content rect inside the canvas (contain fit). */
export function containRect(
  canvasW: number,
  canvasH: number,
  videoW: number,
  videoH: number,
): { x: number; y: number; w: number; h: number } {
  if (videoW <= 0 || videoH <= 0) return { x: 0, y: 0, w: canvasW, h: canvasH };
  const scale = Math.min(canvasW / videoW, canvasH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h };
}

export class StageOverlay {
  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Draw one overlay frame. `guide` non-null shows the framing silhouette. */
  render(
    frame: LandmarkFrame | null,
    videoW: number,
    videoH: number,
    guide: FramingEval | null,
  ): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const host = this.canvas.parentElement;
    const cw = host ? host.clientWidth : this.canvas.clientWidth;
    const ch = host ? host.clientHeight : this.canvas.clientHeight;
    if (cw > 0 && (this.canvas.width !== cw || this.canvas.height !== ch)) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const rect = containRect(this.canvas.width, this.canvas.height, videoW, videoH);
    const X = (nx: number): number => rect.x + nx * rect.w;
    const Y = (ny: number): number => rect.y + ny * rect.h;

    if (guide !== null) this.drawGuide(ctx, X, Y, guide);
    if (!frame) return;

    const pose = frame.pose ?? null;
    if (pose) this.drawPose(ctx, X, Y, pose);
    if (frame.left) this.drawHand(ctx, X, Y, frame.left.landmarks, 'L');
    if (frame.right) this.drawHand(ctx, X, Y, frame.right.landmarks, 'R');
  }

  private drawPose(
    ctx: CanvasRenderingContext2D,
    X: (n: number) => number,
    Y: (n: number) => number,
    pose: PoseFrame,
  ): void {
    ctx.lineCap = 'round';
    ctx.shadowBlur = 0;

    // Shoulder and hip cross-lines.
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(X(pose.left.shoulder.x), Y(pose.left.shoulder.y));
    ctx.lineTo(X(pose.right.shoulder.x), Y(pose.right.shoulder.y));
    ctx.moveTo(X(pose.left.hip.x), Y(pose.left.hip.y));
    ctx.lineTo(X(pose.right.hip.x), Y(pose.right.hip.y));
    // Torso sides.
    ctx.moveTo(X(pose.left.shoulder.x), Y(pose.left.shoulder.y));
    ctx.lineTo(X(pose.left.hip.x), Y(pose.left.hip.y));
    ctx.moveTo(X(pose.right.shoulder.x), Y(pose.right.shoulder.y));
    ctx.lineTo(X(pose.right.hip.x), Y(pose.right.hip.y));
    ctx.stroke();

    const arm = (a: PoseArm): void => {
      ctx.beginPath();
      ctx.moveTo(X(a.shoulder.x), Y(a.shoulder.y));
      ctx.lineTo(X(a.elbow.x), Y(a.elbow.y));
      ctx.lineTo(X(a.wrist.x), Y(a.wrist.y));
      ctx.stroke();
    };
    ctx.strokeStyle = ARM_COLOR;
    ctx.lineWidth = 3.5;
    arm(pose.left);
    arm(pose.right);

    // Legs when visible.
    const legs = pose.legs;
    if (legs) {
      ctx.strokeStyle = LINE_COLOR;
      ctx.lineWidth = 2.5;
      for (const side of ['left', 'right'] as const) {
        const leg = legs[side];
        const hip = side === 'left' ? pose.left.hip : pose.right.hip;
        if (!leg.knee) continue;
        ctx.beginPath();
        ctx.moveTo(X(hip.x), Y(hip.y));
        ctx.lineTo(X(leg.knee.x), Y(leg.knee.y));
        if (leg.ankle) ctx.lineTo(X(leg.ankle.x), Y(leg.ankle.y));
        ctx.stroke();
      }
    }

    // Head: nose dot + ear line.
    const head = pose.head;
    if (head) {
      ctx.strokeStyle = LINE_COLOR;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X(head.leftEar.x), Y(head.leftEar.y));
      ctx.lineTo(X(head.rightEar.x), Y(head.rightEar.y));
      ctx.stroke();
      ctx.fillStyle = JOINT_COLOR;
      ctx.beginPath();
      ctx.arc(X(head.nose.x), Y(head.nose.y), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Joint dots.
    ctx.fillStyle = JOINT_COLOR;
    ctx.beginPath();
    for (const a of [pose.left, pose.right]) {
      for (const p of [a.shoulder, a.elbow, a.wrist, a.hip]) {
        ctx.moveTo(X(p.x) + 3, Y(p.y));
        ctx.arc(X(p.x), Y(p.y), 3, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }

  private drawHand(
    ctx: CanvasRenderingContext2D,
    X: (n: number) => number,
    Y: (n: number) => number,
    landmarks: readonly Vec3[],
    tag: 'L' | 'R',
  ): void {
    ctx.strokeStyle = BONE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 5;
    ctx.shadowColor = GLOW_COLOR;
    ctx.beginPath();
    for (const bone of HAND_BONES) {
      const a = landmarks[bone[0]];
      const b = landmarks[bone[1]];
      if (!a || !b) continue;
      ctx.moveTo(X(a.x), Y(a.y));
      ctx.lineTo(X(b.x), Y(b.y));
    }
    ctx.stroke();

    ctx.fillStyle = JOINT_COLOR;
    ctx.shadowBlur = 3;
    ctx.beginPath();
    for (const p of landmarks) {
      ctx.moveTo(X(p.x) + 2.2, Y(p.y));
      ctx.arc(X(p.x), Y(p.y), 2.2, 0, Math.PI * 2);
    }
    ctx.fill();

    const wrist = landmarks[LM.WRIST];
    if (wrist) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(216, 200, 168, 0.85)';
      ctx.font = '14px Georgia, serif';
      ctx.fillText(tag, X(wrist.x) + 8, Y(wrist.y) + 16);
    }
  }

  /**
   * Framing silhouette guide (live preview only): the simple rounded human
   * outline from the game's PIP, region-tinted parchment when satisfied and
   * dim ember while missing. Never green.
   */
  private drawGuide(
    ctx: CanvasRenderingContext2D,
    X: (n: number) => number,
    Y: (n: number) => number,
    ev: FramingEval,
  ): void {
    const color = (ok: boolean): string => (ok ? GUIDE_OK : GUIDE_BAD);
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.setLineDash([9, 7]);
    ctx.shadowBlur = 0;

    ctx.strokeStyle = color(ev.regions.head);
    ctx.beginPath();
    ctx.arc(X(0.5), Y(0.17), Y(0.09) - Y(0), 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = color(ev.regions.shoulders);
    ctx.beginPath();
    ctx.moveTo(X(0.44), Y(0.28));
    ctx.quadraticCurveTo(X(0.36), Y(0.3), X(0.32), Y(0.38));
    ctx.moveTo(X(0.56), Y(0.28));
    ctx.quadraticCurveTo(X(0.64), Y(0.3), X(0.68), Y(0.38));
    ctx.stroke();

    ctx.strokeStyle = color(ev.regions.hips);
    ctx.beginPath();
    ctx.moveTo(X(0.33), Y(0.42));
    ctx.quadraticCurveTo(X(0.35), Y(0.6), X(0.38), Y(0.72));
    ctx.quadraticCurveTo(X(0.5), Y(0.78), X(0.62), Y(0.72));
    ctx.quadraticCurveTo(X(0.65), Y(0.6), X(0.67), Y(0.42));
    ctx.stroke();

    ctx.strokeStyle = color(ev.regions.hands);
    ctx.beginPath();
    ctx.arc(X(0.22), Y(0.55), Y(0.05) - Y(0), 0, Math.PI * 2);
    ctx.moveTo(X(0.78) + (Y(0.05) - Y(0)), Y(0.55));
    ctx.arc(X(0.78), Y(0.55), Y(0.05) - Y(0), 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = color(ev.regions.standing);
    ctx.beginPath();
    ctx.moveTo(X(0.43), Y(0.78));
    ctx.lineTo(X(0.41), Y(0.96));
    ctx.moveTo(X(0.57), Y(0.78));
    ctx.lineTo(X(0.59), Y(0.96));
    ctx.stroke();

    ctx.restore();
  }
}
