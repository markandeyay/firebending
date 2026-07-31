/**
 * Shared-clock math for the recording studio: mapping between the tracking
 * source's FRAME clock (LandmarkFrame.t, ms since the source started) and
 * each take's VIDEO clock (ms since MediaRecorder.start()). ALL pure
 * functions, unit-tested in tests/studio.test.ts.
 *
 * MAPPING: the studio captures performance.now() the instant MediaRecorder
 * starts (recStartPerfMs). Any frame observed at performance.now() =
 * framePerfMs with frame time frameT pins the source-start epoch at
 * framePerfMs - frameT, so
 *
 *   offset       = (framePerfMs - frameT) - recStartPerfMs
 *   videoMs      = frameT + offset
 *   frameT       = videoMs - offset
 *
 * Trimming operates purely in video ms; because the mapping is a single
 * shared offset, trimming the video trims EXACTLY the corresponding frames.
 */

/**
 * The take's frameClockOffset: add it to a frame-clock time to get video
 * time. Derived from one observation (framePerfMs, frameT) of the frame
 * clock against performance.now(), plus the perf time of recorder start.
 */
export function frameClockOffset(
  recStartPerfMs: number,
  framePerfMs: number,
  frameT: number,
): number {
  return framePerfMs - frameT - recStartPerfMs;
}

/** Frame clock -> video clock. */
export function videoTimeOf(frameT: number, offsetMs: number): number {
  return frameT + offsetMs;
}

/** Video clock -> frame clock. */
export function frameTimeOf(videoMs: number, offsetMs: number): number {
  return videoMs - offsetMs;
}

/**
 * Clamp a candidate trim range into [0, durationMs], swapping ends when
 * reversed and enforcing a minimum kept span so a degenerate drag can never
 * produce an empty (or negative) take.
 */
export function clampTrimRange(
  start: number,
  end: number,
  durationMs: number,
  minSpanMs = 100,
): [number, number] {
  let a = Math.min(start, end);
  let b = Math.max(start, end);
  a = Math.min(Math.max(0, a), Math.max(0, durationMs));
  b = Math.min(Math.max(0, b), Math.max(0, durationMs));
  if (b - a < minSpanMs) {
    b = Math.min(durationMs, a + minSpanMs);
    a = Math.max(0, b - minSpanMs);
  }
  return [a, b];
}

/**
 * Filter time-carrying records to a video-time range [startMs, endMs]
 * inclusive. `t` values must already be video ms. Order is preserved; the
 * input is never mutated.
 */
export function trimByTime<T extends { t: number }>(
  items: readonly T[],
  startMs: number,
  endMs: number,
): T[] {
  return items.filter((it) => it.t >= startMs && it.t <= endMs);
}

/**
 * Index range [lo, hi) of frame times (video ms, ascending) inside
 * [startMs, endMs] inclusive. Binary search on both ends; O(log n).
 */
export function trimIndexRange(
  times: readonly number[],
  startMs: number,
  endMs: number,
): [number, number] {
  const lo = lowerBound(times, startMs);
  const hi = upperBound(times, endMs);
  return [lo, Math.max(lo, hi)];
}

/** First index whose value is >= target. */
export function lowerBound(times: readonly number[], target: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] ?? Infinity) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is > target. */
export function upperBound(times: readonly number[], target: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] ?? Infinity) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Index of the frame (in an ascending video-ms array) closest to videoMs;
 * -1 for an empty array. Frame-accurate scrubbing uses this to pair the
 * displayed video frame with its landmark frame.
 */
export function nearestFrameIndex(times: readonly number[], videoMs: number): number {
  if (times.length === 0) return -1;
  const i = lowerBound(times, videoMs);
  if (i <= 0) return 0;
  if (i >= times.length) return times.length - 1;
  const before = times[i - 1] ?? 0;
  const after = times[i] ?? 0;
  return videoMs - before <= after - videoMs ? i - 1 : i;
}
