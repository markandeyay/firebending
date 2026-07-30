/**
 * AudioEngine: every sound in the game, synthesized from scratch with plain
 * Web Audio. No external files, no downloaded packs; synthesis is
 * license-clean by construction and adds nothing to the bundle.
 *
 * Lifecycle: constructing the engine is free and safe anywhere, including
 * node test runs (no AudioContext is touched). Call unlock() from a real
 * user-gesture handler (the title screen's Play seal is the natural place);
 * it lazily creates the AudioContext and the master chain
 * (master GainNode -> DynamicsCompressor -> destination). Every sound method
 * silently no-ops until unlock() has succeeded, so callers never branch.
 *
 * Determinism: all noise source buffers (white, pink, brown, crackle) are
 * generated once at unlock from a seeded PRNG, so two runs of the game
 * produce bit-identical source material. One-shot crackle playback walks a
 * deterministic cursor through the crackle buffer instead of Math.random.
 *
 * Ducking: duck(amount, ms) is wired to hit-stop (spec Section 12): a fast
 * linear dip of the master gain, a hold for the hit-stop duration, then a
 * smooth exponential recovery to the current master volume.
 */

// ---------------------------------------------------------------------------
// Public handle types
// ---------------------------------------------------------------------------

/** A running sustained sound (fire-stream / flame-fan). */
export interface SustainHandle {
  /** Volume follows move intensity 0..1 (smoothed inside the engine). */
  setIntensity(v: number): void;
  /** Fade out fast and release all nodes. Idempotent. */
  stop(): void;
}

/** A running open-ended sound with no intensity control. */
export interface StopHandle {
  stop(): void;
}

/** An in-flight coal lob. Call land() exactly once when it resolves. */
export interface CoalHandle {
  /** blocked=true plays the block poof, false plays the impact thud. */
  land(blocked: boolean): void;
}

// ---------------------------------------------------------------------------
// Tuning constants, grouped per sound. All gains are pre-master linear gain,
// all frequencies Hz, all durations seconds unless suffixed Ms.
// PROVISIONAL: tuned by construction, not by ear; see HUMAN item in tracker.
// ---------------------------------------------------------------------------

export const MASTER = {
  VOLUME: 0.9,
  /** Fast attenuate edge of the duck. */
  DUCK_ATTACK_SEC: 0.012,
  /** Time constant of the smooth recovery after the hold. */
  DUCK_RELEASE_TC: 0.09,
  COMP_THRESHOLD_DB: -14,
  COMP_KNEE_DB: 20,
  COMP_RATIO: 5,
  COMP_ATTACK_SEC: 0.004,
  COMP_RELEASE_SEC: 0.24,
} as const;

export const NOISE = {
  SEED: 0xf17ebe4d,
  BUFFER_SEC: 2,
  /** Per-sample probability that a crackle impulse starts. */
  CRACKLE_PROB: 0.00042,
  /** Impulse decay length in samples (at 44.1k this is ~3 ms). */
  CRACKLE_DECAY_SAMPLES: 130,
  /** Deterministic playback cursor step through the crackle buffer. */
  CRACKLE_CURSOR_STEP_SEC: 0.377,
} as const;

/** Smallest value exponential gain ramps may target (must be > 0). */
const GAIN_FLOOR = 0.0008;

export const JAB = {
  DUR: 0.18,
  BP_START: 1900,
  BP_END: 480,
  Q: 1.1,
  GAIN: 0.5,
  ATTACK: 0.008,
  EMPOWERED_GAIN_MUL: 1.5,
  EMPOWERED_DUR: 0.24,
  EMPOWERED_BP_START: 1400,
  EMPOWERED_SUB_F0: 110,
  EMPOWERED_SUB_F1: 70,
  EMPOWERED_SUB_GAIN: 0.28,
  EMPOWERED_SUB_DUR: 0.22,
} as const;

export const CROSS = {
  DUR: 0.3,
  BP_START: 1400,
  BP_END: 350,
  Q: 1.0,
  GAIN: 0.6,
  ATTACK: 0.008,
  BOOM_F0: 100,
  BOOM_F1: 48,
  BOOM_GAIN: 0.5,
  BOOM_DUR: 0.35,
} as const;

export const PALM = {
  DUR: 0.26,
  BP_START: 1100,
  BP_END: 600,
  /** Low Q = wide band = softer, breathier than the jab. */
  Q: 0.5,
  GAIN: 0.32,
  ATTACK: 0.02,
} as const;

export const TWIN = {
  SUB_F0: 55,
  SUB_F1: 32,
  SUB_SWEEP: 0.5,
  SUB_GAIN: 0.9,
  TAIL: 0.9,
  NOISE_LP_START: 700,
  NOISE_LP_END: 180,
  NOISE_GAIN: 0.5,
  NOISE_DUR: 0.5,
  ATTACK: 0.005,
  EMPOWERED_GAIN_MUL: 1.3,
  EMPOWERED_TAIL: 1.1,
} as const;

export const WHIP = {
  SNAP_HP: 3200,
  SNAP_GAIN: 0.9,
  SNAP_ATTACK: 0.002,
  SNAP_DUR: 0.05,
  TAIL_LP: 900,
  TAIL_GAIN: 0.35,
  TAIL_ATTACK: 0.005,
  TAIL_DUR: 0.22,
} as const;

export const RISING = {
  DUR: 0.65,
  SWELL_AT: 0.35,
  BP_START: 420,
  BP_END: 2300,
  Q: 0.8,
  GAIN: 0.5,
} as const;

export const CHARGE = {
  LP: 180,
  GAIN: 0.3,
  SWELL_TC: 0.45,
  LFO_HZ: 2.2,
  LFO_DEPTH: 0.1,
  STOP_TC: 0.08,
} as const;

export const STREAM = {
  LP: 900,
  GAIN: 0.45,
  /** Slow amplitude wobble that makes the roar feel alive. */
  LFO_HZ: 2.7,
  LFO_DEPTH: 0.07,
  INTENSITY_TC: 0.08,
  STOP_TC: 0.06,
} as const;

export const FAN = {
  /** Higher cutoff than the stream: wider, airier. */
  LP: 2600,
  GAIN: 0.4,
  LFO_HZ: 3.4,
  LFO_DEPTH: 0.08,
  /** Extra shimmer band on top of the roar. */
  SHIMMER_BP: 3800,
  SHIMMER_Q: 1.0,
  SHIMMER_GAIN: 0.18,
  SHIMMER_LFO_HZ: 5.3,
  SHIMMER_LFO_DEPTH: 0.06,
  INTENSITY_TC: 0.08,
  STOP_TC: 0.06,
} as const;

export const IGNITE = {
  CRACKLE_HP: 1400,
  CRACKLE_GAIN: 0.5,
  CRACKLE_DUR: 0.35,
  WHOOSH_BP: 900,
  WHOOSH_Q: 0.7,
  WHOOSH_GAIN: 0.2,
  WHOOSH_DUR: 0.3,
} as const;

export const KILL = {
  /** Taiko-style membrane thump: fast pitch drop into a low fundamental. */
  F0: 165,
  F1: 52,
  SWEEP: 0.09,
  GAIN: 0.95,
  TAIL: 0.65,
  BODY_F0: 190,
  BODY_F1: 60,
  BODY_GAIN: 0.2,
  BODY_TAIL: 0.2,
  TRANSIENT_HP: 2000,
  TRANSIENT_GAIN: 0.3,
  TRANSIENT_DUR: 0.03,
  ATTACK: 0.004,
} as const;

export const COAL = {
  WHISTLE_Q: 12,
  WHISTLE_F0: 1500,
  WHISTLE_PEAK_F: 2000,
  WHISTLE_F1: 1100,
  WHISTLE_GAIN: 0.12,
  WHISTLE_ATTACK: 0.15,
  MIN_FLIGHT: 0.2,
  THUD_F0: 80,
  THUD_F1: 45,
  THUD_GAIN: 0.6,
  THUD_DUR: 0.25,
  THUD_NOISE_LP: 500,
  THUD_NOISE_GAIN: 0.3,
  THUD_NOISE_DUR: 0.12,
  POOF_LP: 1200,
  POOF_GAIN: 0.4,
  POOF_ATTACK: 0.01,
  POOF_DUR: 0.18,
} as const;

export const SEAL = {
  THUMP_F: 130,
  THUMP_GAIN: 0.35,
  THUMP_DUR: 0.12,
  CRACKLE_HP: 2200,
  CRACKLE_GAIN: 0.15,
  CRACKLE_DUR: 0.12,
} as const;

export const WIPE = {
  DUR: 0.6,
  SWELL_AT: 0.25,
  BP_START: 500,
  BP_END: 1600,
  Q: 0.7,
  GAIN: 0.45,
} as const;

export const AMBIENT = {
  CRACKLE_HP: 900,
  CRACKLE_GAIN: 0.08,
  ROAR_LP: 350,
  ROAR_GAIN: 0.05,
  /** Very slow breathing of the whole bed. */
  LFO_HZ: 0.4,
  LFO_DEPTH: 0.02,
  STOP_TC: 0.3,
} as const;

// ---------------------------------------------------------------------------
// Seeded noise generation
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fillWhite(data: Float32Array, rng: () => number): void {
  for (let i = 0; i < data.length; i++) data[i] = rng() * 2 - 1;
}

/** Paul Kellet's economy pink noise filter over seeded white noise. */
function fillPink(data: Float32Array, rng: () => number): void {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
  }
}

/** Leaky-integrated white noise: brown(ish), deep rumble material. */
function fillBrown(data: Float32Array, rng: () => number): void {
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const w = rng() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    data[i] = last * 3.5;
  }
}

/** Sparse random impulse train with short exponential decays: fire crackle. */
function fillCrackle(data: Float32Array, rng: () => number): void {
  let i = 0;
  while (i < data.length) {
    if (rng() < NOISE.CRACKLE_PROB) {
      const amp = (0.35 + 0.65 * rng()) * (rng() < 0.5 ? -1 : 1);
      const len = Math.min(NOISE.CRACKLE_DECAY_SAMPLES, data.length - i);
      for (let k = 0; k < len; k++) {
        data[i + k] = amp * Math.exp(-k / (NOISE.CRACKLE_DECAY_SAMPLES / 4)) * (rng() * 2 - 1);
      }
      i += len;
    } else {
      data[i] = 0;
      i++;
    }
  }
}

// ---------------------------------------------------------------------------
// No-op handles for the locked (contextless) state
// ---------------------------------------------------------------------------

const NOOP_SUSTAIN: SustainHandle = { setIntensity: () => {}, stop: () => {} };
const NOOP_STOP: StopHandle = { stop: () => {} };
const NOOP_COAL: CoalHandle = { land: () => {} };

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Everything that exists only after unlock() succeeds. */
interface Rig {
  ctx: AudioContext;
  master: GainNode;
  compressor: DynamicsCompressorNode;
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  crackle: AudioBuffer;
}

type AudioContextCtor = new () => AudioContext;

function findAudioContextCtor(): AudioContextCtor | null {
  const g = globalThis as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export class AudioEngine {
  private rig: Rig | null = null;
  private masterVolume: number = MASTER.VOLUME;
  private crackleCursor = 0;

  /**
   * Create the AudioContext and master chain. Must be called from a user
   * gesture handler (click) so the context starts unsuspended. Safe to call
   * repeatedly; safe in node (no AudioContext -> stays locked, no throw).
   */
  unlock(): void {
    if (this.rig) {
      void this.rig.ctx.resume();
      return;
    }
    const Ctor = findAudioContextCtor();
    if (Ctor === null) return;
    const ctx = new Ctor();

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = MASTER.COMP_THRESHOLD_DB;
    compressor.knee.value = MASTER.COMP_KNEE_DB;
    compressor.ratio.value = MASTER.COMP_RATIO;
    compressor.attack.value = MASTER.COMP_ATTACK_SEC;
    compressor.release.value = MASTER.COMP_RELEASE_SEC;
    compressor.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    master.connect(compressor);

    const len = Math.floor(ctx.sampleRate * NOISE.BUFFER_SEC);
    const make = (fill: (d: Float32Array, r: () => number) => void, seedOffset: number) => {
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      fill(buf.getChannelData(0), mulberry32(NOISE.SEED + seedOffset));
      return buf;
    };

    this.rig = {
      ctx,
      master,
      compressor,
      white: make(fillWhite, 0),
      pink: make(fillPink, 1),
      brown: make(fillBrown, 2),
      crackle: make(fillCrackle, 3),
    };
    void ctx.resume();
  }

  /** True once unlock() has created a context. */
  get unlocked(): boolean {
    return this.rig !== null;
  }

  /** Master volume 0..1 (the value ducking recovers to). */
  setMasterVolume(v: number): void {
    this.masterVolume = clamp01(v);
    const r = this.rig;
    if (!r) return;
    r.master.gain.setTargetAtTime(this.masterVolume, r.ctx.currentTime, 0.03);
  }

  /**
   * Master ducking for hit-stop: dip by `amount` (0..1 of current volume)
   * almost instantly, hold for `ms`, then recover smoothly.
   */
  duck(amount: number, ms: number): void {
    const r = this.rig;
    if (!r) return;
    const g = r.master.gain;
    const t = r.ctx.currentTime;
    const dipped = Math.max(GAIN_FLOOR, this.masterVolume * (1 - clamp01(amount)));
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(dipped, t + MASTER.DUCK_ATTACK_SEC);
    const holdEnd = t + Math.max(MASTER.DUCK_ATTACK_SEC, ms / 1000);
    g.setValueAtTime(dipped, holdEnd);
    g.setTargetAtTime(this.masterVolume, holdEnd, MASTER.DUCK_RELEASE_TC);
  }

  /** Close the context and release everything. The engine can be re-unlocked. */
  dispose(): void {
    const r = this.rig;
    this.rig = null;
    if (!r) return;
    try {
      void r.ctx.close();
    } catch {
      // Already closed; nothing to release.
    }
  }

  // -------------------------------------------------------------------------
  // One-shot moves
  // -------------------------------------------------------------------------

  /** Punch whoosh: bandpassed noise burst with a fast pitch-down sweep. */
  jab(empowered = false): void {
    const r = this.rig;
    if (!r) return;
    const dur = empowered ? JAB.EMPOWERED_DUR : JAB.DUR;
    const f0 = empowered ? JAB.EMPOWERED_BP_START : JAB.BP_START;
    const gain = empowered ? JAB.GAIN * JAB.EMPOWERED_GAIN_MUL : JAB.GAIN;
    this.noiseHit(r, r.white, 'bandpass', f0, JAB.BP_END, JAB.Q, gain, JAB.ATTACK, dur);
    if (empowered) {
      this.tone(
        r,
        'sine',
        JAB.EMPOWERED_SUB_F0,
        JAB.EMPOWERED_SUB_F1,
        JAB.EMPOWERED_SUB_GAIN,
        JAB.ATTACK,
        JAB.EMPOWERED_SUB_DUR
      );
    }
  }

  /** Third-hit upgrade: heavier whoosh plus a low boom layer. */
  crossCombo(): void {
    const r = this.rig;
    if (!r) return;
    this.noiseHit(
      r,
      r.white,
      'bandpass',
      CROSS.BP_START,
      CROSS.BP_END,
      CROSS.Q,
      CROSS.GAIN,
      CROSS.ATTACK,
      CROSS.DUR
    );
    this.tone(r, 'sine', CROSS.BOOM_F0, CROSS.BOOM_F1, CROSS.BOOM_GAIN, CROSS.ATTACK, CROSS.BOOM_DUR);
  }

  /** Softer, wider whoosh than the jab (low-Q band, gentle attack). */
  palmWave(): void {
    const r = this.rig;
    if (!r) return;
    this.noiseHit(
      r,
      r.white,
      'bandpass',
      PALM.BP_START,
      PALM.BP_END,
      PALM.Q,
      PALM.GAIN,
      PALM.ATTACK,
      PALM.DUR
    );
  }

  /** Deep boom: sine sub thump pitching down plus a dark noise layer. */
  twinCannon(empowered = false): void {
    const r = this.rig;
    if (!r) return;
    const mul = empowered ? TWIN.EMPOWERED_GAIN_MUL : 1;
    const tail = empowered ? TWIN.EMPOWERED_TAIL : TWIN.TAIL;
    this.tone(r, 'sine', TWIN.SUB_F0, TWIN.SUB_F1, TWIN.SUB_GAIN * mul, TWIN.ATTACK, tail, TWIN.SUB_SWEEP);
    this.noiseHit(
      r,
      r.white,
      'lowpass',
      TWIN.NOISE_LP_START,
      TWIN.NOISE_LP_END,
      1,
      TWIN.NOISE_GAIN * mul,
      TWIN.ATTACK,
      TWIN.NOISE_DUR
    );
  }

  /** Whip crack: near-instant highpassed snap, then a quick lowpassed tail. */
  whipCrack(): void {
    const r = this.rig;
    if (!r) return;
    this.noiseHit(r, r.white, 'highpass', WHIP.SNAP_HP, null, 0.7, WHIP.SNAP_GAIN, WHIP.SNAP_ATTACK, WHIP.SNAP_DUR);
    this.noiseHit(r, r.white, 'lowpass', WHIP.TAIL_LP, null, 0.7, WHIP.TAIL_GAIN, WHIP.TAIL_ATTACK, WHIP.TAIL_DUR);
  }

  /** Shield whoosh: broadband noise swell rising in pitch. */
  risingFlame(): void {
    const r = this.rig;
    if (!r) return;
    this.swell(r, r.white, RISING.BP_START, RISING.BP_END, RISING.Q, RISING.GAIN, RISING.SWELL_AT, RISING.DUR);
  }

  /** Calibration ignition and burst starts: crackle plus a soft whoosh. */
  ignite(): void {
    const r = this.rig;
    if (!r) return;
    this.crackleBurst(r, IGNITE.CRACKLE_HP, IGNITE.CRACKLE_GAIN, IGNITE.CRACKLE_DUR);
    this.noiseHit(
      r,
      r.white,
      'bandpass',
      IGNITE.WHOOSH_BP,
      null,
      IGNITE.WHOOSH_Q,
      IGNITE.WHOOSH_GAIN,
      0.02,
      IGNITE.WHOOSH_DUR
    );
  }

  /** Taiko-style kill hit: tuned membrane thump, low and ceremonial. */
  killHit(): void {
    const r = this.rig;
    if (!r) return;
    this.tone(r, 'sine', KILL.F0, KILL.F1, KILL.GAIN, KILL.ATTACK, KILL.TAIL, KILL.SWEEP);
    this.tone(r, 'triangle', KILL.BODY_F0, KILL.BODY_F1, KILL.BODY_GAIN, KILL.ATTACK, KILL.BODY_TAIL, KILL.SWEEP);
    this.noiseHit(
      r,
      r.white,
      'highpass',
      KILL.TRANSIENT_HP,
      null,
      0.7,
      KILL.TRANSIENT_GAIN,
      0.002,
      KILL.TRANSIENT_DUR
    );
  }

  /** UI: wax seal press, a soft thump with a whisper of crackle. */
  sealPress(): void {
    const r = this.rig;
    if (!r) return;
    this.tone(r, 'sine', SEAL.THUMP_F, SEAL.THUMP_F * 0.7, SEAL.THUMP_GAIN, 0.004, SEAL.THUMP_DUR);
    this.crackleBurst(r, SEAL.CRACKLE_HP, SEAL.CRACKLE_GAIN, SEAL.CRACKLE_DUR);
  }

  /** UI: flame wipe transition whoosh. */
  wipe(): void {
    const r = this.rig;
    if (!r) return;
    this.swell(r, r.white, WIPE.BP_START, WIPE.BP_END, WIPE.Q, WIPE.GAIN, WIPE.SWELL_AT, WIPE.DUR);
  }

  // -------------------------------------------------------------------------
  // Sustained sounds
  // -------------------------------------------------------------------------

  /** Fire-stream roar: looped brown noise, lowpassed, slow amplitude wobble. */
  streamStart(): SustainHandle {
    const r = this.rig;
    if (!r) return NOOP_SUSTAIN;
    return this.makeRoar(r, {
      buffer: r.brown,
      lp: STREAM.LP,
      gain: STREAM.GAIN,
      lfoHz: STREAM.LFO_HZ,
      lfoDepth: STREAM.LFO_DEPTH,
      intensityTc: STREAM.INTENSITY_TC,
      stopTc: STREAM.STOP_TC,
      shimmer: null,
    });
  }

  /** Flame-fan roar: pink noise, higher cutoff, extra shimmer band. Airier. */
  fanStart(): SustainHandle {
    const r = this.rig;
    if (!r) return NOOP_SUSTAIN;
    return this.makeRoar(r, {
      buffer: r.pink,
      lp: FAN.LP,
      gain: FAN.GAIN,
      lfoHz: FAN.LFO_HZ,
      lfoDepth: FAN.LFO_DEPTH,
      intensityTc: FAN.INTENSITY_TC,
      stopTc: FAN.STOP_TC,
      shimmer: {
        bp: FAN.SHIMMER_BP,
        q: FAN.SHIMMER_Q,
        gain: FAN.SHIMMER_GAIN,
        lfoHz: FAN.SHIMMER_LFO_HZ,
        lfoDepth: FAN.SHIMMER_LFO_DEPTH,
      },
    });
  }

  /** Breath-charge rumble: low filtered noise swelling under a slow LFO. */
  breathCharge(): StopHandle {
    const r = this.rig;
    if (!r) return NOOP_STOP;
    const t = r.ctx.currentTime;
    const src = loopSource(r.ctx, r.brown);
    const lp = r.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = CHARGE.LP;
    const amp = r.ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.setTargetAtTime(CHARGE.GAIN, t, CHARGE.SWELL_TC);
    const { osc: lfo, gain: lfoGain } = makeLfo(r.ctx, CHARGE.LFO_HZ, CHARGE.LFO_DEPTH, t);
    lfoGain.connect(amp.gain);
    src.connect(lp).connect(amp).connect(r.master);
    src.start(t);

    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        const now = r.ctx.currentTime;
        amp.gain.cancelScheduledValues(now);
        amp.gain.setTargetAtTime(0, now, CHARGE.STOP_TC);
        const end = now + CHARGE.STOP_TC * 6;
        src.stop(end);
        lfo.stop(end);
        src.onended = () => {
          disconnectAll(src, lp, amp, lfo, lfoGain);
        };
      },
    };
  }

  /** Ambient brazier crackle bed: continuous low-level loop for the arena. */
  ambientStart(): StopHandle {
    const r = this.rig;
    if (!r) return NOOP_STOP;
    const t = r.ctx.currentTime;
    const bed = r.ctx.createGain();
    bed.gain.setValueAtTime(0, t);
    bed.gain.setTargetAtTime(1, t, 0.5);
    const { osc: lfo, gain: lfoGain } = makeLfo(r.ctx, AMBIENT.LFO_HZ, AMBIENT.LFO_DEPTH, t);
    lfoGain.connect(bed.gain);
    bed.connect(r.master);

    const crackleSrc = loopSource(r.ctx, r.crackle);
    const hp = r.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = AMBIENT.CRACKLE_HP;
    const crackleGain = r.ctx.createGain();
    crackleGain.gain.value = AMBIENT.CRACKLE_GAIN;
    crackleSrc.connect(hp).connect(crackleGain).connect(bed);

    const roarSrc = loopSource(r.ctx, r.brown);
    const lp = r.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = AMBIENT.ROAR_LP;
    const roarGain = r.ctx.createGain();
    roarGain.gain.value = AMBIENT.ROAR_GAIN;
    roarSrc.connect(lp).connect(roarGain).connect(bed);

    crackleSrc.start(t);
    roarSrc.start(t);

    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        const now = r.ctx.currentTime;
        bed.gain.cancelScheduledValues(now);
        bed.gain.setTargetAtTime(0, now, AMBIENT.STOP_TC);
        const end = now + AMBIENT.STOP_TC * 6;
        crackleSrc.stop(end);
        roarSrc.stop(end);
        lfo.stop(end);
        crackleSrc.onended = () => {
          disconnectAll(crackleSrc, hp, crackleGain, roarSrc, lp, roarGain, bed, lfo, lfoGain);
        };
      },
    };
  }

  // -------------------------------------------------------------------------
  // Coal lob
  // -------------------------------------------------------------------------

  /**
   * Incoming coal: a narrow whistling band that rises then falls over the
   * flight time (seconds). Call land(blocked) when it resolves: blocked
   * plays a soft poof against the fire wall, unblocked a low thud.
   */
  coalWhistle(flightTimeSec: number): CoalHandle {
    const r = this.rig;
    if (!r) return NOOP_COAL;
    const flight = Math.max(COAL.MIN_FLIGHT, flightTimeSec);
    const t = r.ctx.currentTime;
    const src = loopSource(r.ctx, r.white);
    const bp = r.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = COAL.WHISTLE_Q;
    bp.frequency.setValueAtTime(COAL.WHISTLE_F0, t);
    bp.frequency.exponentialRampToValueAtTime(COAL.WHISTLE_PEAK_F, t + flight * 0.5);
    bp.frequency.exponentialRampToValueAtTime(COAL.WHISTLE_F1, t + flight);
    const amp = r.ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.setTargetAtTime(COAL.WHISTLE_GAIN, t, COAL.WHISTLE_ATTACK);
    src.connect(bp).connect(amp).connect(r.master);
    src.start(t);
    src.stop(t + flight + 0.5);
    src.onended = () => {
      disconnectAll(src, bp, amp);
    };

    let landed = false;
    return {
      land: (blocked: boolean) => {
        if (landed) return;
        landed = true;
        const now = r.ctx.currentTime;
        amp.gain.cancelScheduledValues(now);
        amp.gain.setTargetAtTime(0, now, 0.02);
        src.stop(now + 0.15);
        if (blocked) {
          // Block poof: the coal bursts against the flame wall.
          this.noiseHit(r, r.white, 'lowpass', COAL.POOF_LP, null, 0.7, COAL.POOF_GAIN, COAL.POOF_ATTACK, COAL.POOF_DUR);
          this.crackleBurst(r, IGNITE.CRACKLE_HP, IGNITE.CRACKLE_GAIN * 0.5, 0.2);
        } else {
          // Thud: it got through and hit.
          this.tone(r, 'sine', COAL.THUD_F0, COAL.THUD_F1, COAL.THUD_GAIN, 0.004, COAL.THUD_DUR);
          this.noiseHit(
            r,
            r.white,
            'lowpass',
            COAL.THUD_NOISE_LP,
            null,
            0.7,
            COAL.THUD_NOISE_GAIN,
            0.004,
            COAL.THUD_NOISE_DUR
          );
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Synthesis building blocks
  // -------------------------------------------------------------------------

  /** Filtered noise burst with attack/exp-decay envelope and optional sweep. */
  private noiseHit(
    r: Rig,
    buffer: AudioBuffer,
    filterType: BiquadFilterType,
    f0: number,
    f1: number | null,
    q: number,
    peak: number,
    attack: number,
    dur: number
  ): void {
    const t = r.ctx.currentTime;
    const src = r.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = r.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t);
    if (f1 !== null) filter.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = r.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(GAIN_FLOOR, t + dur);
    src.connect(filter).connect(g).connect(r.master);
    src.start(t);
    src.stop(t + dur + 0.05);
    src.onended = () => {
      disconnectAll(src, filter, g);
    };
  }

  /** Oscillator hit: pitch envelope f0 -> f1 over sweep, exp gain decay. */
  private tone(
    r: Rig,
    type: OscillatorType,
    f0: number,
    f1: number,
    peak: number,
    attack: number,
    dur: number,
    sweep = dur
  ): void {
    const t = r.ctx.currentTime;
    const osc = r.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + sweep);
    const g = r.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(GAIN_FLOOR, t + dur);
    osc.connect(g).connect(r.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    osc.onended = () => {
      disconnectAll(osc, g);
    };
  }

  /** Bandpassed noise swell: rise to peak at swellAt, release by dur. */
  private swell(
    r: Rig,
    buffer: AudioBuffer,
    f0: number,
    f1: number,
    q: number,
    peak: number,
    swellAt: number,
    dur: number
  ): void {
    const t = r.ctx.currentTime;
    const src = r.ctx.createBufferSource();
    src.buffer = buffer;
    const bp = r.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = r.ctx.createGain();
    g.gain.setValueAtTime(GAIN_FLOOR, t);
    g.gain.linearRampToValueAtTime(peak, t + swellAt);
    g.gain.exponentialRampToValueAtTime(GAIN_FLOOR, t + dur);
    src.connect(bp).connect(g).connect(r.master);
    src.start(t);
    src.stop(t + dur + 0.05);
    src.onended = () => {
      disconnectAll(src, bp, g);
    };
  }

  /** One-shot slice of the crackle buffer at a deterministic rotating offset. */
  private crackleBurst(r: Rig, hpHz: number, peak: number, dur: number): void {
    const t = r.ctx.currentTime;
    const bufDur = r.crackle.duration;
    this.crackleCursor = (this.crackleCursor + NOISE.CRACKLE_CURSOR_STEP_SEC) % Math.max(0.01, bufDur - dur);
    const src = r.ctx.createBufferSource();
    src.buffer = r.crackle;
    const hp = r.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = hpHz;
    const g = r.ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(GAIN_FLOOR, t + dur);
    src.connect(hp).connect(g).connect(r.master);
    src.start(t, this.crackleCursor, dur + 0.05);
    src.onended = () => {
      disconnectAll(src, hp, g);
    };
  }

  /** Shared looped-roar builder for stream and fan. */
  private makeRoar(
    r: Rig,
    p: {
      buffer: AudioBuffer;
      lp: number;
      gain: number;
      lfoHz: number;
      lfoDepth: number;
      intensityTc: number;
      stopTc: number;
      shimmer: { bp: number; q: number; gain: number; lfoHz: number; lfoDepth: number } | null;
    }
  ): SustainHandle {
    const t = r.ctx.currentTime;
    const src = loopSource(r.ctx, p.buffer);
    const lp = r.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = p.lp;
    const amp = r.ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.setTargetAtTime(p.gain, t, p.intensityTc);
    const { osc: lfo, gain: lfoGain } = makeLfo(r.ctx, p.lfoHz, p.lfoDepth, t);
    lfoGain.connect(amp.gain);
    src.connect(lp).connect(amp).connect(r.master);
    src.start(t);

    const extra: AudioNode[] = [];
    let shimmerLfo: OscillatorNode | null = null;
    if (p.shimmer) {
      const sh = p.shimmer;
      const bp = r.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = sh.bp;
      bp.Q.value = sh.q;
      const shGain = r.ctx.createGain();
      shGain.gain.value = sh.gain / Math.max(0.01, p.gain);
      const shLfo = makeLfo(r.ctx, sh.lfoHz, sh.lfoDepth / Math.max(0.01, p.gain), t);
      shLfo.gain.connect(shGain.gain);
      // Shimmer rides through the same amp so intensity scales it too.
      src.connect(bp).connect(shGain).connect(amp);
      extra.push(bp, shGain, shLfo.gain);
      shimmerLfo = shLfo.osc;
    }

    let stopped = false;
    return {
      setIntensity: (v: number) => {
        if (stopped) return;
        amp.gain.setTargetAtTime(p.gain * clamp01(v), r.ctx.currentTime, p.intensityTc);
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        const now = r.ctx.currentTime;
        amp.gain.cancelScheduledValues(now);
        amp.gain.setTargetAtTime(0, now, p.stopTc);
        const end = now + p.stopTc * 6;
        src.stop(end);
        lfo.stop(end);
        if (shimmerLfo) shimmerLfo.stop(end);
        src.onended = () => {
          disconnectAll(src, lp, amp, lfo, lfoGain, ...extra);
          if (shimmerLfo) shimmerLfo.disconnect();
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Small free helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function loopSource(ctx: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  return src;
}

/** Sine LFO scaled by depth; connect the returned gain to an AudioParam. */
function makeLfo(
  ctx: AudioContext,
  hz: number,
  depth: number,
  when: number
): { osc: OscillatorNode; gain: GainNode } {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = hz;
  const gain = ctx.createGain();
  gain.gain.value = depth;
  osc.connect(gain);
  osc.start(when);
  return { osc, gain };
}

function disconnectAll(...nodes: AudioNode[]): void {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      // Node already released; ignore.
    }
  }
}
