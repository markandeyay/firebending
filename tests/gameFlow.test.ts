/**
 * T062 game flow tests, all headless:
 *   - routeFor: every URL entry point and the precedence rules
 *   - isMobileLike: the desktop-only gate predicate
 *   - replayFixtureUrl: bare fixture name resolution
 *   - perf gate verdict math: quantiles, summary, PASS/FAIL threshold
 *   - empower glow opacity: pulse bounds and decay
 *   - audio wiring smoke: MoveAudio receives events through the AudioHooks
 *     bridge exactly as an ArenaScreen-ish caller would deliver them
 */

import { describe, expect, it } from 'vitest';
import {
  MOBILE_MAX_WIDTH_PX,
  isMobileLike,
  replayFixtureUrl,
  routeFor,
} from '../src/boot/route';
import {
  ML_BUDGET_MS,
  PERF_BUDGET_MS,
  PERF_MEASURE_SEC,
  PERF_WARMUP_SEC,
  mlPass,
  perfPass,
  quantileSorted,
  stepPerfClock,
  summarizeFrames,
  summarizeMl,
  type PerfClockState,
  type PerfGateResult,
} from '../src/screens/perfGate';
import {
  EMPOWER_GLOW_MAX_OPACITY,
  empowerGlowOpacity,
} from '../src/ui/empowerGlow';
import {
  PLAYER_HIT_DUCK_AMOUNT,
  PLAYER_HIT_DUCK_MS,
  SLOWMO_DUCK_AMOUNT,
  buildAudioHooks,
} from '../src/boot/audioWiring';
import { DUCK_AMOUNT, MoveAudio } from '../src/audio/moveAudio';
import type { MoveEvent } from '../src/gestures/moves';
import type { CoalHandle, StopHandle, SustainHandle } from '../src/audio/engine';

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const P = (query: string): URLSearchParams => new URLSearchParams(query);

describe('routeFor', () => {
  it('routes every debug screen', () => {
    expect(routeFor(P('debug=tracking'))).toBe('debug-tracking');
    expect(routeFor(P('debug=moves'))).toBe('debug-moves');
    expect(routeFor(P('debug=arena'))).toBe('debug-arena');
    expect(routeFor(P('debug=fire'))).toBe('debug-fire');
    expect(routeFor(P('debug=perf'))).toBe('debug-perf');
  });

  it('routes the arena dev shortcut', () => {
    expect(routeFor(P('screen=arena'))).toBe('arena-replay');
    expect(routeFor(P('screen=arena&replay=fixtures/synthetic/jab-right.json'))).toBe(
      'arena-replay',
    );
  });

  it('routes a bare replay param to the full flow on replay input', () => {
    expect(routeFor(P('replay=jab-right'))).toBe('title-flow-replay');
  });

  it('defaults to the live title flow', () => {
    expect(routeFor(P(''))).toBe('title-flow');
    expect(routeFor(P('foo=bar'))).toBe('title-flow');
  });

  it('gives debug screens precedence over game routes', () => {
    expect(routeFor(P('debug=moves&screen=arena&replay=x'))).toBe('debug-moves');
    expect(routeFor(P('debug=perf&replay=x'))).toBe('debug-perf');
  });

  it('falls through an unknown debug value to the game routes', () => {
    expect(routeFor(P('debug=nonsense'))).toBe('title-flow');
    expect(routeFor(P('debug=nonsense&replay=jab-right'))).toBe('title-flow-replay');
  });
});

describe('isMobileLike (desktop-only gate)', () => {
  it('flags a narrow touch device', () => {
    expect(isMobileLike({ hasTouch: true, innerWidth: 390 })).toBe(true);
  });

  it('allows a wide touch device (touch laptops)', () => {
    expect(isMobileLike({ hasTouch: true, innerWidth: 1280 })).toBe(false);
  });

  it('allows a narrow window without touch', () => {
    expect(isMobileLike({ hasTouch: false, innerWidth: 500 })).toBe(false);
  });

  it('treats the boundary width as desktop', () => {
    expect(isMobileLike({ hasTouch: true, innerWidth: MOBILE_MAX_WIDTH_PX })).toBe(
      false,
    );
  });
});

describe('replayFixtureUrl', () => {
  it('maps bare names into fixtures/synthetic', () => {
    expect(replayFixtureUrl('jab-right')).toBe('fixtures/synthetic/jab-right.json');
  });

  it('passes paths and .json values through untouched', () => {
    expect(replayFixtureUrl('fixtures/recorded/session1.json')).toBe(
      'fixtures/recorded/session1.json',
    );
    expect(replayFixtureUrl('custom.json')).toBe('custom.json');
  });
});

// ---------------------------------------------------------------------------
// Perf gate verdict math
// ---------------------------------------------------------------------------

describe('perf gate math', () => {
  it('quantileSorted interpolates linearly', () => {
    const sorted = [10, 12, 14, 16, 20];
    expect(quantileSorted(sorted, 0)).toBe(10);
    expect(quantileSorted(sorted, 1)).toBe(20);
    expect(quantileSorted(sorted, 0.5)).toBe(14);
    expect(quantileSorted(sorted, 0.95)).toBeCloseTo(19.2, 10);
    expect(quantileSorted([], 0.5)).toBe(0);
    expect(quantileSorted([7], 0.95)).toBe(7);
  });

  it('summarizeFrames reports median, p95 and max from a known array', () => {
    // 1..20 shuffled; summarize sorts internally.
    const frames = [12, 3, 17, 8, 1, 20, 5, 14, 9, 2, 19, 6, 11, 4, 16, 7, 13, 10, 18, 15];
    const s = summarizeFrames(frames);
    expect(s.frames).toBe(20);
    expect(s.medianMs).toBeCloseTo(10.5, 10);
    expect(s.p95Ms).toBeCloseTo(19.05, 10);
    expect(s.maxMs).toBe(20);
  });

  it('passes within vsync slack and fails beyond it or on dropped frames', () => {
    expect(PERF_BUDGET_MS).toBeCloseTo(16.6, 10);
    expect(perfPass(12)).toBe(true);
    expect(perfPass(PERF_BUDGET_MS)).toBe(true);
    // vsync-locked 60Hz median (~16.7) passes within the 0.5ms slack
    expect(perfPass(16.7)).toBe(true);
    expect(perfPass(17.2)).toBe(false);
    // healthy median but dropped frames at p95 fails
    expect(perfPass(16.7, 33)).toBe(false);
    expect(perfPass(16.7, 18)).toBe(true);
  });

  it('summarizeMl amortizes per-model cost over rendered frames', () => {
    // Totals accumulated over 150 rendered frames; scheduling discount is
    // already baked into the totals (pose ran on half the frames, etc.).
    const ml = summarizeMl(true, { handMs: 300, poseMs: 150, faceMs: 75 }, 150);
    expect(ml).toEqual({
      available: true,
      handMs: 2,
      poseMs: 1,
      faceMs: 0.5,
      totalMsPerFrame: 3.5,
    });
    expect(ML_BUDGET_MS).toBe(7);
    expect(mlPass(ml.totalMsPerFrame)).toBe(true);
    expect(mlPass(ML_BUDGET_MS)).toBe(true);
    expect(mlPass(ML_BUDGET_MS + 0.01)).toBe(false);
  });

  it('summarizeMl degrades to zeros when unavailable or windowless', () => {
    expect(summarizeMl(false, { handMs: 99, poseMs: 9, faceMs: 9 }, 100)).toEqual({
      available: false,
      handMs: 0,
      poseMs: 0,
      faceMs: 0,
      totalMsPerFrame: 0,
    });
    const empty = summarizeMl(true, { handMs: 5, poseMs: 5, faceMs: 5 }, 0);
    expect(empty.available).toBe(true);
    expect(empty.totalMsPerFrame).toBe(0);
  });

  // Clock stepper: each case is a regression guard for the live-run hang
  // (warmup looping forever with frames: 0 under heavy ML frames).
  it('stepPerfClock runs loading -> warmup -> measure -> done with one finish', () => {
    // 250 ms per frame: exact binary fraction, so elapsed sums exactly.
    let s: PerfClockState = { phase: 'loading', elapsed: 0 };
    for (let i = 0; i < 10; i++) {
      const step = stepPerfClock(s, 250, true);
      expect(step.state.phase).toBe('loading');
      expect(step.state.elapsed).toBe(0);
      expect(step.recordMs).toBeNull();
      expect(step.finish).toBe(false);
      s = step.state;
    }
    // Models resolve: the transition frame spans the load period, so it is
    // discarded and warmup starts at 0.
    let step = stepPerfClock(s, 9999, false);
    expect(step.state).toEqual({ phase: 'warmup', elapsed: 0 });
    expect(step.recordMs).toBeNull();
    s = step.state;

    let finishes = 0;
    let records = 0;
    let prevElapsed = 0;
    for (let i = 0; i < 100; i++) {
      step = stepPerfClock(s, 250, false);
      expect(step.state.elapsed).toBeGreaterThanOrEqual(prevElapsed);
      prevElapsed = step.state.elapsed;
      s = step.state;
      if (step.recordMs !== null) records++;
      if (step.finish) finishes++;
    }
    expect(s.phase).toBe('done');
    expect(finishes).toBe(1);
    // Warmup ends at 3 s (frame 12), done at 18 s (frame 72): frames 12..72.
    expect(records).toBe(
      ((PERF_WARMUP_SEC + PERF_MEASURE_SEC) - PERF_WARMUP_SEC) * 4 + 1,
    );
  });

  it('stepPerfClock advances by UNCAPPED wall time, so heavy ML frames cannot stretch the window', () => {
    // 500 ms frames (~2 fps, CPU-delegate territory): the whole window must
    // still complete in 18 s of wall time = 36 frames. The old accumulator
    // capped each frame's contribution at 0.1 s, stretching warmup ~5x --
    // the "warming up forever" hang.
    let s: PerfClockState = { phase: 'warmup', elapsed: 0 };
    let frames = 0;
    let finishes = 0;
    while (s.phase !== 'done' && frames < 1000) {
      const step = stepPerfClock(s, 500, false);
      s = step.state;
      frames++;
      if (step.finish) finishes++;
    }
    expect(frames).toBe((PERF_WARMUP_SEC + PERF_MEASURE_SEC) * 2);
    expect(finishes).toBe(1);
  });

  it('stepPerfClock clamps negative rAF deltas: the countdown never rewinds', () => {
    const w = stepPerfClock({ phase: 'warmup', elapsed: 1 }, -250, false);
    expect(w.state).toEqual({ phase: 'warmup', elapsed: 1 });
    const m = stepPerfClock({ phase: 'measure', elapsed: 5 }, -50, false);
    expect(m.state.elapsed).toBe(5);
    expect(m.recordMs).toBe(0); // clamped sample, never negative
  });

  it('stepPerfClock: leaving loading is one-way; ML flag noise mid-measure cannot reset the clock', () => {
    // A detect-throw disables ML mid-run; even if pending-style flag noise
    // reached the stepper, phases past 'loading' must ignore it.
    const step = stepPerfClock({ phase: 'measure', elapsed: 10 }, 250, true);
    expect(step.state).toEqual({ phase: 'measure', elapsed: 10.25 });
    expect(step.recordMs).toBe(250);
    expect(step.finish).toBe(false);
    // 'done' absorbs everything: finish can never fire twice.
    const d = stepPerfClock({ phase: 'done', elapsed: 18 }, 250, true);
    expect(d.state).toEqual({ phase: 'done', elapsed: 18 });
    expect(d.recordMs).toBeNull();
    expect(d.finish).toBe(false);
  });

  it('PerfGateResult carries the optional ml block through JSON', () => {
    const base: PerfGateResult = {
      frames: 10,
      medianMs: 16,
      p95Ms: 17,
      maxMs: 20,
      pass: true,
      budgetMs: PERF_BUDGET_MS,
      drawCalls: 120,
      particles: { flames: 0, embers: 0, smoke: 0, total: 0 },
      lightsActive: 0,
    };
    // Merge exactly the way finish() does: conditional spread.
    const ml = summarizeMl(true, { handMs: 40, poseMs: 20, faceMs: 10 }, 10);
    const withMl: PerfGateResult = { ...base, ...(ml ? { ml } : {}) };
    const parsed = JSON.parse(JSON.stringify(withMl)) as PerfGateResult;
    expect(parsed.ml).toEqual({
      available: true,
      handMs: 4,
      poseMs: 2,
      faceMs: 1,
      totalMsPerFrame: 7,
    });
    expect(parsed.pass).toBe(true);
    // Without &ml=1 the field is absent entirely, not null.
    const parsedBase = JSON.parse(JSON.stringify(base)) as PerfGateResult;
    expect('ml' in parsedBase).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Empower glow (juice tuning)
// ---------------------------------------------------------------------------

describe('empowerGlowOpacity', () => {
  it('never exceeds the max opacity and stays non-negative', () => {
    let o = 0;
    for (let i = 0; i < 300; i++) {
      o = empowerGlowOpacity(true, o, 1 / 60, i / 60);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(EMPOWER_GLOW_MAX_OPACITY + 1e-9);
    }
    // Settles well into the visible range.
    expect(o).toBeGreaterThan(EMPOWER_GLOW_MAX_OPACITY * 0.3);
  });

  it('decays toward zero when inactive', () => {
    let o = EMPOWER_GLOW_MAX_OPACITY;
    for (let i = 0; i < 120; i++) {
      o = empowerGlowOpacity(false, o, 1 / 60, i / 60);
    }
    expect(o).toBeLessThan(0.005);
  });
});

// ---------------------------------------------------------------------------
// Audio wiring smoke: fake engine spy + real MoveAudio + ArenaScreen-ish caller
// ---------------------------------------------------------------------------

interface EngineSpy {
  calls: string[];
  ducks: Array<[number, number]>;
  coalLands: boolean[];
  sustainIntensities: number[];
  sustainStops: number;
  jab(empowered?: boolean): void;
  crossCombo(): void;
  palmWave(): void;
  twinCannon(empowered?: boolean): void;
  whipCrack(): void;
  risingFlame(): void;
  breathCharge(): StopHandle;
  streamStart(): SustainHandle;
  fanStart(): SustainHandle;
  killHit(): void;
  coalWhistle(flightTimeSec: number): CoalHandle;
  duck(amount: number, ms: number): void;
  wipe(): void;
}

function makeEngineSpy(): EngineSpy {
  const spy: EngineSpy = {
    calls: [],
    ducks: [],
    coalLands: [],
    sustainIntensities: [],
    sustainStops: 0,
    jab: (empowered?: boolean) => spy.calls.push(`jab:${empowered === true}`),
    crossCombo: () => spy.calls.push('cross-combo'),
    palmWave: () => spy.calls.push('palm-wave'),
    twinCannon: () => spy.calls.push('twin-cannon'),
    whipCrack: () => spy.calls.push('whip-crack'),
    risingFlame: () => spy.calls.push('rising-flame'),
    breathCharge: () => {
      spy.calls.push('breath-charge');
      return { stop: () => spy.calls.push('charge-stop') };
    },
    streamStart: () => {
      spy.calls.push('stream-start');
      return {
        setIntensity: (v: number) => spy.sustainIntensities.push(v),
        stop: () => {
          spy.sustainStops++;
        },
      };
    },
    fanStart: () => {
      spy.calls.push('fan-start');
      return {
        setIntensity: (v: number) => spy.sustainIntensities.push(v),
        stop: () => {
          spy.sustainStops++;
        },
      };
    },
    killHit: () => spy.calls.push('kill-hit'),
    coalWhistle: (flightTimeSec: number) => {
      spy.calls.push(`coal-whistle:${flightTimeSec}`);
      return { land: (blocked: boolean) => spy.coalLands.push(blocked) };
    },
    duck: (amount: number, ms: number) => spy.ducks.push([amount, ms]),
    wipe: () => spy.calls.push('wipe'),
  };
  return spy;
}

function ev(
  move: MoveEvent['move'],
  kind: MoveEvent['kind'],
  t = 0,
): MoveEvent {
  return {
    move,
    kind,
    hand: 'right',
    t,
    aim: { x: 0, y: 0, z: -1 },
    origin: { x: 0.5, y: 0.5, z: 0 },
    empowered: false,
    triggerLatencyMs: 0,
  };
}

describe('audio wiring bridge (buildAudioHooks)', () => {
  it('routes move events through MoveAudio to the engine', () => {
    const spy = makeEngineSpy();
    const moveAudio = new MoveAudio(spy);
    const hooks = buildAudioHooks(spy, moveAudio);

    // ArenaScreen-ish caller: routeEvent forwards every MoveEvent.
    hooks.onMoveEvent?.(ev('jab-blast', 'trigger', 100));
    hooks.onMoveEvent?.(ev('cross-combo', 'trigger', 300));
    expect(spy.calls).toContain('jab:false');
    expect(spy.calls).toContain('cross-combo');

    // Sustain lifecycle: start opens the roar, ticks refresh, end stops it.
    hooks.onMoveEvent?.(ev('fire-stream', 'sustain-start', 500));
    hooks.onMoveEvent?.(ev('fire-stream', 'sustain-tick', 533));
    hooks.onMoveEvent?.(ev('fire-stream', 'sustain-end', 900));
    expect(spy.calls).toContain('stream-start');
    expect(spy.sustainIntensities.length).toBeGreaterThanOrEqual(2);
    expect(spy.sustainStops).toBe(1);

    // A breath charge rumble is consumed by the next real move.
    hooks.onMoveEvent?.(ev('breath-charge', 'trigger', 1000));
    expect(spy.calls).toContain('breath-charge');
    hooks.onMoveEvent?.(ev('twin-cannon', 'trigger', 1500));
    expect(spy.calls).toContain('charge-stop');
    expect(spy.calls).toContain('twin-cannon');

    moveAudio.dispose();
  });

  it('routes combat hooks: kill, hit-stop duck, slow-mo and player-hit ducks', () => {
    const spy = makeEngineSpy();
    const moveAudio = new MoveAudio(spy);
    const hooks = buildAudioHooks(spy, moveAudio);

    hooks.onKill?.({ x: 0, y: 1, z: -6 });
    expect(spy.calls).toContain('kill-hit');

    hooks.onHitStop?.(120);
    expect(spy.ducks).toContainEqual([DUCK_AMOUNT, 120]);

    hooks.onSlowMo?.(0.25, 500);
    expect(spy.ducks.some(([a]) => a === SLOWMO_DUCK_AMOUNT)).toBe(true);

    hooks.onPlayerHit?.(8);
    expect(spy.ducks).toContainEqual([PLAYER_HIT_DUCK_AMOUNT, PLAYER_HIT_DUCK_MS]);

    moveAudio.dispose();
  });

  it('routes the coal lifecycle in launch order', () => {
    const spy = makeEngineSpy();
    const moveAudio = new MoveAudio(spy);
    const hooks = buildAudioHooks(spy, moveAudio);

    hooks.onCoalLob?.(1.3);
    hooks.onCoalLob?.(1.6);
    expect(spy.calls).toContain('coal-whistle:1.3');
    expect(spy.calls).toContain('coal-whistle:1.6');

    hooks.onCoalBlocked?.(); // oldest coal hit the wall
    hooks.onCoalLanded?.(); // second one got through
    expect(spy.coalLands).toEqual([true, false]);

    moveAudio.dispose();
  });

  it('plays the wipe swell when a camera travel starts', () => {
    const spy = makeEngineSpy();
    const moveAudio = new MoveAudio(spy);
    const hooks = buildAudioHooks(spy, moveAudio);

    hooks.onTravelStart?.(1);
    expect(spy.calls).toContain('wipe');

    moveAudio.dispose();
  });
});
