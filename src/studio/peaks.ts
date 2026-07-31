/**
 * Auto rep-candidate detection over a take's primary signal: classic peak
 * picking with a prominence floor RELATIVE TO THE TAKE MEDIAN and a minimum
 * peak spacing. Pure and DOM-free; the same code drives the live rep counter
 * during recording and the review timeline's candidate markers.
 *
 * ALGORITHM:
 * 1. Local maxima (strictly greater than the previous sample, >= the next,
 *    so flat-topped peaks register once at their left edge).
 * 2. Prominence per maximum: the peak value minus the higher of the two
 *    valley minima walking outward until a taller sample (or the ends).
 * 3. Keep maxima whose prominence >= max(PROMINENCE_MEDIAN_MULT * median,
 *    PROMINENCE_MAX_FRACTION * globalMax). The median term adapts to the
 *    take's noise floor; the max-fraction term keeps a near-zero median
 *    (clean idle between reps) from admitting every wiggle.
 * 4. Greedy spacing: accept peaks tallest-first, discarding any within
 *    MIN_PEAK_SPACING_MS of an accepted one.
 * 5. Boundaries: from each accepted peak walk both ways until the signal
 *    falls below median + BOUNDARY_FRACTION * (peak - median), capped at
 *    the midpoint toward the neighboring accepted peak.
 */

export interface SignalSample {
  /** Video ms. */
  t: number;
  v: number;
}

export interface RepCandidate {
  /** Peak time, video ms. */
  peakMs: number;
  peakValue: number;
  startMs: number;
  endMs: number;
}

/** Two candidate peaks closer than this merge into one (the taller wins). */
export const MIN_PEAK_SPACING_MS = 600;
/** Prominence floor as a multiple of the take median. */
export const PROMINENCE_MEDIAN_MULT = 2.0;
/** Prominence floor as a fraction of the take's global maximum. */
export const PROMINENCE_MAX_FRACTION = 0.25;
/** Rep boundary: where the signal falls to this fraction of (peak - median). */
export const BOUNDARY_FRACTION = 0.15;

/** Median of a numeric array (0 for empty). Does not mutate the input. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Prominence of the local maximum at index i (classic definition). */
export function prominenceAt(values: readonly number[], i: number): number {
  const peak = values[i] ?? 0;
  let leftMin = peak;
  for (let j = i - 1; j >= 0; j--) {
    const v = values[j] ?? 0;
    if (v > peak) break;
    if (v < leftMin) leftMin = v;
  }
  let rightMin = peak;
  for (let j = i + 1; j < values.length; j++) {
    const v = values[j] ?? 0;
    if (v > peak) break;
    if (v < rightMin) rightMin = v;
  }
  return peak - Math.max(leftMin, rightMin);
}

/**
 * Detect rep candidates over (t ascending) samples. Deterministic; returns
 * candidates sorted by time. Fewer than 3 samples yields none.
 */
export function detectReps(
  samples: readonly SignalSample[],
  minSpacingMs: number = MIN_PEAK_SPACING_MS,
): RepCandidate[] {
  if (samples.length < 3) return [];
  const values = samples.map((s) => s.v);
  const med = median(values);
  let globalMax = -Infinity;
  for (const v of values) if (v > globalMax) globalMax = v;
  if (!(globalMax > 0)) return [];
  const minProminence = Math.max(
    PROMINENCE_MEDIAN_MULT * med,
    PROMINENCE_MAX_FRACTION * globalMax,
  );

  // 1+2+3: qualifying local maxima.
  const maxima: number[] = [];
  for (let i = 1; i < values.length - 1; i++) {
    const prev = values[i - 1] ?? 0;
    const cur = values[i] ?? 0;
    const next = values[i + 1] ?? 0;
    if (cur > prev && cur >= next && prominenceAt(values, i) >= minProminence) {
      maxima.push(i);
    }
  }

  // 4: greedy spacing, tallest first.
  const byHeight = [...maxima].sort((a, b) => (values[b] ?? 0) - (values[a] ?? 0));
  const accepted: number[] = [];
  for (const i of byHeight) {
    const t = samples[i]?.t ?? 0;
    if (accepted.some((j) => Math.abs((samples[j]?.t ?? 0) - t) < minSpacingMs)) {
      continue;
    }
    accepted.push(i);
  }
  accepted.sort((a, b) => a - b);

  // 5: boundaries.
  const out: RepCandidate[] = [];
  for (let k = 0; k < accepted.length; k++) {
    const i = accepted[k] ?? 0;
    const peak = values[i] ?? 0;
    const floor = med + BOUNDARY_FRACTION * (peak - med);
    const prevPeakI = k > 0 ? (accepted[k - 1] ?? -1) : -1;
    const nextPeakI = k < accepted.length - 1 ? (accepted[k + 1] ?? -1) : -1;

    let lo = i;
    while (lo > 0 && (values[lo - 1] ?? 0) > floor) lo--;
    let hi = i;
    while (hi < values.length - 1 && (values[hi + 1] ?? 0) > floor) hi++;

    let startMs = samples[lo]?.t ?? 0;
    let endMs = samples[hi]?.t ?? 0;
    const peakMs = samples[i]?.t ?? 0;
    if (prevPeakI >= 0) {
      const midpoint = ((samples[prevPeakI]?.t ?? 0) + peakMs) / 2;
      if (startMs < midpoint) startMs = midpoint;
    }
    if (nextPeakI >= 0) {
      const midpoint = (peakMs + (samples[nextPeakI]?.t ?? 0)) / 2;
      if (endMs > midpoint) endMs = midpoint;
    }
    out.push({ peakMs, peakValue: peak, startMs, endMs });
  }
  return out;
}
