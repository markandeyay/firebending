/**
 * Pure export assembly for the studio: StoredTake (the IndexedDB record
 * shape) -> StudioExport (the versioned contract in exportSchema.ts).
 * DOM-free and unit-tested; the app's export button only stringifies the
 * result and hands it to a download anchor.
 */

import type { MotionProfile, MotionThresholds } from '../gestures/profile';
import { trimByTime } from './clock';
import type {
  StudioExport,
  StudioFrame,
  StudioQualityEvent,
  StudioRep,
  StudioTakeExport,
  TakeId,
  TakeStatus,
} from './exportSchema';
import { median } from './peaks';

// ---------------------------------------------------------------------------
// Stored shapes (what the app keeps in IndexedDB per take)
// ---------------------------------------------------------------------------

/** A rep marker in review: confirmed true/false, or null while undecided. */
export interface StoredRep {
  startMs: number;
  endMs: number;
  /** null = pending, true = confirmed, false = rejected. */
  confirmed: boolean | null;
  manual: boolean;
}

export interface StoredTake {
  /** Primary key: `${id}#${takeIndex}`. */
  key: string;
  id: TakeId;
  takeIndex: number;
  starred: boolean;
  status: TakeStatus;
  recordedAt: string;
  fps: number;
  durationMs: number;
  cameraWidth: number;
  cameraHeight: number;
  frameClockOffset: number;
  thresholds: MotionThresholds;
  /** Kept range, video ms. */
  trimmedRange: [number, number];
  /** FULL untrimmed frames, t already in video ms, ascending. */
  frames: StudioFrame[];
  reps: StoredRep[];
  quality: StudioQualityEvent[];
}

export const takeKey = (id: TakeId, takeIndex: number): string => `${id}#${takeIndex}`;

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * One exported take: frames, reps and quality events filtered to the
 * trimmed range. Rejected reps are dropped; pending reps export with
 * confirmed false. Never mutates the stored take.
 */
export function buildTakeExport(stored: StoredTake): StudioTakeExport {
  const [start, end] = stored.trimmedRange;
  const frames = trimByTime(stored.frames, start, end);
  const reps: StudioRep[] = stored.reps
    .filter((r) => r.confirmed !== false)
    .filter((r) => r.endMs >= start && r.startMs <= end)
    .map((r) => ({
      startMs: Math.max(r.startMs, start),
      endMs: Math.min(r.endMs, end),
      confirmed: r.confirmed === true,
      manual: r.manual,
    }));
  const quality = stored.quality.filter((q) => q.tMs >= start && q.tMs <= end);
  return {
    id: stored.id,
    takeIndex: stored.takeIndex,
    starred: stored.starred,
    status: stored.status,
    fps: stored.fps,
    trimmedRange: [start, end],
    thresholds: stored.thresholds,
    frameClockOffset: stored.frameClockOffset,
    frames,
    reps,
    quality,
  };
}

/**
 * Median shoulder width over every pose-carrying exported frame across the
 * given takes (normalized units); the export's distance estimate.
 */
export function medianShoulderWidth(takes: readonly StudioTakeExport[]): number {
  const widths: number[] = [];
  for (const take of takes) {
    for (const f of take.frames) {
      if (f.signals.body.present) widths.push(f.signals.body.shoulderWidth);
    }
  }
  return median(widths);
}

/** Human-readable framing/quality summary across the exported takes. */
export function framingSummaryOf(takes: readonly StudioTakeExport[]): string {
  let events = 0;
  let framing = 0;
  let confidence = 0;
  let lost = 0;
  for (const take of takes) {
    for (const q of take.quality) {
      events++;
      if (q.kind === 'framing') framing++;
      else if (q.kind === 'confidence') confidence++;
      else lost++;
    }
  }
  if (events === 0) return 'No framing or tracking warnings across exported takes.';
  return (
    `${events} quality warnings across exported takes: ` +
    `${framing} framing, ${confidence} confidence dips, ${lost} hand losses.`
  );
}

export interface BuildExportOptions {
  takes: readonly StoredTake[];
  lightingNote: string;
  cameraWidth: number;
  cameraHeight: number;
  motionProfile: MotionProfile | null;
  /** ISO timestamp; injectable for deterministic tests. */
  exportedAt: string;
}

/** Assemble the full export envelope. Pure. */
export function buildExport(opts: BuildExportOptions): StudioExport {
  const takes = opts.takes.map(buildTakeExport);
  return {
    version: 1,
    exportedAt: opts.exportedAt,
    meta: {
      cameraWidth: opts.cameraWidth,
      cameraHeight: opts.cameraHeight,
      distanceEstimate: medianShoulderWidth(takes),
      lightingNote: opts.lightingNote,
      framingSummary: framingSummaryOf(takes),
      motionProfile: opts.motionProfile,
    },
    takes,
  };
}

/** Export filename for a given date: firebending-drill-<yyyy-mm-dd>.json. */
export function exportFilename(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `firebending-drill-${y}-${m}-${d}.json`;
}
