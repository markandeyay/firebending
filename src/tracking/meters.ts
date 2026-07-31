/**
 * Rate and latency instrumentation primitives (quality round Phase 1).
 *
 * PercentileRing: a fixed-capacity ring buffer of numeric samples with EXACT
 * p50/p95 over the current window (sort-on-demand with a dirty flag, so a
 * burst of pushes costs O(1) each and the sort runs only when a percentile
 * is actually read, e.g. at the debug HUD's ~10 Hz refresh).
 *
 * RateMeter: feed it event timestamps (ms); it converts consecutive deltas
 * into instantaneous Hz samples and windows them. Used for cameraHz (rvfc
 * cadence), handHz (fresh hand-worker results = emission rate), poseHz and
 * renderHz.
 *
 * LatencyMeter: feed it millisecond latencies directly (photon-to-emit,
 * photon-to-fire).
 *
 * All pure and headless-testable; no DOM, no timers of their own.
 */

/** Default sliding-window size, samples (~8 s of 30 Hz data). */
export const METER_WINDOW = 240;

export interface Percentiles {
  p50: number;
  p95: number;
  /** Samples currently in the window (0 means p50/p95 are meaningless). */
  count: number;
}

/** Fixed-capacity ring of samples with exact percentiles over the window. */
export class PercentileRing {
  private readonly values: number[] = [];
  private cursor = 0;
  private readonly sorted: number[] = [];
  private dirty = true;

  constructor(private readonly capacity: number = METER_WINDOW) {}

  push(v: number): void {
    if (this.values.length < this.capacity) {
      this.values.push(v);
    } else {
      this.values[this.cursor] = v;
      this.cursor = (this.cursor + 1) % this.capacity;
    }
    this.dirty = true;
  }

  get count(): number {
    return this.values.length;
  }

  /** Exact linear-interpolated quantile over the current window; 0 when empty. */
  quantile(q: number): number {
    const n = this.values.length;
    if (n === 0) return 0;
    if (this.dirty) {
      this.sorted.length = 0;
      for (const v of this.values) this.sorted.push(v);
      this.sorted.sort((a, b) => a - b);
      this.dirty = false;
    }
    const clamped = Math.min(1, Math.max(0, q));
    const pos = (n - 1) * clamped;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const a = this.sorted[lo] ?? 0;
    const b = this.sorted[hi] ?? a;
    return a + (b - a) * (pos - lo);
  }

  percentiles(): Percentiles {
    return { p50: this.quantile(0.5), p95: this.quantile(0.95), count: this.count };
  }

  reset(): void {
    this.values.length = 0;
    this.sorted.length = 0;
    this.cursor = 0;
    this.dirty = true;
  }
}

/**
 * Event-rate meter: push the timestamp (ms) of each occurrence; consecutive
 * deltas become instantaneous Hz samples in the window. Non-positive deltas
 * (duplicate or reordered timestamps) are discarded rather than poisoning
 * the window with Infinity.
 */
export class RateMeter {
  private readonly ring: PercentileRing;
  private lastT: number | null = null;

  constructor(capacity: number = METER_WINDOW) {
    this.ring = new PercentileRing(capacity);
  }

  push(tMs: number): void {
    if (this.lastT !== null) {
      const dt = tMs - this.lastT;
      if (dt > 0) this.ring.push(1000 / dt);
    }
    this.lastT = tMs;
  }

  get hz(): Percentiles {
    return this.ring.percentiles();
  }

  reset(): void {
    this.ring.reset();
    this.lastT = null;
  }
}

/** Latency meter: push millisecond latencies directly. */
export class LatencyMeter {
  private readonly ring: PercentileRing;

  constructor(capacity: number = METER_WINDOW) {
    this.ring = new PercentileRing(capacity);
  }

  push(ms: number): void {
    if (Number.isFinite(ms)) this.ring.push(ms);
  }

  get ms(): Percentiles {
    return this.ring.percentiles();
  }

  reset(): void {
    this.ring.reset();
  }
}
