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
  const fans: Array<{ setIntensity: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const charges: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const coals: Array<{ land: ReturnType<typeof vi.fn> }> = [];
  const engine = {
    jab: vi.fn(),
    crossCombo: vi.fn(),
    palmWave: vi.fn(),
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
    fanStart: vi.fn(() => {
      const h = { setIntensity: vi.fn(), stop: vi.fn() };
      fans.push(h);
      return h;
    }),
    killHit: vi.fn(),
    coalWhistle: vi.fn((_flightTimeSec: number) => {
      const h = { land: vi.fn() };
      coals.push(h);
      return h;
    }),
    duck: vi.fn(),
  } satisfies EngineLike;
  return { engine, streams, fans, charges, coals };
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
      engine.duck(0.65, 120);
      engine.setMasterVolume(0.5);
    }).not.toThrow();
  });

  it('sustain, charge, ambient, and coal handles no-op safely', () => {
    const engine = new AudioEngine();
    const stream = engine.streamStart();
    const fan = engine.fanStart();
    const charge = engine.breathCharge();
    const ambient = engine.ambientStart();
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
      'palm-wave',
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
      audio.handleEvent(ev('flame-fan', 'sustain-start'));
      audio.handleEvent(ev('flame-fan', 'sustain-end'));
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
    ['palm-wave', 'palmWave'],
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
      expect(engine.fanStart).not.toHaveBeenCalled();
    });
  }

  it('fire-stream sustain-start calls streamStart, flame-fan calls fanStart', () => {
    const { engine } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    expect(engine.streamStart).toHaveBeenCalledTimes(1);
    expect(engine.fanStart).not.toHaveBeenCalled();
    audio.handleEvent(ev('fire-stream', 'sustain-end'));
    audio.handleEvent(ev('flame-fan', 'sustain-start'));
    expect(engine.fanStart).toHaveBeenCalledTimes(1);
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
      audio.handleEvent(ev('flame-fan', 'sustain-end'));
    }).not.toThrow();
    expect(engine.streamStart).not.toHaveBeenCalled();
    expect(engine.fanStart).not.toHaveBeenCalled();
  });

  it('a tick for a different move does not feed the active sustain', () => {
    const { engine, streams } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    audio.handleEvent(ev('flame-fan', 'sustain-tick'));
    expect(streams[0]?.setIntensity).toHaveBeenCalledTimes(1); // start only
  });

  it('a new sustain-start stops the previous handle first', () => {
    const { engine, streams, fans } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('fire-stream', 'sustain-start'));
    audio.handleEvent(ev('flame-fan', 'sustain-start'));
    expect(streams[0]?.stop).toHaveBeenCalledTimes(1);
    expect(fans[0]?.stop).not.toHaveBeenCalled();
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
    const { engine, fans } = makeMock();
    const audio = new MoveAudio(engine);
    audio.handleEvent(ev('flame-fan', 'sustain-start'));
    audio.dispose();
    expect(fans[0]?.stop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SUSTAIN_SAFETY_MS * 2);
    expect(fans[0]?.stop).toHaveBeenCalledTimes(1); // timer was cleared
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
});
