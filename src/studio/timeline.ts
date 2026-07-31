/**
 * Review timeline: a waveform-style signal track canvas, time-aligned with
 * the take's video, with a threshold overlay, draggable in/out trim
 * handles, rep-candidate markers (click to confirm/reject, drag their
 * boundaries), quality-warning ticks and a playhead. Pure canvas + pointer
 * math; the app owns the data and persistence, this component mutates the
 * passed rep/trim state through callbacks only.
 */

import type { StudioQualityEvent } from './exportSchema';
import type { StoredRep } from './exportBuild';
import type { SignalSample } from './peaks';
import { clampTrimRange } from './clock';

export interface TimelineCallbacks {
  /** The user scrubbed to a video time. */
  onSeek(ms: number): void;
  /** Trim range changed (already clamped). */
  onTrim(range: [number, number]): void;
  /** A rep was clicked: cycle pending -> confirmed -> rejected -> pending. */
  onRepToggle(index: number): void;
  /** A rep boundary was dragged. */
  onRepBoundary(index: number, edge: 'start' | 'end', ms: number): void;
}

interface Hit {
  kind: 'trim-start' | 'trim-end' | 'rep-start' | 'rep-end' | 'rep-body' | 'seek';
  repIndex?: number;
}

const WAVE_COLOR = 'rgba(201, 119, 46, 0.75)';
const WAVE_FILL = 'rgba(201, 119, 46, 0.28)';
const THRESHOLD_COLOR = 'rgba(224, 183, 106, 0.9)';
const TRIM_SHADE = 'rgba(13, 10, 8, 0.68)';
const TRIM_HANDLE = '#a8853c';
const PLAYHEAD = '#d8c8a8';
const REP_PENDING = 'rgba(216, 200, 168, 0.5)';
const REP_CONFIRMED = 'rgba(224, 183, 106, 0.95)';
const REP_REJECTED = 'rgba(107, 31, 21, 0.8)';
const QUALITY_COLOR = '#8a2f1d';

const REP_BAND_H = 18;
const HIT_PX = 7;

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private durationMs = 1;
  private samples: SignalSample[] = [];
  private threshold: number | null = null;
  private trim: [number, number] = [0, 1];
  private reps: StoredRep[] = [];
  private quality: StudioQualityEvent[] = [];
  private playheadMs = 0;
  private enabled = false;
  private drag: Hit | null = null;
  private dragMoved = false;

  constructor(
    host: HTMLElement,
    private readonly cb: TimelineCallbacks,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'st-timeline-canvas';
    host.appendChild(this.canvas);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
  }

  /** Load a take (or clear with enabled false). */
  setTake(data: {
    durationMs: number;
    samples: SignalSample[];
    threshold: number | null;
    trim: [number, number];
    reps: StoredRep[];
    quality: StudioQualityEvent[];
  } | null): void {
    if (data === null) {
      this.enabled = false;
      this.samples = [];
      this.reps = [];
      this.quality = [];
      this.render();
      return;
    }
    this.enabled = true;
    this.durationMs = Math.max(1, data.durationMs);
    this.samples = data.samples;
    this.threshold = data.threshold;
    this.trim = data.trim;
    this.reps = data.reps;
    this.quality = data.quality;
    this.render();
  }

  setPlayhead(ms: number): void {
    this.playheadMs = ms;
    this.render();
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  private xOf(ms: number, w: number): number {
    return (ms / this.durationMs) * w;
  }

  private msOf(x: number, w: number): number {
    return Math.min(this.durationMs, Math.max(0, (x / w) * this.durationMs));
  }

  private hitTest(x: number, y: number, w: number): Hit {
    const tsX = this.xOf(this.trim[0], w);
    const teX = this.xOf(this.trim[1], w);
    if (Math.abs(x - tsX) <= HIT_PX) return { kind: 'trim-start' };
    if (Math.abs(x - teX) <= HIT_PX) return { kind: 'trim-end' };
    if (y <= REP_BAND_H + 4) {
      for (let i = 0; i < this.reps.length; i++) {
        const r = this.reps[i];
        if (!r) continue;
        const sx = this.xOf(r.startMs, w);
        const ex = this.xOf(r.endMs, w);
        if (Math.abs(x - sx) <= HIT_PX - 2) return { kind: 'rep-start', repIndex: i };
        if (Math.abs(x - ex) <= HIT_PX - 2) return { kind: 'rep-end', repIndex: i };
        if (x > sx && x < ex) return { kind: 'rep-body', repIndex: i };
      }
    }
    return { kind: 'seek' };
  }

  // -------------------------------------------------------------------------
  // Pointer interactions
  // -------------------------------------------------------------------------

  private localX(e: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    return e.clientX - rect.left;
  }

  private onDown(e: PointerEvent): void {
    if (!this.enabled) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.drag = this.hitTest(x, y, rect.width);
    this.dragMoved = false;
    this.canvas.setPointerCapture(e.pointerId);
    if (this.drag.kind === 'seek') this.cb.onSeek(this.msOf(x, rect.width));
  }

  private onMove(e: PointerEvent): void {
    if (!this.enabled) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = this.localX(e);
    if (this.drag === null) {
      // Cursor affordances.
      const hit = this.hitTest(x, e.clientY - rect.top, rect.width);
      this.canvas.style.cursor =
        hit.kind === 'seek' ? 'crosshair' : hit.kind === 'rep-body' ? 'pointer' : 'ew-resize';
      return;
    }
    this.dragMoved = true;
    const ms = this.msOf(x, rect.width);
    switch (this.drag.kind) {
      case 'trim-start':
        this.cb.onTrim(clampTrimRange(ms, this.trim[1], this.durationMs));
        break;
      case 'trim-end':
        this.cb.onTrim(clampTrimRange(this.trim[0], ms, this.durationMs));
        break;
      case 'rep-start':
        if (this.drag.repIndex !== undefined) {
          this.cb.onRepBoundary(this.drag.repIndex, 'start', ms);
        }
        break;
      case 'rep-end':
        if (this.drag.repIndex !== undefined) {
          this.cb.onRepBoundary(this.drag.repIndex, 'end', ms);
        }
        break;
      case 'seek':
        this.cb.onSeek(ms);
        break;
      case 'rep-body':
        break;
    }
  }

  private onUp(e: PointerEvent): void {
    if (!this.enabled || this.drag === null) return;
    if (this.drag.kind === 'rep-body' && !this.dragMoved && this.drag.repIndex !== undefined) {
      this.cb.onRepToggle(this.drag.repIndex);
    }
    this.drag = null;
    this.canvas.releasePointerCapture(e.pointerId);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(10, Math.round(rect.width));
    const h = Math.max(10, Math.round(rect.height));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    if (!this.enabled) {
      ctx.fillStyle = 'rgba(216, 200, 168, 0.25)';
      ctx.font = '12px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText('Record a take to see its signal track', w / 2, h / 2 + 4);
      return;
    }

    const waveTop = REP_BAND_H + 4;
    const waveH = h - waveTop - 10;

    // Scale: fit the larger of max sample and 1.25x threshold.
    let maxV = 1e-6;
    for (const s of this.samples) if (s.v > maxV) maxV = s.v;
    if (this.threshold !== null) maxV = Math.max(maxV, this.threshold * 1.25);

    const yOf = (v: number): number => waveTop + waveH * (1 - Math.min(1, v / maxV));

    // Waveform.
    if (this.samples.length > 1) {
      ctx.beginPath();
      ctx.moveTo(this.xOf(this.samples[0]?.t ?? 0, w), yOf(0));
      for (const s of this.samples) ctx.lineTo(this.xOf(s.t, w), yOf(s.v));
      ctx.lineTo(this.xOf(this.samples[this.samples.length - 1]?.t ?? 0, w), yOf(0));
      ctx.closePath();
      ctx.fillStyle = WAVE_FILL;
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < this.samples.length; i++) {
        const s = this.samples[i];
        if (!s) continue;
        const x = this.xOf(s.t, w);
        if (i === 0) ctx.moveTo(x, yOf(s.v));
        else ctx.lineTo(x, yOf(s.v));
      }
      ctx.strokeStyle = WAVE_COLOR;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Threshold line.
    if (this.threshold !== null) {
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = THRESHOLD_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yOf(this.threshold));
      ctx.lineTo(w, yOf(this.threshold));
      ctx.stroke();
      ctx.restore();
    }

    // Rep markers.
    for (let i = 0; i < this.reps.length; i++) {
      const r = this.reps[i];
      if (!r) continue;
      const sx = this.xOf(r.startMs, w);
      const ex = this.xOf(r.endMs, w);
      const color =
        r.confirmed === true ? REP_CONFIRMED : r.confirmed === false ? REP_REJECTED : REP_PENDING;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.32;
      ctx.fillRect(sx, 2, Math.max(2, ex - sx), REP_BAND_H);
      ctx.globalAlpha = 1;
      ctx.fillRect(sx, 2, 2, REP_BAND_H);
      ctx.fillRect(ex - 2, 2, 2, REP_BAND_H);
      ctx.font = '10px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = color;
      const label = r.confirmed === false ? 'x' : `${i + 1}${r.manual ? 'm' : ''}`;
      ctx.fillText(label, (sx + ex) / 2, REP_BAND_H - 3);
      // Body shading down the waveform for confirmed reps.
      if (r.confirmed === true) {
        ctx.fillStyle = 'rgba(224, 183, 106, 0.07)';
        ctx.fillRect(sx, waveTop, ex - sx, waveH);
      }
    }

    // Quality ticks.
    for (const q of this.quality) {
      const x = this.xOf(q.tMs, w);
      ctx.fillStyle = QUALITY_COLOR;
      ctx.beginPath();
      ctx.moveTo(x, h - 9);
      ctx.lineTo(x - 4, h - 1);
      ctx.lineTo(x + 4, h - 1);
      ctx.closePath();
      ctx.fill();
    }

    // Trim shading + handles.
    const tsX = this.xOf(this.trim[0], w);
    const teX = this.xOf(this.trim[1], w);
    ctx.fillStyle = TRIM_SHADE;
    if (tsX > 0) ctx.fillRect(0, 0, tsX, h);
    if (teX < w) ctx.fillRect(teX, 0, w - teX, h);
    for (const hx of [tsX, teX]) {
      ctx.fillStyle = TRIM_HANDLE;
      ctx.fillRect(hx - 2, 0, 4, h);
      ctx.fillRect(hx - 5, h / 2 - 9, 10, 18);
      ctx.fillStyle = '#1a1512';
      ctx.fillRect(hx - 0.5, h / 2 - 5, 1, 10);
    }

    // Playhead.
    const px = this.xOf(this.playheadMs, w);
    ctx.fillStyle = PLAYHEAD;
    ctx.fillRect(px - 0.75, 0, 1.5, h);
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 7);
    ctx.closePath();
    ctx.fill();
  }
}
