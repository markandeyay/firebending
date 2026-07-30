/**
 * One Euro spike response and rest-jitter characterization (the beta retune).
 *
 * A 30 fps wrist doing a 3-frame punch spike (raw windowed speed ~1.8 u/s,
 * instantaneous 3 u/s) is pushed through HandFilterBank; the windowed-speed
 * attenuation (1 - filteredPeak / rawPeak) is what the move layer feels. The
 * legacy tuning (beta 0.007, dCutoff 1.0) was pixel-scale: in normalized
 * coordinates the punch derivative (~3 units/sec) barely raised the adaptive
 * cutoff, attenuating the spike ~44% and forcing REPLAY_VELOCITY_SCALE 1.8.
 * The retuned ONE_EURO_DEFAULTS (beta 4.0, dCutoff 4.0) must keep spike
 * attenuation at or below 15% while rest jitter stays below 2x the legacy
 * tuning's filtered jitter.
 *
 * All numbers are printed so tuning changes surface in the test output.
 */

import { describe, expect, it } from 'vitest';
import {
  HandFilterBank,
  ONE_EURO_DEFAULTS,
  type OneEuroOptions,
} from '../src/tracking/filters';
import { handSpeed } from '../src/gestures/poses';
import { mulberry32, gaussian } from '../fixtures/lib';
import type { HandFrame } from '../src/tracking/types';
import { HAND_LANDMARK_COUNT, LM } from '../src/tracking/types';

const FPS = 30;
const FRAME_SEC = 1 / FPS;
const WINDOW = 6; // AIM_WINDOW_FRAMES, the window the move layer uses

/** The legacy spec Section 5 tuning, kept here as the comparison baseline. */
const LEGACY: Required<OneEuroOptions> = { minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 };

/** Retune gates. */
const MAX_SPIKE_ATTENUATION = 0.15;
const MAX_REST_JITTER_RATIO = 2.0;

function makeHand(wristX: number): HandFrame {
  const landmarks = Array.from({ length: HAND_LANDMARK_COUNT }, (_, i) => ({
    x: wristX + i * 0.01,
    y: 0.5 - i * 0.005,
    z: -0.02,
  }));
  return { landmarks, confidence: 0.95 };
}

/** 3-frame punch: rest, then +0.1 units per frame for 3 frames, then hold. */
function spikeFrames(): HandFrame[] {
  const frames: HandFrame[] = [];
  let x = 0.4;
  for (let i = 0; i < 40; i++) {
    if (i >= 20 && i < 23) x += 0.1; // 3.0 u/s instantaneous
    frames.push(makeHand(x));
  }
  return frames;
}

/** Peak windowed wrist speed of a frame sequence, optionally filtered. */
function peakWindowedSpeed(frames: HandFrame[], options?: OneEuroOptions): number {
  const bank = options ? new HandFilterBank(options) : null;
  const win: HandFrame[] = [];
  let peak = 0;
  for (let i = 0; i < frames.length; i++) {
    let hand = frames[i];
    if (!hand) continue;
    if (bank) hand = bank.filter(hand, i * FRAME_SEC);
    win.push(hand);
    if (win.length > WINDOW) win.shift();
    peak = Math.max(peak, handSpeed(win, FRAME_SEC).speed);
  }
  return peak;
}

/** Gaussian rest jitter, sigma 0.004 normalized, deterministic PRNG. */
function jitterFrames(): HandFrame[] {
  const rng = mulberry32(1234);
  const frames: HandFrame[] = [];
  for (let i = 0; i < 150; i++) {
    const landmarks = Array.from({ length: HAND_LANDMARK_COUNT }, (_, k) => ({
      x: 0.5 + k * 0.01 + gaussian(rng) * 0.004,
      y: 0.5 - k * 0.005 + gaussian(rng) * 0.004,
      z: -0.02 + gaussian(rng) * 0.004,
    }));
    frames.push({ landmarks, confidence: 0.95 });
  }
  return frames;
}

/** RMS deviation of the filtered wrist x from its nominal rest position. */
function restJitterRms(frames: HandFrame[], options: OneEuroOptions): number {
  const bank = new HandFilterBank(options);
  const xs: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const hand = frames[i];
    if (!hand) continue;
    const filtered = bank.filter(hand, i * FRAME_SEC);
    const wrist = filtered.landmarks[LM.WRIST];
    if (!wrist) throw new Error('missing wrist');
    if (i >= 30) xs.push(wrist.x - 0.5); // skip filter settling
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, v) => a + (v - mean) * (v - mean), 0) / xs.length);
}

describe('One Euro punch spike response', () => {
  const frames = spikeFrames();
  const rawPeak = peakWindowedSpeed(frames);
  const legacyPeak = peakWindowedSpeed(frames, LEGACY);
  const tunedPeak = peakWindowedSpeed(frames, ONE_EURO_DEFAULTS);
  const legacyAttenuation = 1 - legacyPeak / rawPeak;
  const tunedAttenuation = 1 - tunedPeak / rawPeak;

  it('the raw 3-frame spike reaches a punch-class windowed speed', () => {
    expect(rawPeak).toBeGreaterThan(1.5);
  });

  it('the retuned defaults attenuate the spike by at most 15%', () => {
    // eslint-disable-next-line no-console
    console.log(
      `spike windowed speed: raw ${rawPeak.toFixed(3)} u/s | ` +
        `legacy(beta ${LEGACY.beta}, dCutoff ${LEGACY.dCutoff}) ${legacyPeak.toFixed(3)} ` +
        `(${(legacyAttenuation * 100).toFixed(1)}% attenuation) | ` +
        `tuned(beta ${ONE_EURO_DEFAULTS.beta}, dCutoff ${ONE_EURO_DEFAULTS.dCutoff}) ` +
        `${tunedPeak.toFixed(3)} (${(tunedAttenuation * 100).toFixed(1)}% attenuation)`,
    );
    expect(tunedAttenuation).toBeLessThanOrEqual(MAX_SPIKE_ATTENUATION);
  });

  it('documents why the legacy tuning needed velocity compensation', () => {
    // The legacy tuning loses a large fraction of the spike; this is the
    // measured basis for the old REPLAY_VELOCITY_SCALE 1.8. If this ever
    // stops holding, revisit the movesDebug.ts comment.
    expect(legacyAttenuation).toBeGreaterThan(0.3);
  });
});

describe('One Euro rest jitter after the retune', () => {
  it('filtered rest jitter stays below 2x the legacy tuning', () => {
    const frames = jitterFrames();
    const legacyRms = restJitterRms(frames, LEGACY);
    const tunedRms = restJitterRms(frames, ONE_EURO_DEFAULTS);
    // eslint-disable-next-line no-console
    console.log(
      `rest jitter RMS (sigma 0.004): legacy ${legacyRms.toFixed(5)} | ` +
        `tuned ${tunedRms.toFixed(5)} (${(tunedRms / legacyRms).toFixed(2)}x)`,
    );
    expect(tunedRms).toBeLessThan(MAX_REST_JITTER_RATIO * legacyRms);
    // And it still smooths: filtered jitter well below the raw sigma.
    expect(tunedRms).toBeLessThan(0.004);
  });
});
