/**
 * LATEST-FRAME-WINS backpressure channel (quality round Phase 1).
 *
 * The hand worker must never build a queue: queued frames would add latency
 * that compounds forever on a machine slower than the camera. The rule:
 * at most ONE item in flight; while busy, at most ONE pending item, and a
 * newer offer REPLACES the pending one (the stale item is dropped through
 * onDrop so resources like ImageBitmaps can be closed). When the in-flight
 * item settles, the pending item (the newest capture) is sent immediately.
 *
 * Latency is therefore bounded by one worker round-trip plus one capture,
 * and the achieved send rate self-regulates to what the consumer sustains.
 *
 * Pure bookkeeping, no timers, no DOM: unit-tested with a scripted fake
 * worker in tests/latestWins.test.ts.
 */

export class LatestWinsChannel<T> {
  private inFlight = false;
  private pending: T | null = null;

  constructor(
    private readonly send: (item: T) => void,
    private readonly onDrop?: (item: T) => void,
  ) {}

  /** True while an item is awaiting its settle(). */
  get busy(): boolean {
    return this.inFlight;
  }

  /** True when a newer capture is parked behind the in-flight one. */
  get hasPending(): boolean {
    return this.pending !== null;
  }

  /**
   * Offer a new item. Sends immediately when idle; otherwise parks it as
   * the pending item, dropping (and onDrop-ing) any previously parked one.
   */
  offer(item: T): void {
    if (!this.inFlight) {
      this.inFlight = true;
      this.send(item);
      return;
    }
    if (this.pending !== null) this.onDrop?.(this.pending);
    this.pending = item;
  }

  /**
   * The in-flight item finished (worker answered or failed). Sends the
   * pending item if one is parked (staying busy), otherwise goes idle.
   */
  settle(): void {
    if (!this.inFlight) return;
    if (this.pending !== null) {
      const next = this.pending;
      this.pending = null;
      this.send(next);
      return;
    }
    this.inFlight = false;
  }

  /** Drop everything (stop()): the pending item is onDrop-ed, state clears.
   * A worker answer arriving after reset() must not be settle()-d by the
   * caller (the caller checks its own running flag first). */
  reset(): void {
    if (this.pending !== null) {
      this.onDrop?.(this.pending);
      this.pending = null;
    }
    this.inFlight = false;
  }
}
