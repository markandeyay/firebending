/**
 * Headless audio tests (spec Section 13: no test requires a camera, and no
 * audio test requires an AudioContext).
 *
 * - AudioEngine must construct and no-op every method in node, where no
 *   AudioContext exists, without throwing.
 * - MoveAudio bookkeeping is tested against a spy EngineLike: move-to-sound
 *   mapping, empowered passthrough, sustain handle lifecycle including the
 *   0.6 s safety stop, charge rumble consumption, ducking, coal FIFO.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio/engine';
import {
  AdaptiveScore,
  computeIntensity,
  decayHitRate,
  SCORE,
  type ScoreEngineLike,
} from '../src/audio/score';
import {
  CHARGE_FALLBACK_MS,
  DUCK_AMOUNT,
  MoveAudio,
  SUSTAIN_SAFETY_MS,
  type EngineLike,
} from '../src/audio/moveAudio';
import type { MoveEvent, MoveEventKind, MoveName } from '../src/gestures/moves';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ev(
  move: MoveName,
  kind: MoveEventKind,
  opts: { empowered?: boolean; hand?: 'left' | 'right' | 'both'; t?: number } = {}
): MoveEvent {
  return {
    move,
    kind,
    hand: opts.hand ?? 'left',
    t: opts.t ?? 0,
    aim: { x: 0, y: 0, z: -1 },
    origin: { x: 0.5, y: 0.5, z: 0 },
    empowered: opts.empowered ?? false,
    triggerLatencyMs: 0,
  };
}

function makeMock() {
  const streams: Array<{ setIntensity: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const charges: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const coals: Array<{ land: ReturnType<typeof vi.fn> }> = [];
  const engine = {
    jab: vi.fn(),
    crossCombo: vi.fn(),
    twinCannon: vi.fn(),
    whipCrack: vi.fn(),
    risingFlame: vi.fn(),
    breathCharge: vi.fn(() => {
      const h = { stop: vi.fn() };
      charges.push(h);
      return h;
    }),
    streamStart: vi.fn(() => {
      const h = { setIntensity: vi.fn(), stop: vi.fn() };
      streams.push(h);
      return h;
    }),
    killHit: vi.fn(),
    impactThud: vi.fn(),
    coalWhistle: vi.fn((_flightTimeSec: number) => {
      const h = { land: vi.fn() };
      coals.push(h);
      return h;
    }),
    duck: vi.fn(),
  } satisfies EngineLike;
  return { engine, streams, charges, coals };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// AudioEngine: headless no-op guarantees
// ---------------------------------------------------------------------------

describe('AudioEngine headless', () => {
  it('constructs and unlock() is a safe no-op without AudioContext', () => {
    const engine = new AudioEngine();
    expect(engine.unlocked).toBe(false);
    expect(() => engine.unlock()).not.toThrow();
    expect(engine.unlocked).toBe(false);
  });

  it('every sound method no-ops silently when the context is absent', () => {
    const engine = new AudioEngine();
    expect(() => {
      engine.jab();
      engine.jab(true);
      engine.crossCombo();
      engine.palmWave();
      engine.twinCannon();
      engine.twinCannon(true);
      engine.whipCrack();
      engine.risingFlame();
      engine.ignite();
      engine.killHit();
      engine.sealPress();
      engine.wipe();
      engine.titleBell();
      engine.taiko();
      engine.taiko(0.4);
      engine.shakuhachi();
      engine.impactThud(8);
      engine.duck(0.65, 120);
      engine.setMasterVolume(0.5);
    }).not.toThrow();
  });

  it('sustain, charge, ambient, drone, and coal handles no-op safely', () => {
    const engine = new AudioEngine();
    const stream = engine.streamStart();
    const fan = engine.fanStart();
    const charge = engine.breathCharge();
    const ambient = engine.ambientStart();
    const drone = engine.droneStart();
    const coalA = engine.coalWhistle(1.2);
    const coalB = engine.coalWhistle(0);
    expect(() => {
      stream.setIntensity(0.5);
      stream.stop();
      stream.stop(); // idempotent
      fan.setIntensity(1);
      fan.stop();
      charge.stop();
      ambient.stop();
      drone.setIntensity(0.7);
      drone.stop();
      drone.stop(); // idempotent
      coalA.land(true);
      coalB.land(false);
      coalB.land(false); // idempotent
    }).not.toThrow();
  });

  it('dispose() is safe before unlock and repeatable', () => {
    const engine = new AudioEngine();
    expect(() => {
      engine.dispose();
      engine.dispose();
      engine.jab(); // still a silent no-op afterwards
    }).not.toThrow();
  });

  it('AudioEngine structurally satisfies EngineLike and drives MoveAudio headless', () => {
    const engine = new AudioEngine();
    const audio = new MoveAudio(engine);
    const moves: MoveName[] = [
      'jab-blast',
      'cross-combo',
      'twin-cannon',
      'rising-flame',
      'fire-whip',
      'breath-charge',
    ];
    expect(() => {
      for (const m of moves) audio.handleEvent(ev(m, 'trigger'));
      audio.handleEvent(ev('fire-stream', 'sustain-start'));
      audio.handleEvent(ev('fire-stream', 'sustain-tick'));
      audio.handleEvent(ev('fire-stream', 'sustain-end'));
      audio.onKill();
      audio.onHitStop(120);
      audio.onCoalLob(1.4);
      audio.onCoalBlocked();
      audio.onCoalLob(1.4);
      audio.onCoalLanded();
      audio.dispose();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// MoveAudio: move-to-sound mapping
// ---------------------------------------------------------------------------

describe('MoveAudio mapping', () => {
  const triggerMap: Array<[MoveName, keyof ReturnType<typeof makeMock>['engine']]> = [
    ['jab-blast', 'jab'],
    ['cross-combo', 'crossCombo'],
    ['twin-cannon', 'twinCannon'],
    ['rising-flame', 'risingFlame'],
    ['fire-whip', 'whipCrack'],
    ['breath-charge', 'breathCharge'],
  ];

  for (const [move, spyName] of triggerMap) {
    it(`${move} trigger calls engine.${String(spyName)} exactly once`, () => {
      const { engine } = makeMock();
      const audio = new MoveAudio(engine);
      audio.handleEvent(ev(move, 'trigger'));
      expect(engine[spyName]).toHaveBeenCalledTimes(1);
      // No other one-shot fired.
      for (const [, other] of triggerMap) {
        if (other !== spyName) expect(engine[other]).not.toHaveBeenCalled();
      }
      expect(engine.streamStart).not.toHaveBeenCalled();
    });
  }

  it('fire-stream sustain-start calls streamStart (the only sustained move)', () => {
    const { engine } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    expect(engine.streamStart).toHaveBeenCalledTimes(1);
    audio.handleEvent(ev('fire-stream', 'sustain-end'));
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    expect(engine.streamStart).toHaveBeenCalledTimes(2);
  });

  it('empowered flag passes through to jab and twin cannon', () => {
    const { engine } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('jab-blast', 'trigger', { empowered: true }));
    expect(engine.jab).toHaveBeenLastCalledWith(true);
    audio.handleEvent(ev('jab-blast', 'trigger'));
    expect(engine.jab).toHaveBeenLastCalledWith(false);
    audio.handleEvent(ev('twin-cannon', 'trigger', { empowered: true, hand: 'both' }));
    expect(engine.twinCannon).toHaveBeenLastCalledWith(true);
    audio.handleEvent(ev('twin-cannon', 'trigger', { hand: 'both' }));
    expect(engine.twinCannon).toHaveBeenLastCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// MoveAudio: sustain handle lifecycle
// ---------------------------------------------------------------------------

describe('MoveAudio sustain lifecycle', () => {
  it('start sets intensity, ticks refresh it, end stops the handle once', () => {
    const { engine, streams } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    const h = streams[0];
    expect(h).toBeDefined();
    expect(h?.setIntensity).toHaveBeenCalledTimes(1);
    audio.handleEvent(ev('fire-stream', 'sustain-tick'));
    audio.handleEvent(ev('fire-stream', 'sustain-tick'));
    expect(h?.setIntensity).toHaveBeenCalledTimes(3);
    audio.handleEvent(ev('fire-stream', 'sustain-end'));
    expect(h?.stop).toHaveBeenCalledTimes(1);
    // Repeated end and orphan ticks after the stop change nothing.
    audio.handleEvent(ev('fire-stream', 'sustain-end'));
    audio.handleEvent(ev('fire-stream', 'sustain-tick'));
    expect(h?.stop).toHaveBeenCalledTimes(1);
    expect(h?.setIntensity).toHaveBeenCalledTimes(3);
  });

  it('orphan ticks and ends without a start are ignored', () => {
    const { engine } = makeMock();
    const audio = new MoveAudio(engine);
    expect(() => {
      audio.handleEvent(ev('fire-stream', 'sustain-tick'));
      audio.handleEvent(ev('fire-stream', 'sustain-end'));
    }).not.toThrow();
    expect(engine.streamStart).not.toHaveBeenCalled();
  });

  it('a tick for a different move does not feed the active sustain', () => {
    const { engine, streams } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    audio.handleEvent(ev('jab-blast', 'sustain-tick'));
    expect(streams[0]?.setIntensity).toHaveBeenCalledTimes(1); // start only
  });

  it('a new sustain-start stops the previous handle first', () => {
    const { engine, streams } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    expect(streams[0]?.stop).toHaveBeenCalledTimes(1);
    expect(streams[1]?.stop).not.toHaveBeenCalled();
  });

  it('safety timeout stops the handle after 0.6s without ticks', () => {
    vi.useFakeTimers();
    const { engine, streams } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    const h = streams[0];
    vi.advanceTimersByTime(SUSTAIN_SAFETY_MS - 1);
    expect(h?.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(h?.stop).toHaveBeenCalledTimes(1);
    // A late sustain-end after the safety stop is a no-op.
    audio.handleEvent(ev('fire-stream', 'sustain-end'));
    expect(h?.stop).toHaveBeenCalledTimes(1);
  });

  it('ticks push the safety timeout forward', () => {
    vi.useFakeTimers();
    const { engine, streams } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    const h = streams[0];
    vi.advanceTimersByTime(400);
    audio.handleEvent(ev('fire-stream', 'sustain-tick'));
    vi.advanceTimersByTime(400); // 800ms since start, 400 since last tick
    expect(h?.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SUSTAIN_SAFETY_MS - 400 + 1);
    expect(h?.stop).toHaveBeenCalledTimes(1);
  });

  it('dispose stops the active sustain and clears the safety timer', () => {
    vi.useFakeTimers();
    const { engine, streams } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    audio.dispose();
    expect(streams[0]?.stop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SUSTAIN_SAFETY_MS * 2);
    expect(streams[0]?.stop).toHaveBeenCalledTimes(1); // timer was cleared
  });
});

// ---------------------------------------------------------------------------
// MoveAudio: charge rumble lifecycle
// ---------------------------------------------------------------------------

describe('MoveAudio breath charge', () => {
  it('the next move consumes the charge and stops the rumble', () => {
    vi.useFakeTimers();
    const { engine, charges } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('breath-charge', 'trigger', { hand: 'both' }));
    expect(charges[0]?.stop).not.toHaveBeenCalled();
    audio.handleEvent(ev('jab-blast', 'trigger', { empowered: true }));
    expect(charges[0]?.stop).toHaveBeenCalledTimes(1);
    // The cleared fallback timer must not double-stop.
    vi.advanceTimersByTime(CHARGE_FALLBACK_MS * 2);
    expect(charges[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it('an empowered sustain-start consumes the charge too', () => {
    const { engine, charges } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('breath-charge', 'trigger', { hand: 'both' }));
    audio.handleEvent(ev('fire-stream', 'sustain-start', { empowered: true }));
    expect(charges[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it('an unconsumed charge rumble stops after the empower window', () => {
    vi.useFakeTimers();
    const { engine, charges } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('breath-charge', 'trigger', { hand: 'both' }));
    vi.advanceTimersByTime(CHARGE_FALLBACK_MS - 1);
    expect(charges[0]?.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(charges[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it('a re-charge replaces the old rumble', () => {
    const { engine, charges } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('breath-charge', 'trigger', { hand: 'both' }));
    audio.handleEvent(ev('breath-charge', 'trigger', { hand: 'both' }));
    expect(engine.breathCharge).toHaveBeenCalledTimes(2);
    expect(charges[0]?.stop).toHaveBeenCalledTimes(1);
    expect(charges[1]?.stop).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MoveAudio: combat hooks
// ---------------------------------------------------------------------------

describe('MoveAudio combat hooks', () => {
  it('onKill plays the kill hit', () => {
    const { engine } = makeMock();
    const audio = new MoveAudio(engine);
    audio.onKill();
    expect(engine.killHit).toHaveBeenCalledTimes(1);
  });

  it('onHitStop ducks the master for the hit-stop duration', () => {
    const { engine } = makeMock();
    const audio = new MoveAudio(engine);
    audio.onHitStop(120);
    expect(engine.duck).toHaveBeenCalledTimes(1);
    expect(engine.duck).toHaveBeenCalledWith(DUCK_AMOUNT, 120);
  });

  it('coal lobs whistle and resolve FIFO to blocked or landed', () => {
    const { engine, coals } = makeMock();
    const audio = new MoveAudio(engine);
    audio.onCoalLob(1.4);
    audio.onCoalLob(0.9);
    expect(engine.coalWhistle).toHaveBeenNthCalledWith(1, 1.4);
    expect(engine.coalWhistle).toHaveBeenNthCalledWith(2, 0.9);
    audio.onCoalBlocked();
    expect(coals[0]?.land).toHaveBeenCalledWith(true);
    expect(coals[1]?.land).not.toHaveBeenCalled();
    audio.onCoalLanded();
    expect(coals[1]?.land).toHaveBeenCalledWith(false);
  });

  it('resolving with no coals in flight is a safe no-op', () => {
    const { engine } = makeMock();
    const audio = new MoveAudio(engine);
    expect(() => {
      audio.onCoalBlocked();
      audio.onCoalLanded();
    }).not.toThrow();
    expect(engine.coalWhistle).not.toHaveBeenCalled();
  });

  it('onConstructImpact plays the impact thud with the damage dealt', () => {
    const { engine } = makeMock();
    const audio = new MoveAudio(engine);
    audio.onConstructImpact(12);
    expect(engine.impactThud).toHaveBeenCalledTimes(1);
    expect(engine.impactThud).toHaveBeenCalledWith(12);
  });
});

// ---------------------------------------------------------------------------
// AdaptiveScore: the procedural score state machine (pure parts + spy engine)
// ---------------------------------------------------------------------------

function makeScoreMock() {
  const drones: Array<{
    setIntensity: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const engine = {
    droneStart: vi.fn(() => {
      const h = { setIntensity: vi.fn(), stop: vi.fn() };
      drones.push(h);
      return h;
    }),
    taiko: vi.fn(),
    shakuhachi: vi.fn(),
  } satisfies ScoreEngineLike;
  return { engine, drones };
}

describe('score pure functions', () => {
  it('decayHitRate halves-ish over the time constant and is identity at dt 0', () => {
    expect(decayHitRate(2, 0)).toBe(2);
    expect(decayHitRate(2, -1)).toBe(2);
    const one = decayHitRate(1, SCORE.HIT_DECAY_SEC);
    expect(one).toBeCloseTo(Math.exp(-1), 6);
    expect(decayHitRate(1, 100)).toBeLessThan(1e-6);
  });

  it('computeIntensity is BASE at rest and clamped to 0..1 at full boil', () => {
    expect(
      computeIntensity({ sustainActive: false, hitRate: 0, constructDamage01: 0 })
    ).toBeCloseTo(SCORE.BASE, 6);
    const full = computeIntensity({
      sustainActive: true,
      hitRate: 999,
      constructDamage01: 1,
    });
    expect(full).toBeLessThanOrEqual(1);
    expect(full).toBeGreaterThan(0.9);
  });

  it('each input contributes monotonically', () => {
    const rest = computeIntensity({ sustainActive: false, hitRate: 0, constructDamage01: 0 });
    const sustain = computeIntensity({ sustainActive: true, hitRate: 0, constructDamage01: 0 });
    const hits = computeIntensity({ sustainActive: false, hitRate: 1, constructDamage01: 0 });
    const dmg = computeIntensity({ sustainActive: false, hitRate: 0, constructDamage01: 0.5 });
    expect(sustain).toBeGreaterThan(rest);
    expect(hits).toBeGreaterThan(rest);
    expect(dmg).toBeGreaterThan(rest);
    // Hit contribution saturates at HIT_RATE_FULL.
    expect(
      computeIntensity({ sustainActive: false, hitRate: SCORE.HIT_RATE_FULL, constructDamage01: 0 })
    ).toBeCloseTo(
      computeIntensity({ sustainActive: false, hitRate: SCORE.HIT_RATE_FULL * 5, constructDamage01: 0 }),
      6
    );
  });
});

describe('AdaptiveScore state machine', () => {
  it('start opens the drone once and pushes the resting intensity', () => {
    vi.useFakeTimers();
    const { engine, drones } = makeScoreMock();
    const score = new AdaptiveScore(engine);
    expect(score.running).toBe(false);
    score.start(0);
    score.start(0); // idempotent
    expect(engine.droneStart).toHaveBeenCalledTimes(1);
    expect(score.running).toBe(true);
    expect(drones[0]?.setIntensity).toHaveBeenCalledWith(SCORE.BASE);
    score.dispose();
  });

  it('sustain start raises intensity, sustain end lowers it again', () => {
    // No start(): the interval is never armed; drive via explicit timestamps.
    const { engine, drones } = makeScoreMock();
    const score = new AdaptiveScore(engine);
    score.tick(0);
    expect(score.intensity).toBeCloseTo(SCORE.BASE, 6);
    score.onMoveEvent({ kind: 'sustain-start' }, 100);
    expect(score.intensity).toBeCloseTo(SCORE.BASE + SCORE.W_SUSTAIN, 6);
    score.onMoveEvent({ kind: 'sustain-end' }, 200);
    expect(score.intensity).toBeCloseTo(SCORE.BASE, 6);
    expect(drones.length).toBe(0); // never started: intensity math is pure
  });

  it('hits swell the bed and decay back down over time', () => {
    const { engine } = makeScoreMock();
    const score = new AdaptiveScore(engine);
    score.tick(0);
    score.onHitStop(120, 1000);
    score.onKill(1100);
    const hot = score.intensity;
    expect(hot).toBeGreaterThan(SCORE.BASE);
    // A long lull decays the tracker to nothing.
    score.tick(1100 + SCORE.HIT_DECAY_SEC * 1000 * 10);
    expect(score.intensity).toBeCloseTo(SCORE.BASE, 3);
  });

  it('onHitStop plays the score taiko at the impact strength', () => {
    const { engine } = makeScoreMock();
    const score = new AdaptiveScore(engine);
    score.onHitStop(120, 0);
    expect(engine.taiko).toHaveBeenCalledTimes(1);
    expect(engine.taiko).toHaveBeenCalledWith(SCORE.IMPACT_TAIKO_STRENGTH);
    expect(engine.shakuhachi).not.toHaveBeenCalled();
  });

  it('onKill does NOT double the taiko (killHit plays via MoveAudio)', () => {
    const { engine } = makeScoreMock();
    const score = new AdaptiveScore(engine);
    score.onKill(0);
    expect(engine.taiko).not.toHaveBeenCalled();
  });

  it('onTravelStart plays a shakuhachi note and resets the damage proxy', () => {
    const { engine } = makeScoreMock();
    const score = new AdaptiveScore(engine);
    score.onConstructImpact(SCORE.DAMAGE_FULL, 0); // full damage proxy
    score.tick(SCORE.HIT_DECAY_SEC * 1000 * 10); // hits decayed, damage stays
    expect(score.intensity).toBeCloseTo(SCORE.BASE + SCORE.W_DAMAGE, 3);
    score.onTravelStart(SCORE.HIT_DECAY_SEC * 1000 * 10 + 1);
    expect(engine.shakuhachi).toHaveBeenCalledTimes(1);
    expect(score.intensity).toBeCloseTo(SCORE.BASE, 3);
  });

  it('setIntensity overrides the model until released with null', () => {
    vi.useFakeTimers();
    const { engine, drones } = makeScoreMock();
    const score = new AdaptiveScore(engine);
    score.start(0);
    score.setIntensity(0.9);
    expect(score.intensity).toBe(0.9);
    expect(drones[0]?.setIntensity).toHaveBeenLastCalledWith(0.9);
    score.setIntensity(null);
    expect(score.intensity).toBeCloseTo(SCORE.BASE, 6);
    score.dispose();
  });

  it('the interval ticks push intensity to the drone and dispose clears it', () => {
    vi.useFakeTimers();
    const { engine, drones } = makeScoreMock();
    const score = new AdaptiveScore(engine);
    score.start(Date.now());
    const pushesAfterStart = drones[0]?.setIntensity.mock.calls.length ?? 0;
    vi.advanceTimersByTime(SCORE.TICK_MS * 3 + 5);
    const pushesAfterTicks = drones[0]?.setIntensity.mock.calls.length ?? 0;
    expect(pushesAfterTicks).toBeGreaterThan(pushesAfterStart);
    score.dispose();
    expect(drones[0]?.stop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SCORE.TICK_MS * 5);
    expect(drones[0]?.setIntensity.mock.calls.length).toBe(pushesAfterTicks);
    expect(score.running).toBe(false);
  });

  it('headless AudioEngine satisfies ScoreEngineLike and runs silently', () => {
    const engine = new AudioEngine();
    const score = new AdaptiveScore(engine);
    expect(() => {
      score.start(0);
      score.onMoveEvent({ kind: 'sustain-start' }, 10);
      score.onHitStop(120, 20);
      score.onKill(30);
      score.onConstructImpact(5, 40);
      score.onTravelStart(50);
      score.tick(60);
      score.setIntensity(0.5);
      score.dispose();
      score.dispose(); // idempotent
    }).not.toThrow();
  });
});
