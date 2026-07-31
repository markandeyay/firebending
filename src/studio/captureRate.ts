/**
 * Capture-rate measurement and the Phase 1 capture hard gate for the
 * recording studio. Pure and DOM-free; unit-tested in
 * tests/captureRate.test.ts.
 *
 * WHY THIS EXISTS: the first real drill recordings arrived at ~14 fps,
 * which invalidated every jab-family number (a 120 ms jab spans fewer than
 * 2 samples at 14 fps). The rule since then: under 30 fps of landmark
 * capture, every downstream number derived from a take is invalid for
 * tuning. The studio measures the live arrival rate, stamps every take
 * with its measured rate, and the analyze tool refuses to treat low-rate
 * takes as tunable evidence.
 */

/**
 * The required landmark capture rate. Takes measured under this are
 * invalid for tuning (the analyze tool's hard gate).
 */
export const TARGET_CAPTURE_FPS = 30;

/**
 * The live/studio gate. The TARGET is 30 fps; the gate sits at 28 to
 * absorb normal requestVideoFrameCallback scheduling jitter: a healthy
 * 30 Hz camera measures 29.x over a rolling window, and flagging that as
 * a failure would train the user to ignore the warning. Anything below
 * 28 is a real capture-rate problem, not jitter.
 */
export const RATE_GATE_FPS = 28;

/** How many recent frame arrivals the rolling live meter spans. */
export const RATE_WINDOW = 60;

export type RateClass = 'good' | 'warn';

/** Gate classification: at or above RATE_GATE_FPS is good, below warns. */
export function classifyRate(fps: number): RateClass {
  return fps >= RATE_GATE_FPS ? 'good' : 'warn';
}

/**
 * Rolling arrival-rate meter: push a timestamp (performance.now() ms) per
 * landmark-frame arrival; fps is measured over the retained window (last
 * RATE_WINDOW arrivals). `fpsAt(now)` extends the window to `now` so a
 * stalled stream reads LOW instead of freezing at its last healthy value.
 */
export class RollingRateMeter {
  private readonly times: number[] = [];

  constructor(private readonly windowSize: number = RATE_WINDOW) {}

  push(tMs: number): void {
    this.times.push(tMs);
    if (this.times.length > this.windowSize) this.times.shift();
  }

  /** Arrivals currently retained. */
  count(): number {
    return this.times.length;
  }

  /** fps over the retained window; null until two arrivals exist. */
  fps(): number | null {
    const n = this.times.length;
    if (n < 2) return null;
    const span = (this.times[n - 1] ?? 0) - (this.times[0] ?? 0);
    if (span <= 0) return null;
    return ((n - 1) * 1000) / span;
  }

  /**
   * fps with the window extended to nowMs when the stream has stalled
   * past its last arrival. Slightly conservative during a stall (the open
   * interval is counted in time but not as an arrival), which is the
   * honest direction for a gate.
   */
  fpsAt(nowMs: number): number | null {
    const n = this.times.length;
    if (n < 2) return null;
    const first = this.times[0] ?? 0;
    const last = this.times[n - 1] ?? 0;
    const span = Math.max(last, nowMs) - first;
    if (span <= 0) return null;
    return ((n - 1) * 1000) / span;
  }

  reset(): void {
    this.times.length = 0;
  }
}

/** Mean/min instantaneous fps over one take's landmark frames. */
export interface TakeFpsStats {
  meanFps: number;
  minFps: number;
}

/**
 * Per-take fps statistics from frame times (video ms, ascending): the
 * instantaneous rate of every frame gap (1000/dt), reduced to mean and
 * min. Fewer than two frames (no gaps) yields zeros. Non-positive gaps
 * (duplicate timestamps) are skipped rather than poisoning the stats.
 */
export function takeFpsStats(frameTimes: readonly number[]): TakeFpsStats {
  let sum = 0;
  let min = Infinity;
  let count = 0;
  for (let i = 1; i < frameTimes.length; i++) {
    const dt = (frameTimes[i] ?? 0) - (frameTimes[i - 1] ?? 0);
    if (dt <= 0) continue;
    const rate = 1000 / dt;
    sum += rate;
    if (rate < min) min = rate;
    count++;
  }
  if (count === 0) return { meanFps: 0, minFps: 0 };
  return { meanFps: sum / count, minFps: min };
}

/**
 * Export-level capture-health summary across takes (each value is one
 * take's measured fps, frames/duration).
 */
export interface CaptureHealth {
  /** Lowest per-take measured fps. */
  minFps: number;
  /** Median per-take measured fps. */
  medianFps: number;
  /** Takes measured under RATE_GATE_FPS. */
  takesUnderGate: number;
}

/** Median of a numeric array (0 for empty). Does not mutate the input. */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Summarize per-take measured fps values into a CaptureHealth. */
export function captureHealthOf(takeFps: readonly number[]): CaptureHealth {
  if (takeFps.length === 0) return { minFps: 0, medianFps: 0, takesUnderGate: 0 };
  let min = Infinity;
  let under = 0;
  for (const f of takeFps) {
    if (f < min) min = f;
    if (f < RATE_GATE_FPS) under++;
  }
  return { minFps: min, medianFps: medianOf(takeFps), takesUnderGate: under };
}
