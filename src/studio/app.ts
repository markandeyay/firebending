/**
 * The recording-studio application (Round 3 Phase 4): capture the user's
 * real gesture data with the game's own tracking stack.
 *
 * LAYOUT: header (progress + export), left rail (16 takes), center stage
 * (live mirror with skeleton overlay + framing guide, record control,
 * countdown), timeline (signal track, trim, rep markers), right rail
 * (instruction card with a looping stick-figure animation).
 *
 * TWO SYNCHRONIZED STREAMS, ONE CLOCK: webcam video via MediaRecorder and
 * every FilteredSource LandmarkFrame with all derived signals; both mapped
 * onto the take's video clock through frameClockOffset (src/studio/clock.ts,
 * unit-tested). IndexedDB autosaves everything; refresh recovers the board.
 *
 * KEYS: space record/stop, J/K/L shuttle, arrows step, M rep marker.
 */

import type { LandmarkFrame } from '../tracking/types';
import { LiveLandmarkSource } from '../tracking/liveSource';
import { FilteredSource } from '../tracking/filters';
import { evaluateFraming } from '../game/framingGate';
import {
  DEFAULT_PROFILE,
  loadProfile,
  thresholdsFrom,
  type MotionThresholds,
} from '../gestures/profile';
import {
  RATE_GATE_FPS,
  RollingRateMeter,
  classifyRate,
  takeFpsStats,
} from './captureRate';
import { frameClockOffset, nearestFrameIndex, videoTimeOf } from './clock';
import { detectReps, type SignalSample } from './peaks';
import { SignalTracker, handPresent } from './signals';
import { TAKES, primarySignalValue, takeDef } from './takes';
import type { StudioFrame, StudioQualityEvent, TakeId } from './exportSchema';
import {
  buildExport,
  exportFilename,
  takeKey,
  type StoredRep,
  type StoredTake,
} from './exportBuild';
import { StudioDb } from './db';
import { StageOverlay } from './overlay';
import { Timeline } from './timeline';
import { StickFigureRenderer } from './stickfigure';

type Mode = 'idle' | 'countdown' | 'recording' | 'review';

/** MediaRecorder container preference, first supported wins. */
export const MIME_CHAIN = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

/** Threshold line for palm-score tracks (the pose hysteresis enter level). */
const PALM_ACTIVE_LINE = 0.75;
/** Same-kind quality warnings are debounced to one per episode window. */
const QUALITY_DEBOUNCE_MS = 2500;
/** A hand absent this long after being seen counts as vanished. */
const HAND_LOST_MS = 300;
const COUNTDOWN_STEP_MS = 900;

const EXPORT_DIR_TEXT =
  'Save the file into C:\\Users\\yalam\\firebending\\fixtures\\recorded\\ then run: npm run analyze';

export class StudioApp {
  // Data
  private db: StudioDb | null = null;
  private readonly takes = new Map<string, StoredTake>();
  private readonly videoBlobs = new Map<string, { blob: Blob; mimeType: string }>();
  private thresholds: MotionThresholds = thresholdsFrom(loadProfile() ?? DEFAULT_PROFILE);
  private lightingNote = '';

  // Camera
  private live: LiveLandmarkSource | null = null;
  private filtered: FilteredSource | null = null;
  private latestFrame: LandmarkFrame | null = null;
  private latestFramePerf = 0;
  private cameraW = 640;
  private cameraH = 480;
  private cameraReady = false;
  /** Rolling landmark-frame arrival rate (last 60 arrivals). */
  private readonly rateMeter = new RollingRateMeter();
  private lastRateRenderMs = 0;

  // Mode
  private mode: Mode = 'idle';
  private selectedId: TakeId = 'jab-left-x5';
  private reviewKey: string | null = null;

  // Recording
  private readonly tracker = new SignalTracker();
  private recorder: MediaRecorder | null = null;
  private recChunks: Blob[] = [];
  private recMime = 'video/webm';
  private recStartPerf = 0;
  private recOffset: number | null = null;
  private recFrames: StudioFrame[] = [];
  private recSamples: SignalSample[] = [];
  private recQuality: StudioQualityEvent[] = [];
  private recRepCount = 0;
  private lastRepScanMs = 0;
  private lastQualityAt: Record<string, number> = {};
  private handSeen: { left: boolean; right: boolean } = { left: false, right: false };
  private handLastPresent: { left: number; right: number } = { left: 0, right: 0 };
  private countdownValue = 0;
  private countdownTimer: number | null = null;

  // Review
  private reviewSamples: SignalSample[] = [];
  private reviewThreshold: number | null = null;
  private playheadMs = 0;
  private shuttle = 0; // negative = J reverse shuttle
  private playRate = 1;
  private reviewUrl: string | null = null;
  private rvfcHandle: number | null = null;

  // Audio ticks
  private audioCtx: AudioContext | null = null;

  // Autosave
  private saveTimer: number | null = null;

  // DOM
  private readonly root: HTMLElement;
  private takeListEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private savedEl!: HTMLElement;
  private stageEl!: HTMLElement;
  private liveVideo!: HTMLVideoElement;
  private reviewVideo!: HTMLVideoElement;
  private overlayCanvas!: HTMLCanvasElement;
  private stageMsgEl!: HTMLElement;
  private recChipEl!: HTMLElement;
  private recTimeEl!: HTMLElement;
  private recRepsEl!: HTMLElement;
  private modeChipEl!: HTMLElement;
  private rateChipEl!: HTMLElement;
  private rateBannerEl!: HTMLElement;
  private rateBannerHeadEl!: HTMLElement;
  private countEl: HTMLElement | null = null;
  private recordBtn!: HTMLButtonElement;
  private controlsEl!: HTMLElement;
  private cardEl!: HTMLElement;
  private stickCanvas!: HTMLCanvasElement;

  private overlay!: StageOverlay;
  private timeline!: Timeline;
  private stick!: StickFigureRenderer;
  private rafHandle: number | null = null;
  private disposed = false;

  private constructor(root: HTMLElement) {
    this.root = root;
  }

  static async create(root: HTMLElement): Promise<StudioApp> {
    const app = new StudioApp(root);
    app.buildDom();
    await app.openDb();
    app.selectTake(app.selectedId);
    app.renderTakeList();
    app.renderProgress();
    void app.bootCamera();
    app.loop();
    window.addEventListener('keydown', app.onKeyDown);
    return app;
  }

  // -------------------------------------------------------------------------
  // DOM construction
  // -------------------------------------------------------------------------

  private buildDom(): void {
    this.root.replaceChildren();
    const shell = el('div', 'st-root');

    // Header.
    const header = el('header', 'st-header');
    const title = el('h1', 'st-title');
    title.innerHTML = 'FIREBENDING <span>RECORDING STUDIO</span>';
    this.progressEl = el('div', 'st-progress');
    this.savedEl = el('div', 'st-saved');
    this.savedEl.textContent = 'Autosave ready';
    const exportBtn = el('button', 'st-export-btn') as HTMLButtonElement;
    exportBtn.textContent = 'EXPORT';
    exportBtn.addEventListener('click', () => this.openExportModal());
    header.append(title, this.progressEl, this.savedEl, exportBtn);

    // Body grid.
    const body = el('div', 'st-body');

    // Take rail.
    this.takeListEl = el('aside', 'st-takes');
    const th = el('div', 'st-takes-heading');
    th.textContent = 'TAKE BOARD';
    this.takeListEl.appendChild(th);

    // Center.
    const center = el('main', 'st-center');
    this.stageEl = el('div', 'st-stage');
    this.liveVideo = document.createElement('video');
    this.liveVideo.className = 'st-video';
    this.liveVideo.playsInline = true;
    this.liveVideo.muted = true;
    this.liveVideo.autoplay = true;
    this.reviewVideo = document.createElement('video');
    this.reviewVideo.className = 'st-review-video';
    this.reviewVideo.playsInline = true;
    this.reviewVideo.muted = true;
    this.reviewVideo.style.display = 'none';
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'st-overlay';
    this.stageMsgEl = el('div', 'st-stage-msg');
    this.stageMsgEl.textContent = 'Starting camera...';
    this.recChipEl = el('div', 'st-rec-chip');
    const dot = el('span', 'st-rec-dot');
    this.recTimeEl = el('span', 'st-rec-time');
    this.recRepsEl = el('span', 'st-rec-reps');
    this.recChipEl.append(dot, this.recTimeEl, this.recRepsEl);
    this.modeChipEl = el('div', 'st-mode-chip');
    this.modeChipEl.textContent = 'LIVE';
    // Live capture-rate chip (Phase 1 hard gate): actual landmark-frame
    // arrival rate, updated ~2Hz from the rolling meter.
    this.rateChipEl = el('div', 'st-rate-chip');
    this.rateChipEl.textContent = 'capture -- fps';
    // Low-rate banner over the stage. Recording is never blocked, but the
    // take gets stamped and badged (see finalizeRecording).
    this.rateBannerEl = el('div', 'st-rate-banner');
    this.rateBannerHeadEl = el('div', 'st-rate-banner-head');
    const rateFix = el('div', 'st-rate-banner-fix');
    rateFix.textContent =
      'Close other heavy apps, brighten the room so the camera can use a short exposure, or give the tracker a few seconds to finish warming up.';
    this.rateBannerEl.append(this.rateBannerHeadEl, rateFix);
    this.recordBtn = el('button', 'st-record-btn') as HTMLButtonElement;
    this.recordBtn.title = 'Record (space)';
    this.recordBtn.addEventListener('click', () => this.toggleRecord());
    const recHint = el('div', 'st-record-hint');
    recHint.textContent = 'SPACE';
    this.stageEl.append(
      this.liveVideo,
      this.reviewVideo,
      this.overlayCanvas,
      this.stageMsgEl,
      this.recChipEl,
      this.modeChipEl,
      this.rateChipEl,
      this.rateBannerEl,
      this.recordBtn,
      recHint,
    );

    const timelineHost = el('div', 'st-timeline');
    this.controlsEl = el('div', 'st-controls');

    center.append(this.stageEl, timelineHost, this.controlsEl);

    // Instruction card.
    this.cardEl = el('aside', 'st-card');

    body.append(this.takeListEl, center, this.cardEl);
    shell.append(header, body);
    this.root.appendChild(shell);

    this.overlay = new StageOverlay(this.overlayCanvas);
    this.timeline = new Timeline(timelineHost, {
      onSeek: (ms) => this.seekTo(ms),
      onTrim: (range) => this.setTrim(range),
      onRepToggle: (i) => this.toggleRep(i),
      onRepBoundary: (i, edge, ms) => this.dragRepBoundary(i, edge, ms),
    });
    this.stickCanvas = document.createElement('canvas');
    this.stickCanvas.className = 'st-card-anim';
    this.stickCanvas.width = 300;
    this.stickCanvas.height = 240;
    this.stick = new StickFigureRenderer(this.stickCanvas);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async openDb(): Promise<void> {
    try {
      this.db = await StudioDb.open();
      const stored = await this.db.loadTakes();
      for (const t of stored) this.takes.set(t.key, t);
      this.lightingNote = (await this.db.getSetting('lightingNote')) ?? '';
      if (stored.length > 0) {
        this.flashSaved(`Recovered ${stored.length} take${stored.length === 1 ? '' : 's'}`);
      }
    } catch (err) {
      console.warn('studio: IndexedDB unavailable, session will not persist', err);
      this.savedEl.textContent = 'Persistence unavailable';
      this.savedEl.classList.add('is-error');
    }
  }

  /** Debounced autosave of one take record. */
  private scheduleSave(take: StoredTake): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.savedEl.textContent = 'Saving...';
    this.savedEl.classList.remove('is-fresh', 'is-error');
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow(take);
    }, 450);
  }

  private async saveNow(take: StoredTake): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.saveTake(take);
      this.flashSaved('Saved');
    } catch (err) {
      console.warn('studio: take save failed', err);
      this.savedEl.textContent = 'Save failed';
      this.savedEl.classList.add('is-error');
    }
  }

  private flashSaved(text: string): void {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    this.savedEl.textContent = `${text} ${hh}:${mm}:${ss}`;
    this.savedEl.classList.add('is-fresh');
    this.savedEl.classList.remove('is-error');
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  private async bootCamera(): Promise<void> {
    try {
      const live = new LiveLandmarkSource();
      const filtered = new FilteredSource(live);
      filtered.onFrame((f) => this.onFrame(f));
      await filtered.start();
      this.live = live;
      this.filtered = filtered;
      const stream = live.mediaStream;
      if (stream) {
        this.liveVideo.srcObject = stream;
        void this.liveVideo.play().catch(() => undefined);
        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings();
        if (settings?.width) this.cameraW = settings.width;
        if (settings?.height) this.cameraH = settings.height;
      }
      this.cameraReady = true;
      this.stageMsgEl.textContent = '';
      this.stageMsgEl.style.display = 'none';
      this.renderControls();
    } catch (err) {
      console.warn('studio: camera failed to start', err);
      this.stageMsgEl.textContent =
        'The studio needs your camera. Allow camera access in the browser, then reload this page.';
    }
  }

  private onFrame(frame: LandmarkFrame): void {
    this.latestFrame = frame;
    this.latestFramePerf = performance.now();
    this.rateMeter.push(this.latestFramePerf);
    const signals = this.tracker.update(frame);

    if (this.mode !== 'recording') return;

    if (this.recOffset === null) {
      this.recOffset = frameClockOffset(this.recStartPerf, this.latestFramePerf, frame.t);
    }
    const videoMs = videoTimeOf(frame.t, this.recOffset);
    if (videoMs < 0) return;

    this.recFrames.push({
      t: videoMs,
      left: frame.left,
      right: frame.right,
      pose: frame.pose ?? null,
      signals,
    });
    const def = takeDef(this.selectedId);
    this.recSamples.push({ t: videoMs, v: primarySignalValue(signals, def.primary) });
    this.watchQuality(frame, videoMs);

    // Live rep counter: rescan with the same detector review uses.
    if (videoMs - this.lastRepScanMs > 400) {
      this.lastRepScanMs = videoMs;
      this.recRepCount = detectReps(this.recSamples).length;
    }
  }

  private watchQuality(frame: LandmarkFrame, videoMs: number): void {
    const push = (kind: StudioQualityEvent['kind']): void => {
      const last = this.lastQualityAt[kind] ?? -Infinity;
      if (videoMs - last < QUALITY_DEBOUNCE_MS) return;
      this.lastQualityAt[kind] = videoMs;
      this.recQuality.push({ tMs: videoMs, kind });
    };

    const ev = evaluateFraming({
      left: frame.left,
      right: frame.right,
      pose: frame.pose ?? null,
    });
    if (!ev.ok) push('framing');

    const pose = frame.pose ?? null;
    const dipped =
      (pose !== null && pose.confidence < 0.5) ||
      (frame.left !== null && frame.left.confidence < 0.5) ||
      (frame.right !== null && frame.right.confidence < 0.5);
    if (dipped) push('confidence');

    for (const side of ['left', 'right'] as const) {
      const hand = side === 'left' ? frame.left : frame.right;
      if (handPresent(hand)) {
        this.handSeen[side] = true;
        this.handLastPresent[side] = videoMs;
      } else if (
        this.handSeen[side] &&
        videoMs - this.handLastPresent[side] > HAND_LOST_MS
      ) {
        this.handSeen[side] = false;
        push('hand-lost');
      }
    }
  }

  /**
   * Capture-rate chip + hard-gate banner (~2Hz from the main loop). The
   * banner shows only while idle or recording: those are the modes where a
   * slow capture is actively producing (or about to produce) invalid data.
   */
  private renderRate(nowMs: number): void {
    const fps = this.cameraReady ? this.rateMeter.fpsAt(nowMs) : null;
    if (fps === null) {
      this.rateChipEl.textContent = 'capture -- fps';
      this.rateChipEl.classList.remove('is-low');
      this.rateBannerEl.classList.remove('is-visible');
      return;
    }
    const low = classifyRate(fps) === 'warn';
    this.rateChipEl.textContent = `capture ${fps.toFixed(1)} fps`;
    this.rateChipEl.classList.toggle('is-low', low);
    const gateActive = this.mode === 'idle' || this.mode === 'recording';
    if (low && gateActive) {
      this.rateBannerHeadEl.textContent = `Capture is running at ${fps.toFixed(1)} fps. 30 is required for usable data.`;
      this.rateBannerEl.classList.add('is-visible');
    } else {
      this.rateBannerEl.classList.remove('is-visible');
    }
  }

  /** True when a take measured under the capture gate. */
  private static isLowFps(take: StoredTake): boolean {
    return take.fps < RATE_GATE_FPS;
  }

  // -------------------------------------------------------------------------
  // Take selection and board
  // -------------------------------------------------------------------------

  private slotTakes(id: TakeId): StoredTake[] {
    return [...this.takes.values()]
      .filter((t) => t.id === id)
      .sort((a, b) => a.takeIndex - b.takeIndex);
  }

  private slotStatusLabel(id: TakeId): { label: string; cls: string } {
    const slot = this.slotTakes(id);
    if (slot.length === 0) return { label: 'Not recorded', cls: '' };
    if (slot.some((t) => t.status === 'confirmed')) {
      return { label: 'Confirmed', cls: 'is-confirmed' };
    }
    if (slot.every((t) => t.status === 'needs-redo')) {
      return { label: 'Needs redo', cls: 'is-redo' };
    }
    return { label: 'Recorded', cls: 'is-recorded' };
  }

  private selectTake(id: TakeId): void {
    if (this.mode === 'recording' || this.mode === 'countdown') return;
    this.selectedId = id;
    const slot = this.slotTakes(id);
    const best = slot.find((t) => t.starred) ?? slot[slot.length - 1];
    if (best) this.enterReview(best.key);
    else this.enterLive();
    this.renderCard();
    this.renderTakeList();
  }

  private renderTakeList(): void {
    // Rebuild rows (16 rows, cheap).
    const rows = this.takeListEl.querySelectorAll('.st-take-row');
    rows.forEach((r) => r.remove());
    for (const def of TAKES) {
      const row = el('button', 'st-take-row') as HTMLButtonElement;
      if (def.id === this.selectedId) row.classList.add('is-selected');
      const status = this.slotStatusLabel(def.id);
      const dotEl = el('span', 'st-take-dot');
      if (status.cls) dotEl.classList.add(status.cls);
      const nameEl = el('span', 'st-take-name');
      const n = el('span', 'n');
      n.textContent = def.name;
      const f = el('span', 'f');
      const slot = this.slotTakes(def.id);
      f.textContent =
        slot.length > 0 ? `${def.format} · ${slot.length} take${slot.length > 1 ? 's' : ''}` : def.format;
      nameEl.append(n, f);
      const st = el('span', 'st-take-status');
      st.textContent = status.label;
      // Capture hard gate: any take in the slot measured under the gate.
      if (slot.some((t) => StudioApp.isLowFps(t))) {
        const low = el('span', 'st-lowfps-badge');
        low.textContent = 'LOW FPS';
        st.append(low);
      }
      row.append(dotEl, nameEl, st);
      row.addEventListener('click', () => this.selectTake(def.id));
      this.takeListEl.appendChild(row);
    }
  }

  private renderProgress(): void {
    const slotsConfirmed = TAKES.filter((d) =>
      this.slotTakes(d.id).some((t) => t.status === 'confirmed'),
    ).length;
    let repsLabeled = 0;
    for (const t of this.takes.values()) {
      repsLabeled += t.reps.filter((r) => r.confirmed === true).length;
    }
    const negatives = TAKES.filter(
      (d) => d.negative && this.slotTakes(d.id).length > 0,
    ).length;
    this.progressEl.innerHTML =
      `<span>Takes confirmed <b>${slotsConfirmed} / 16</b></span>` +
      `<span>Reps labeled <b>${repsLabeled}</b></span>` +
      `<span>Negatives recorded <b>${negatives} / 3</b></span>`;
  }

  private renderCard(): void {
    const def = takeDef(this.selectedId);
    this.cardEl.replaceChildren();
    const move = el('h2', 'st-card-move');
    move.textContent = def.name;
    const format = el('p', 'st-card-format');
    format.textContent = def.format;
    this.cardEl.append(move, format, this.stickCanvas);
    this.stick.setAnim(def.anim, performance.now());

    const section = (heading: string, text: string, cls?: string): void => {
      const h = document.createElement('h3');
      h.textContent = heading;
      const p = document.createElement('p');
      if (cls) p.className = cls;
      p.textContent = text;
      this.cardEl.append(h, p);
    };
    section('How to do it', def.howTo);
    section('Pacing', def.pacing);
    section('Common mistakes', def.mistakes, 'st-card-mistakes');
    section('Review signal', def.primary.label);
  }

  // -------------------------------------------------------------------------
  // Modes
  // -------------------------------------------------------------------------

  private setMode(mode: Mode): void {
    this.mode = mode;
    const inReview = mode === 'review';
    this.liveVideo.style.display = inReview ? 'none' : 'block';
    this.reviewVideo.style.display = inReview ? 'block' : 'none';
    this.recordBtn.classList.toggle('is-recording', mode === 'recording');
    this.recChipEl.classList.toggle('is-on', mode === 'recording');
    this.modeChipEl.textContent =
      mode === 'review' ? 'REVIEW' : mode === 'recording' ? 'REC' : 'LIVE';
    this.renderControls();
  }

  private enterLive(): void {
    this.stopReviewPlayback();
    this.reviewKey = null;
    this.timeline.setTake(null);
    this.setMode('idle');
  }

  // -------------------------------------------------------------------------
  // Recording flow
  // -------------------------------------------------------------------------

  private toggleRecord(): void {
    if (this.mode === 'recording') {
      this.stopRecording();
    } else if (this.mode === 'countdown') {
      this.cancelCountdown();
    } else {
      this.startCountdown();
    }
  }

  private startCountdown(): void {
    if (!this.cameraReady || !this.live?.mediaStream) {
      this.stageMsgEl.style.display = 'flex';
      this.stageMsgEl.textContent =
        'Camera is not running yet. Allow camera access, then try again.';
      return;
    }
    this.stopReviewPlayback();
    this.reviewKey = null;
    this.timeline.setTake(null);
    this.setMode('countdown');
    this.countdownValue = 3;
    this.showCountdown('3');
    this.tickSound(660);
    this.countdownTimer = window.setInterval(() => {
      this.countdownValue--;
      if (this.countdownValue > 0) {
        this.showCountdown(String(this.countdownValue));
        this.tickSound(660);
      } else {
        this.cancelCountdownTimer();
        this.hideCountdown();
        this.tickSound(1040, 0.16);
        this.startRecording();
      }
    }, COUNTDOWN_STEP_MS);
  }

  private cancelCountdownTimer(): void {
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private cancelCountdown(): void {
    this.cancelCountdownTimer();
    this.hideCountdown();
    this.setMode('idle');
  }

  private showCountdown(text: string): void {
    this.hideCountdown();
    this.countEl = el('div', 'st-count');
    this.countEl.textContent = text;
    this.stageEl.appendChild(this.countEl);
  }

  private hideCountdown(): void {
    this.countEl?.remove();
    this.countEl = null;
  }

  private pickMime(): string {
    for (const m of MIME_CHAIN) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
        return m;
      }
    }
    return '';
  }

  private startRecording(): void {
    const stream = this.live?.mediaStream;
    if (!stream) return;
    const mime = this.pickMime();
    try {
      this.recorder = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined,
      );
    } catch (err) {
      console.warn('studio: MediaRecorder failed to start', err);
      this.setMode('idle');
      return;
    }
    this.recMime = this.recorder.mimeType || mime || 'video/webm';
    this.recChunks = [];
    this.recFrames = [];
    this.recSamples = [];
    this.recQuality = [];
    this.recRepCount = 0;
    this.lastRepScanMs = 0;
    this.lastQualityAt = {};
    this.handSeen = { left: false, right: false };
    this.handLastPresent = { left: 0, right: 0 };
    this.recOffset = null;
    // Fresh signal windows per take so the first frames are not polluted by
    // pre-roll motion.
    this.tracker.reset();
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recChunks.push(e.data);
    };
    this.recorder.onstop = () => this.finalizeRecording();
    // ONE SHARED CLOCK: recStartPerf anchors the video clock (clock.ts).
    this.recorder.start(250);
    this.recStartPerf = performance.now();
    if (this.liveVideo.videoWidth > 0) {
      this.cameraW = this.liveVideo.videoWidth;
      this.cameraH = this.liveVideo.videoHeight;
    }
    this.setMode('recording');
  }

  private stopRecording(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }

  private finalizeRecording(): void {
    const durationMs = Math.max(
      performance.now() - this.recStartPerf,
      this.recFrames.length > 0 ? (this.recFrames[this.recFrames.length - 1]?.t ?? 0) : 0,
    );
    const blob = new Blob(this.recChunks, { type: this.recMime });
    const id = this.selectedId;
    const slot = this.slotTakes(id);
    const takeIndex = slot.reduce((m, t) => Math.max(m, t.takeIndex), 0) + 1;
    const key = takeKey(id, takeIndex);
    const candidates = detectReps(this.recSamples);
    const reps: StoredRep[] = candidates.map((c) => ({
      startMs: c.startMs,
      endMs: c.endMs,
      confirmed: null,
      manual: false,
    }));
    // Phase 1 hard gate: stamp the take with its measured capture stats
    // (overall fps plus mean/min instantaneous fps over the frame gaps).
    const fpsStats = takeFpsStats(this.recFrames.map((f) => f.t));
    const stored: StoredTake = {
      key,
      id,
      takeIndex,
      starred: !slot.some((t) => t.starred),
      status: 'recorded',
      recordedAt: new Date().toISOString(),
      fps: durationMs > 0 ? (this.recFrames.length / durationMs) * 1000 : 0,
      fpsMean: fpsStats.meanFps,
      fpsMin: fpsStats.minFps,
      durationMs,
      cameraWidth: this.cameraW,
      cameraHeight: this.cameraH,
      frameClockOffset: this.recOffset ?? 0,
      thresholds: this.thresholds,
      trimmedRange: [0, durationMs],
      frames: this.recFrames,
      reps,
      quality: this.recQuality,
    };
    this.takes.set(key, stored);
    this.videoBlobs.set(key, { blob, mimeType: this.recMime });
    this.recorder = null;
    // Persist immediately: the take and its video never exist unsaved.
    if (this.db) {
      void this.db
        .saveVideo(key, blob, this.recMime)
        .then(() => this.saveNow(stored))
        .catch((err: unknown) => console.warn('studio: video save failed', err));
    }
    this.renderTakeList();
    this.renderProgress();
    this.enterReview(key);
  }

  // -------------------------------------------------------------------------
  // Review
  // -------------------------------------------------------------------------

  private currentTake(): StoredTake | null {
    return this.reviewKey !== null ? this.takes.get(this.reviewKey) ?? null : null;
  }

  private enterReview(key: string): void {
    const stored = this.takes.get(key);
    if (!stored) return;
    this.stopReviewPlayback();
    this.reviewKey = key;
    this.playheadMs = stored.trimmedRange[0];
    this.setMode('review');

    // Video blob: memory first, IndexedDB on refresh recovery.
    const mem = this.videoBlobs.get(key);
    if (mem) {
      this.setReviewVideo(mem.blob);
    } else if (this.db) {
      void this.db.loadVideo(key).then((rec) => {
        if (rec && this.reviewKey === key) {
          this.videoBlobs.set(key, { blob: rec.blob, mimeType: rec.mimeType });
          this.setReviewVideo(rec.blob);
        }
      });
    }

    const def = takeDef(stored.id);
    this.reviewSamples = stored.frames.map((f) => ({
      t: f.t,
      v: primarySignalValue(f.signals, def.primary),
    }));
    this.reviewThreshold =
      def.primary.thresholdKey !== null
        ? stored.thresholds[def.primary.thresholdKey]
        : def.primary.kind === 'palm-score'
          ? PALM_ACTIVE_LINE
          : null;
    this.pushTimeline();
    this.renderControls();
  }

  private setReviewVideo(blob: Blob): void {
    if (this.reviewUrl !== null) URL.revokeObjectURL(this.reviewUrl);
    this.reviewUrl = URL.createObjectURL(blob);
    this.reviewVideo.src = this.reviewUrl;
    this.reviewVideo.currentTime = this.playheadMs / 1000;
    this.armVideoFrameCallback();
  }

  /** Frame-accurate playhead sync via requestVideoFrameCallback when available. */
  private armVideoFrameCallback(): void {
    const video = this.reviewVideo;
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    if (this.rvfcHandle !== null) video.cancelVideoFrameCallback(this.rvfcHandle);
    const step = (): void => {
      if (this.mode === 'review') {
        this.playheadMs = video.currentTime * 1000;
        this.timeline.setPlayhead(this.playheadMs);
      }
      this.rvfcHandle = video.requestVideoFrameCallback(step);
    };
    this.rvfcHandle = video.requestVideoFrameCallback(step);
  }

  private stopReviewPlayback(): void {
    this.reviewVideo.pause();
    this.shuttle = 0;
    this.playRate = 1;
    if (this.rvfcHandle !== null && typeof this.reviewVideo.cancelVideoFrameCallback === 'function') {
      this.reviewVideo.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = null;
    }
  }

  private pushTimeline(): void {
    const stored = this.currentTake();
    if (!stored) {
      this.timeline.setTake(null);
      return;
    }
    this.timeline.setTake({
      durationMs: stored.durationMs,
      samples: this.reviewSamples,
      threshold: this.reviewThreshold,
      trim: stored.trimmedRange,
      reps: stored.reps,
      quality: stored.quality,
    });
    this.timeline.setPlayhead(this.playheadMs);
  }

  private seekTo(ms: number): void {
    const stored = this.currentTake();
    if (!stored) return;
    this.playheadMs = Math.min(Math.max(0, ms), stored.durationMs);
    this.reviewVideo.pause();
    this.shuttle = 0;
    this.reviewVideo.currentTime = this.playheadMs / 1000;
    this.timeline.setPlayhead(this.playheadMs);
  }

  private setTrim(range: [number, number]): void {
    const stored = this.currentTake();
    if (!stored) return;
    stored.trimmedRange = range;
    this.pushTimeline();
    this.scheduleSave(stored);
  }

  private toggleRep(index: number): void {
    const stored = this.currentTake();
    const rep = stored?.reps[index];
    if (!stored || !rep) return;
    // pending -> confirmed -> rejected -> pending
    rep.confirmed = rep.confirmed === null ? true : rep.confirmed === true ? false : null;
    this.pushTimeline();
    this.renderControls();
    this.renderProgress();
    this.scheduleSave(stored);
  }

  private dragRepBoundary(index: number, edge: 'start' | 'end', ms: number): void {
    const stored = this.currentTake();
    const rep = stored?.reps[index];
    if (!stored || !rep) return;
    if (edge === 'start') rep.startMs = Math.min(ms, rep.endMs - 60);
    else rep.endMs = Math.max(ms, rep.startMs + 60);
    this.pushTimeline();
    this.scheduleSave(stored);
  }

  private addManualRep(): void {
    const stored = this.currentTake();
    if (!stored) return;
    const rep: StoredRep = {
      startMs: Math.max(0, this.playheadMs - 250),
      endMs: Math.min(stored.durationMs, this.playheadMs + 250),
      confirmed: true,
      manual: true,
    };
    stored.reps.push(rep);
    stored.reps.sort((a, b) => a.startMs - b.startMs);
    this.pushTimeline();
    this.renderControls();
    this.renderProgress();
    this.scheduleSave(stored);
  }

  // -------------------------------------------------------------------------
  // Controls row
  // -------------------------------------------------------------------------

  private renderControls(): void {
    this.controlsEl.replaceChildren();
    const stored = this.currentTake();
    if (this.mode === 'recording') {
      const note = el('span', 'st-rep-count');
      note.textContent = 'Recording. Press space to stop.';
      this.controlsEl.appendChild(note);
      return;
    }
    if (!stored) {
      const note = el('span', 'st-rep-count');
      note.textContent = this.cameraReady
        ? 'Press space or the seal to record this take.'
        : 'Waiting for the camera.';
      this.controlsEl.appendChild(note);
      this.appendKeysHint();
      return;
    }

    const def = takeDef(stored.id);
    const btn = (
      label: string,
      onClick: () => void,
      cls = '',
      disabled = false,
    ): HTMLButtonElement => {
      const b = el('button', `st-btn${cls ? ` ${cls}` : ''}`) as HTMLButtonElement;
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener('click', onClick);
      this.controlsEl.appendChild(b);
      return b;
    };

    btn(this.reviewVideo.paused ? 'Play' : 'Pause', () => this.togglePlay());

    // Take cycling within the slot.
    const slot = this.slotTakes(stored.id);
    if (slot.length > 1) {
      const idx = slot.findIndex((t) => t.key === stored.key);
      btn('<', () => {
        const prev = slot[(idx - 1 + slot.length) % slot.length];
        if (prev) this.enterReview(prev.key);
      });
      const label = el('span', 'st-rep-count');
      label.textContent = `Take ${stored.takeIndex} of ${slot.length}`;
      label.style.marginLeft = '0';
      this.controlsEl.appendChild(label);
      btn('>', () => {
        const next = slot[(idx + 1) % slot.length];
        if (next) this.enterReview(next.key);
      });
    }

    btn(stored.starred ? 'Starred best' : 'Star best', () => this.starTake(stored), 'st-btn--gold', stored.starred);
    const lowFps = StudioApp.isLowFps(stored);
    const confirmBtn = btn(
      stored.status === 'confirmed' ? 'Confirmed' : 'Confirm take',
      () => this.setStatus(stored, 'confirmed'),
      'st-btn--gold',
      stored.status === 'confirmed',
    );
    // Confirming a low-fps take stays allowed (the user may want to test),
    // but the button carries the warning.
    if (lowFps) {
      confirmBtn.title = `This take measured ${stored.fps.toFixed(1)} fps, under the ${RATE_GATE_FPS} fps gate. Its numbers are not usable for tuning.`;
    }
    btn('Needs redo', () => this.setStatus(stored, 'needs-redo'), '', stored.status === 'needs-redo');
    btn('Re-record', () => this.startCountdown());
    btn('Delete', () => this.confirmDelete(stored), 'st-btn--danger');
    btn('Download webm', () => this.downloadWebm(stored));

    // The take's measured capture rate: the proof number for a real take.
    const fpsNote = el('span', 'st-fps-note');
    if (lowFps) fpsNote.classList.add('is-low');
    fpsNote.textContent =
      `capture ${stored.fps.toFixed(1)} fps` +
      (stored.fpsMin !== undefined ? `, min ${stored.fpsMin.toFixed(1)}` : '');
    if (lowFps) {
      const badge = el('span', 'st-lowfps-badge');
      badge.textContent = 'LOW FPS';
      fpsNote.append(badge);
    }
    this.controlsEl.appendChild(fpsNote);

    const repCount = el('span', 'st-rep-count');
    const confirmed = stored.reps.filter((r) => r.confirmed === true).length;
    const target = def.reps > 0 ? def.reps : stored.reps.filter((r) => r.confirmed !== false).length;
    repCount.innerHTML = def.negative
      ? `continuous take · <b>${Math.round(stored.durationMs / 1000)}s</b>`
      : `<b>${confirmed} of ${target}</b> reps confirmed`;
    this.controlsEl.appendChild(repCount);
    this.appendKeysHint();
  }

  private appendKeysHint(): void {
    const keys = el('div', 'st-keys');
    keys.textContent =
      'SPACE record/stop · J/K/L shuttle · LEFT/RIGHT step frames · M mark rep · click a rep band to confirm/reject · drag gold handles to trim';
    this.controlsEl.appendChild(keys);
  }

  private togglePlay(): void {
    if (this.mode !== 'review') return;
    this.shuttle = 0;
    if (this.reviewVideo.paused) {
      this.reviewVideo.playbackRate = this.playRate;
      void this.reviewVideo.play().catch(() => undefined);
    } else {
      this.reviewVideo.pause();
    }
    this.renderControls();
  }

  private starTake(take: StoredTake): void {
    for (const other of this.slotTakes(take.id)) {
      if (other.starred && other.key !== take.key) {
        other.starred = false;
        void this.saveNow(other);
      }
    }
    take.starred = true;
    this.scheduleSave(take);
    this.renderControls();
    this.renderTakeList();
  }

  private setStatus(take: StoredTake, status: 'confirmed' | 'needs-redo'): void {
    take.status = status;
    this.scheduleSave(take);
    this.renderControls();
    this.renderTakeList();
    this.renderProgress();
  }

  private confirmDelete(take: StoredTake): void {
    this.showModal((modal, close) => {
      const h = document.createElement('h2');
      h.textContent = 'Delete this take?';
      const p = document.createElement('p');
      p.textContent = `${takeDef(take.id).name}, take ${take.takeIndex}. The video and all its labels are removed. This cannot be undone.`;
      const actions = el('div', 'st-modal-actions');
      const cancel = el('button', 'st-btn') as HTMLButtonElement;
      cancel.textContent = 'Keep it';
      cancel.addEventListener('click', close);
      const del = el('button', 'st-btn st-btn--primary') as HTMLButtonElement;
      del.textContent = 'Delete take';
      del.addEventListener('click', () => {
        close();
        void this.deleteTake(take);
      });
      actions.append(cancel, del);
      modal.append(h, p, actions);
    });
  }

  private async deleteTake(take: StoredTake): Promise<void> {
    this.takes.delete(take.key);
    this.videoBlobs.delete(take.key);
    if (this.db) {
      try {
        await this.db.deleteTake(take.key);
      } catch (err) {
        console.warn('studio: delete failed', err);
      }
    }
    // A deleted starred take promotes the newest survivor.
    const slot = this.slotTakes(take.id);
    if (slot.length > 0 && !slot.some((t) => t.starred)) {
      const last = slot[slot.length - 1];
      if (last) {
        last.starred = true;
        void this.saveNow(last);
      }
    }
    this.renderTakeList();
    this.renderProgress();
    this.selectTake(take.id);
  }

  private downloadWebm(take: StoredTake): void {
    const mem = this.videoBlobs.get(take.key);
    const doDownload = (blob: Blob): void => {
      const [s, e] = take.trimmedRange;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${take.id}-take${take.takeIndex}-${Math.round(s)}ms-${Math.round(e)}ms.webm`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    if (mem) doDownload(mem.blob);
    else if (this.db) {
      void this.db.loadVideo(take.key).then((rec) => {
        if (rec) doDownload(rec.blob);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  private openExportModal(): void {
    const all = [...this.takes.values()].sort(
      (a, b) => a.id.localeCompare(b.id) || a.takeIndex - b.takeIndex,
    );
    const filename = exportFilename(new Date());
    this.showModal((modal, close) => {
      const h = document.createElement('h2');
      h.textContent = 'Export drill data';
      const summary = document.createElement('p');
      summary.className = 'st-export-summary';
      const slots = new Set(all.map((t) => t.id)).size;
      const reps = all.reduce(
        (n, t) => n + t.reps.filter((r) => r.confirmed === true).length,
        0,
      );
      summary.textContent =
        `${all.length} takes across ${slots} of 16 slots, ${reps} confirmed reps. ` +
        'Only the trimmed range of each take is exported.';

      const banner = el('div', 'st-banner');
      banner.textContent = EXPORT_DIR_TEXT;
      const fn = document.createElement('b');
      fn.textContent = filename;
      banner.appendChild(fn);

      const field = el('label', 'st-field');
      const span = document.createElement('span');
      span.textContent = 'Lighting note';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'e.g. evening, one desk lamp left of the camera';
      input.value = this.lightingNote;
      input.addEventListener('input', () => {
        this.lightingNote = input.value;
        if (this.db) void this.db.setSetting('lightingNote', input.value);
      });
      field.append(span, input);

      const actions = el('div', 'st-modal-actions');
      const cancel = el('button', 'st-btn') as HTMLButtonElement;
      cancel.textContent = 'Close';
      cancel.addEventListener('click', close);
      const doExport = el('button', 'st-btn st-btn--primary') as HTMLButtonElement;
      doExport.textContent = `Export ${filename}`;
      doExport.disabled = all.length === 0;
      doExport.addEventListener('click', () => {
        const data = buildExport({
          takes: all,
          lightingNote: this.lightingNote,
          cameraWidth: this.cameraW,
          cameraHeight: this.cameraH,
          motionProfile: loadProfile(),
          exportedAt: new Date().toISOString(),
        });
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      });
      actions.append(cancel, doExport);

      modal.append(h, summary, banner, field, actions);
    });
  }

  private showModal(build: (modal: HTMLElement, close: () => void) => void): void {
    const layer = el('div', 'st-modal-layer');
    const modal = el('div', 'st-modal');
    const close = (): void => layer.remove();
    layer.addEventListener('click', (e) => {
      if (e.target === layer) close();
    });
    build(modal, close);
    layer.appendChild(modal);
    document.body.appendChild(layer);
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        this.toggleRecord();
        break;
      case 'KeyJ':
        if (this.mode === 'review') {
          this.reviewVideo.pause();
          this.shuttle = this.shuttle < 0 ? Math.max(this.shuttle * 2, -4) : -1;
        }
        break;
      case 'KeyK':
        if (this.mode === 'review') {
          this.shuttle = 0;
          this.playRate = 1;
          this.reviewVideo.pause();
          this.renderControls();
        }
        break;
      case 'KeyL':
        if (this.mode === 'review') {
          if (this.shuttle < 0) this.shuttle = 0;
          if (this.reviewVideo.paused) {
            this.playRate = 1;
            this.reviewVideo.playbackRate = 1;
            void this.reviewVideo.play().catch(() => undefined);
          } else {
            this.playRate = Math.min(4, this.playRate * 2);
            this.reviewVideo.playbackRate = this.playRate;
          }
          this.renderControls();
        }
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (this.mode !== 'review') break;
        e.preventDefault();
        const stored = this.currentTake();
        if (!stored) break;
        const frameMs = stored.fps > 1 ? 1000 / stored.fps : 33.3;
        const stepMs = (e.shiftKey ? 10 : 1) * frameMs * (e.code === 'ArrowLeft' ? -1 : 1);
        this.seekTo(this.playheadMs + stepMs);
        break;
      }
      case 'KeyM':
        if (this.mode === 'review') this.addManualRep();
        break;
    }
  };

  // -------------------------------------------------------------------------
  // Audio ticks
  // -------------------------------------------------------------------------

  private tickSound(freq: number, durationSec = 0.07): void {
    try {
      this.audioCtx ??= new AudioContext();
      const ctx = this.audioCtx;
      void ctx.resume().catch(() => undefined);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.16, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSec);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + durationSec + 0.02);
    } catch {
      // No audio: the countdown numerals carry the timing alone.
    }
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  private lastLoopMs = 0;

  private loop = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const dtSec = this.lastLoopMs > 0 ? Math.min(0.1, (now - this.lastLoopMs) / 1000) : 0;
    this.lastLoopMs = now;

    // Instruction-card animation.
    this.stick.render(now);

    // Capture-rate chip + gate banner, ~2Hz.
    if (now - this.lastRateRenderMs > 500) {
      this.lastRateRenderMs = now;
      this.renderRate(now);
    }

    if (this.mode === 'review') {
      const stored = this.currentTake();
      // Reverse (J) shuttle: manual currentTime stepping.
      if (this.shuttle < 0 && stored) {
        const next = Math.max(0, this.reviewVideo.currentTime + this.shuttle * dtSec);
        this.reviewVideo.currentTime = next;
        if (next <= 0) this.shuttle = 0;
      }
      // Fallback playhead sync when rVFC is unavailable or video is paused.
      this.playheadMs = this.reviewVideo.currentTime * 1000;
      this.timeline.setPlayhead(this.playheadMs);
      if (stored) {
        const idx = nearestFrameIndex(
          stored.frames.map((f) => f.t),
          this.playheadMs,
        );
        const sf = idx >= 0 ? stored.frames[idx] : undefined;
        const frame: LandmarkFrame | null = sf
          ? { t: sf.t, left: sf.left, right: sf.right, face: null, pose: sf.pose }
          : null;
        this.overlay.render(frame, stored.cameraWidth, stored.cameraHeight, null);
      }
    } else {
      // Live overlay (idle/countdown/recording): skeletons plus, while
      // idle, the framing silhouette guide.
      const frame = this.latestFrame;
      const fresh = frame !== null && now - this.latestFramePerf < 500;
      const guide =
        this.mode === 'idle' && fresh && frame
          ? evaluateFraming({ left: frame.left, right: frame.right, pose: frame.pose ?? null })
          : null;
      const vw = this.liveVideo.videoWidth || this.cameraW;
      const vh = this.liveVideo.videoHeight || this.cameraH;
      this.overlay.render(fresh ? frame : null, vw, vh, guide);

      if (this.mode === 'recording') {
        const elapsed = (now - this.recStartPerf) / 1000;
        const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
        this.recTimeEl.textContent = `REC ${mm}:${ss}`;
        const def = takeDef(this.selectedId);
        this.recRepsEl.textContent = def.negative
          ? ''
          : `${this.recRepCount} rep${this.recRepCount === 1 ? '' : 's'}`;
      }
    }

    this.rafHandle = requestAnimationFrame(this.loop);
  };

  dispose(): void {
    this.disposed = true;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    window.removeEventListener('keydown', this.onKeyDown);
    this.cancelCountdownTimer();
    this.stopReviewPlayback();
    if (this.reviewUrl !== null) URL.revokeObjectURL(this.reviewUrl);
    this.filtered?.dispose();
    this.live?.stop();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
