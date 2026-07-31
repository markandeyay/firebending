// Per-move fire VFX (T041, Section 10: "every move has a distinct, named
// effect"). This layer sits between the gesture engine (MoveEvent) and the
// core FireSystem: it maps screen-space gesture events into world space,
// composes the fire emitters into nine named effects, and owns the lifetime
// of every traveling piece (projectiles, streams, walls, whips, charges).
//
// COORDINATE MAPPING (the key design point):
//   Gesture events live in normalized SCREEN space (tracking/types.ts):
//   x grows to the player's right, y grows DOWN, z is negative TOWARD the
//   camera. The world is viewed through the player's own perspective camera,
//   so the mapping that makes "the hand is the crosshair" real is:
//
//     origin: the hand's screen position unprojects onto the REACH PLANE, a
//       plane REACH_PLANE_DISTANCE (~0.8 m) in front of the camera, i.e.
//       roughly where the player's outstretched fist "is" in the scene. The
//       plane's extent is the camera frustum cross-section at that depth, so
//       a hand at the edge of the webcam frame ignites at the edge of the
//       screen. origin.z (depth) is intentionally ignored: depth on the
//       reach plane is fixed, aim depth lives in the direction instead.
//
//     direction: screen-space velocity maps axis-by-axis onto the camera
//       basis. screen -z (punch toward the camera) maps to camera-forward
//       (into the scene, at the enemy), screen +x maps to camera-right,
//       screen +y (down) maps to camera-down. Normalized; a degenerate aim
//       falls back to camera-forward.
//
//   Everything downstream (combat collision, audio panning) can rely on
//   ProjectileEffect.position/velocity being plain world-space values.
//
// Budgets (Section 14): the FireSystem enforces the hard instance caps; this
// layer keeps per-frame spawn counts modest (stream tick <= 6 flames, fan
// tick <= 10) and exposes `intensityScale` (0..1) for the degrade ladder.
// Live projectiles are capped at MAX_LIVE_PROJECTILES (oldest force-expired)
// so the effects registry is bounded under spam.

import * as THREE from 'three';
import type { FireLightHandle, FireSystem } from './fire';
import type { MoveEvent, MoveName } from '../gestures/moves';
import type { Vec3 } from '../tracking/types';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Depth of the reach plane in front of the camera, meters. */
export const REACH_PLANE_DISTANCE = 0.8;
/** Hard lifetime cap on any projectile, seconds. */
export const PROJECTILE_LIFETIME_SEC = 2.5;
/** Live projectile cap; the oldest is force-expired beyond this. */
export const MAX_LIVE_PROJECTILES = 12;
/** Per-tick flame cap for the sustained narrow stream. */
export const STREAM_TICK_FLAME_CAP = 6;
/** Empowered moves scale sizes and spawn counts by this. */
export const EMPOWERED_SCALE = 1.4;
/** Empowered moves scale light intensity by this. */
export const EMPOWERED_LIGHT_SCALE = 1.5;
/** Rising Flame wall parameters (Section 7: blocks projectiles 1.2 s). */
export const WALL_DURATION_SEC = 1.2;
export const WALL_WIDTH = 2.4;
export const WALL_DISTANCE = 1.5;
export const WALL_JET_COUNT = 7;
export const WALL_HEIGHT = 1.8;
/** Fire Whip traveling-pulse duration, seconds. */
export const WHIP_PULSE_SEC = 0.25;
/** Breath Charge ember-gather duration, seconds. */
export const CHARGE_DURATION_SEC = 1.0;
/** Breath Charge stays exposed (consumable) this long, seconds. */
export const CHARGE_WINDOW_SEC = 3.0;
/** A sustained effect with no tick for this long self-terminates, seconds. */
const SUSTAIN_STALE_SEC = 0.6;

/**
 * Every move's distinct, named effect (visual review checklist key). Names
 * are original to this project. Hearth Wave and Ember Fan retired with the
 * 7-move simplification (palm thrusts are Cinder Bolt / Kiln Lance now).
 */
export const EFFECT_NAMES: Readonly<Record<MoveName, string>> = {
  'jab-blast': 'Cinder Bolt',
  'fire-stream': 'Kiln Lance',
  'cross-combo': 'Third Strike Comet',
  'twin-cannon': 'Furnace Shot',
  'rising-flame': 'Kindled Wall',
  'fire-whip': 'Cinder Lash',
  'breath-charge': 'Inner Coal',
};

// ---------------------------------------------------------------------------
// Coordinate mapping
// ---------------------------------------------------------------------------

export interface MappedEvent {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
}

const _q = new THREE.Quaternion();
const _camPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * Map a screen-space gesture (origin: normalized, x right / y DOWN; aim:
 * normalized screen velocity, -z toward camera) into world space. See the
 * module header for the full contract. Returns freshly allocated vectors.
 */
export function screenToWorld(
  origin: Vec3,
  aim: Vec3,
  camera: THREE.PerspectiveCamera,
): { origin: THREE.Vector3; direction: THREE.Vector3 } {
  camera.updateWorldMatrix(true, false);
  camera.getWorldPosition(_camPos);
  camera.getWorldQuaternion(_q);
  _fwd.set(0, 0, -1).applyQuaternion(_q);
  _right.set(1, 0, 0).applyQuaternion(_q);
  _up.set(0, 1, 0).applyQuaternion(_q);

  // Frustum cross-section at the reach plane.
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * REACH_PLANE_DISTANCE;
  const halfW = halfH * camera.aspect;
  const ndcX = origin.x * 2 - 1; // screen x right -> NDC x right
  const ndcY = 1 - origin.y * 2; // screen y DOWN -> NDC y up

  const worldOrigin = new THREE.Vector3()
    .copy(_camPos)
    .addScaledVector(_fwd, REACH_PLANE_DISTANCE)
    .addScaledVector(_right, ndcX * halfW)
    .addScaledVector(_up, ndcY * halfH);

  // Axis map: screen x -> camera right, screen y (down) -> camera-down,
  // screen -z (toward camera) -> camera-forward (into the scene).
  const worldDir = new THREE.Vector3()
    .addScaledVector(_right, aim.x)
    .addScaledVector(_up, -aim.y)
    .addScaledVector(_fwd, -aim.z);
  if (worldDir.lengthSq() < 1e-8) worldDir.copy(_fwd);
  worldDir.normalize();

  return { origin: worldOrigin, direction: worldDir };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fractional spawn-rate accumulator with a per-frame burst clamp. */
class RateAccumulator {
  private acc = 0;
  constructor(private readonly maxPerFrame: number) {}
  take(rate: number, dt: number): number {
    this.acc = Math.min(this.acc + rate * dt, this.maxPerFrame);
    const n = Math.floor(this.acc);
    this.acc -= n;
    return n;
  }
}

export interface CameraShaker {
  shake(intensity: number, durationSec: number): void;
}

/** Public face of every live effect returned by handleEvent. */
export interface EffectHandle {
  readonly move: MoveName;
  /** The effect's display name from EFFECT_NAMES. */
  readonly effectName: string;
  readonly alive: boolean;
}

/** Rising Flame wall exposure for combat blocking checks. */
export interface WallInfo {
  /** MoveEffects clock time (seconds) at which the wall expires. */
  until: number;
  /** Wall center at ground level, world space. */
  center: THREE.Vector3;
  /** Unit vector along the wall span. */
  right: THREE.Vector3;
  /** Unit normal facing the enemies (away from the player). */
  normal: THREE.Vector3;
  halfWidth: number;
  height: number;
}

/** Breath Charge exposure; combat consumes it (MoveEngine owns empowerment). */
export interface ChargeInfo {
  /** MoveEffects clock time (seconds) at which the charge lapses. */
  until: number;
}

// ---------------------------------------------------------------------------
// Effect base
// ---------------------------------------------------------------------------

abstract class BaseEffect implements EffectHandle {
  alive = true;
  constructor(
    readonly move: MoveName,
    protected readonly fx: MoveEffects,
  ) {}

  get effectName(): string {
    return EFFECT_NAMES[this.move];
  }

  abstract update(dt: number): void;

  /** Force-release every held resource. Idempotent. */
  dispose(): void {
    this.alive = false;
  }
}

// ---------------------------------------------------------------------------
// Projectile (the comet: bright core, trailing flames, ember wake, light)
// ---------------------------------------------------------------------------

interface ProjectileParams {
  speed: number;
  size: number;
  empoweredSize: number;
  radius: number;
  coreRate: number;
  trailRate: number;
  emberRate: number;
  perFrameCap: number;
  lightIntensity: number;
  lightRadius: number;
  muzzleFlames: number;
  muzzleEmbers: number;
  muzzleSpread: number;
}

const PROJECTILE_PARAMS: Readonly<
  Record<'jab-blast' | 'cross-combo' | 'twin-cannon', ProjectileParams>
> = {
  // Cinder Bolt: small and fast.
  'jab-blast': {
    speed: 14,
    size: 0.3,
    empoweredSize: 0.45,
    radius: 0.32,
    coreRate: 70,
    trailRate: 40,
    emberRate: 26,
    perFrameCap: 4,
    lightIntensity: 3.2,
    lightRadius: 6,
    muzzleFlames: 8,
    muzzleEmbers: 5,
    muzzleSpread: 0.18,
  },
  // Third Strike Comet: bigger, heavier ember wake.
  'cross-combo': {
    speed: 14,
    size: 0.55,
    empoweredSize: 0.77,
    radius: 0.5,
    coreRate: 85,
    trailRate: 50,
    emberRate: 60,
    perFrameCap: 5,
    lightIntensity: 4.2,
    lightRadius: 7,
    muzzleFlames: 14,
    muzzleEmbers: 12,
    muzzleSpread: 0.26,
  },
  // Furnace Shot: giant and slower.
  'twin-cannon': {
    speed: 11,
    size: 1.1,
    empoweredSize: 1.5,
    radius: 0.95,
    coreRate: 110,
    trailRate: 70,
    emberRate: 80,
    perFrameCap: 6,
    lightIntensity: 6,
    lightRadius: 9,
    muzzleFlames: 26,
    muzzleEmbers: 18,
    muzzleSpread: 0.5,
  },
};

export class ProjectileEffect extends BaseEffect {
  /** Comet head, world space. Combat reads this every frame. */
  readonly position: THREE.Vector3;
  /** World velocity, meters/sec (direction * speed). */
  readonly velocity: THREE.Vector3;
  /** Collision radius, meters. */
  readonly radius: number;
  /** Damage-ish metadata: which move launched this comet. */
  readonly sourceMove: MoveName;
  readonly empowered: boolean;
  /** Called when the projectile times out without hitting anything. */
  onExpire: (() => void) | null = null;

  private age = 0;
  private readonly size: number;
  private light: FireLightHandle | null;
  private readonly coreAcc: RateAccumulator;
  private readonly trailAcc: RateAccumulator;
  private readonly emberAcc: RateAccumulator;
  private readonly params: ProjectileParams;
  /** Previous frame's head position: spawns distribute along the segment. */
  private readonly prevPosition: THREE.Vector3;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly tmp3 = new THREE.Vector3();

  constructor(
    fx: MoveEffects,
    move: MoveName,
    params: ProjectileParams,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    empowered: boolean,
  ) {
    super(move, fx);
    this.sourceMove = move;
    this.params = params;
    this.empowered = empowered;
    this.size = empowered ? params.empoweredSize : params.size;
    this.radius = params.radius * (empowered ? params.empoweredSize / params.size : 1);
    this.position = origin.clone();
    this.prevPosition = origin.clone();
    this.velocity = direction.clone().multiplyScalar(params.speed);
    this.coreAcc = new RateAccumulator(params.perFrameCap);
    this.trailAcc = new RateAccumulator(Math.max(2, params.perFrameCap - 1));
    this.emberAcc = new RateAccumulator(Math.max(2, params.perFrameCap - 1));
    const lightScale = empowered ? EMPOWERED_LIGHT_SCALE : 1;
    this.light = fx.fire.lights.acquire(
      this.position,
      params.lightIntensity * lightScale,
      params.lightRadius,
    );
  }

  update(dt: number): void {
    if (!this.alive) return;
    this.age += dt;
    this.prevPosition.copy(this.position);
    this.position.addScaledVector(this.velocity, dt);
    if (this.age >= PROJECTILE_LIFETIME_SEC) {
      this.expire();
      return;
    }
    const fire = this.fx.fire;
    const rateScale = this.fx.rateScale(this.empowered);

    // SUB-FRAME EMISSION: a fast comet crosses ~0.25 m/frame at 60 fps and
    // far more when a frame hiccups; point-spawning at the head beads the
    // trail. Every spawn below distributes along the segment the head swept
    // THIS frame (prevPosition -> position) with spawn times back-dated
    // across dt, so the ribbon is continuous at any speed and frame rate.
    // Bright core: continuous small hot flames at the head.
    const nCore = this.coreAcc.take(this.params.coreRate * rateScale, dt);
    if (nCore > 0) {
      fire.flames.spawn({
        position: this.position,
        positionEnd: this.prevPosition,
        timeSpread: dt,
        velocity: this.tmp.copy(this.velocity).multiplyScalar(0.18),
        size: this.size,
        lifetime: 0.16,
        count: nCore,
        spread: this.size * 0.16,
        temperature: 0.95, // the comet head is the hottest thing on screen
      });
    }

    // Trailing flames: near-zero velocity so the comet leaves them behind.
    const nTrail = this.trailAcc.take(this.params.trailRate * rateScale, dt);
    if (nTrail > 0) {
      this.tmp3.copy(this.velocity).normalize().multiplyScalar(-this.size * 0.6);
      this.tmp2.copy(this.position).add(this.tmp3);
      this.tmp3.add(this.prevPosition);
      fire.flames.spawn({
        position: this.tmp2,
        positionEnd: this.tmp3,
        timeSpread: dt,
        velocity: this.tmp.copy(this.velocity).multiplyScalar(0.06),
        size: this.size * 0.8,
        lifetime: 0.38,
        count: nTrail,
        spread: this.size * 0.3,
        temperature: 0.72, // cooler than the core: orange wake
      });
    }

    // Ember wake.
    const nEmber = this.emberAcc.take(this.params.emberRate * rateScale, dt);
    if (nEmber > 0) {
      this.tmp.copy(this.velocity).multiplyScalar(0.15);
      this.tmp.y += 0.4;
      fire.embers.spawn({
        position: this.position,
        positionEnd: this.prevPosition,
        timeSpread: dt,
        velocity: this.tmp,
        lifetime: 1.1,
        count: nEmber,
        spread: this.size * 0.5,
      });
    }

    this.light?.move(this.position);
  }

  /**
   * Combat calls this when its collision check lands the comet. Terminates
   * the projectile with a terminal flash at the impact point; the combat
   * layer follows up with ImpactSystem.burst for sparks/scorch/decal.
   */
  onImpact(point: THREE.Vector3, normal: THREE.Vector3): void {
    if (!this.alive) return;
    this.alive = false;
    this.fx.fire.spawnBurst(point, normal, {
      flameCount: this.fx.count(8 + Math.round(this.size * 14), this.empowered),
      emberCount: this.fx.count(6 + Math.round(this.size * 10), this.empowered),
      size: this.size * 0.8,
      speed: 3,
      spread: this.size * 0.6,
      lifetime: 0.3,
      light: false, // this projectile's own light flashes out instead
    });
    this.releaseLight();
  }

  private expire(): void {
    if (!this.alive) return;
    this.alive = false;
    this.releaseLight();
    this.onExpire?.();
  }

  private releaseLight(): void {
    this.light?.release();
    this.light = null;
  }

  override dispose(): void {
    this.alive = false;
    this.releaseLight();
  }
}

// ---------------------------------------------------------------------------
// Sustained cone (Kiln Lance). Steerable: origin and
// aim are re-mapped on every sustain-tick.
// ---------------------------------------------------------------------------

interface SustainParams {
  flamesPerTick: number;
  flameCap: number;
  embersPerTick: number;
  speed: number;
  size: number;
  lifetime: number;
  spread: number;
  muzzleOffset: number;
  /** Light position along the beam, meters from the origin. */
  lightAlong: number;
  lightIntensity: number;
  lightRadius: number;
}

const STREAM_PARAMS: SustainParams = {
  flamesPerTick: 5,
  flameCap: STREAM_TICK_FLAME_CAP,
  embersPerTick: 2,
  speed: 9,
  size: 0.32,
  lifetime: 0.4,
  spread: 0.09,
  muzzleOffset: 0.15,
  lightAlong: 2,
  lightIntensity: 3.2,
  lightRadius: 7,
};

class SustainedConeEffect extends BaseEffect {
  private light: FireLightHandle | null;
  private lastTickTime: number;
  private readonly empowered: boolean;
  private readonly params: SustainParams;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(
    move: MoveName,
    fx: MoveEffects,
    params: SustainParams,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    empowered: boolean,
  ) {
    super(move, fx);
    this.params = params;
    this.empowered = empowered;
    this.lastTickTime = fx.time;
    const lightScale = empowered ? EMPOWERED_LIGHT_SCALE : 1;
    this.light = fx.fire.lights.acquire(
      this.tmp.copy(origin).addScaledVector(direction, params.lightAlong),
      params.lightIntensity * lightScale,
      params.lightRadius,
    );
  }

  /** Per sustain-tick: spawn the cone slice along the CURRENT aim. */
  tick(origin: THREE.Vector3, direction: THREE.Vector3): void {
    if (!this.alive) return;
    this.lastTickTime = this.fx.time;
    const p = this.params;
    const fire = this.fx.fire;
    const scale = this.empowered ? EMPOWERED_SCALE : 1;

    const muzzle = this.tmp.copy(origin).addScaledVector(direction, p.muzzleOffset);
    const nFlames = Math.min(p.flameCap, this.fx.count(p.flamesPerTick, this.empowered));
    fire.flames.spawn({
      position: muzzle,
      velocity: this.tmp2.copy(direction).multiplyScalar(p.speed),
      size: p.size * scale,
      lifetime: p.lifetime,
      count: nFlames,
      spread: p.spread,
    });

    const nEmbers = this.fx.count(p.embersPerTick, this.empowered);
    this.tmp2.copy(direction).multiplyScalar(p.speed * 0.45);
    this.tmp2.y += 0.4;
    fire.embers.spawn({
      position: muzzle,
      velocity: this.tmp2,
      lifetime: 1.2,
      count: nEmbers,
      spread: p.spread * 1.2,
    });

    this.light?.move(this.tmp.copy(origin).addScaledVector(direction, p.lightAlong));
  }

  /** sustain-end (or safety timeout): release the light, go dead. */
  end(): void {
    if (!this.alive) return;
    this.alive = false;
    this.light?.release();
    this.light = null;
  }

  update(_dt: number): void {
    // Safety: if the engine somehow never sends sustain-end (tracking loss
    // mid-teardown), a stale cone must not hold a pool light forever.
    if (this.alive && this.fx.time - this.lastTickTime > SUSTAIN_STALE_SEC) this.end();
  }

  override dispose(): void {
    this.end();
  }
}

// ---------------------------------------------------------------------------
// Kindled Wall (Rising Flame): a row of upward flame jets in front of the
// player, sustained by continuous spawns for WALL_DURATION_SEC.
// ---------------------------------------------------------------------------

class WallEffect extends BaseEffect {
  readonly info: WallInfo;
  private light: FireLightHandle | null;
  private readonly empowered: boolean;
  private readonly jets: THREE.Vector3[] = [];
  private cursor = 0;
  private readonly flameAcc = new RateAccumulator(10);
  private readonly emberAcc = new RateAccumulator(3);
  private readonly tmp = new THREE.Vector3();

  constructor(fx: MoveEffects, camera: THREE.PerspectiveCamera, empowered: boolean) {
    super('rising-flame', fx);
    this.empowered = empowered;

    // The wall stands WALL_DISTANCE ahead of the player on the ground plane,
    // spanning WALL_WIDTH along the camera's horizontal right axis.
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(_camPos);
    camera.getWorldQuaternion(_q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_q);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const center = new THREE.Vector3(_camPos.x, 0, _camPos.z).addScaledVector(fwd, WALL_DISTANCE);

    this.info = {
      until: fx.time + WALL_DURATION_SEC,
      center,
      right,
      normal: fwd,
      halfWidth: WALL_WIDTH / 2,
      height: WALL_HEIGHT,
    };
    for (let i = 0; i < WALL_JET_COUNT; i++) {
      const s = i / Math.max(1, WALL_JET_COUNT - 1) - 0.5;
      this.jets.push(center.clone().addScaledVector(right, s * WALL_WIDTH));
    }
    this.light = fx.fire.lights.acquire(
      this.tmp.copy(center).setY(0.9),
      4 * (empowered ? EMPOWERED_LIGHT_SCALE : 1),
      7,
    );
  }

  update(dt: number): void {
    if (!this.alive) return;
    if (this.fx.time >= this.info.until) {
      this.dispose();
      return;
    }
    const fire = this.fx.fire;
    const scale = this.empowered ? EMPOWERED_SCALE : 1;
    const rateScale = this.fx.rateScale(this.empowered);

    // Round-robin the jets so the whole row stays lit at any spawn budget.
    const nFlames = this.flameAcc.take(112 * rateScale, dt);
    for (let i = 0; i < nFlames; i++) {
      const jet = this.jets[this.cursor % this.jets.length];
      this.cursor++;
      if (!jet) continue;
      fire.flames.spawn({
        position: jet,
        velocity: this.tmp.set(0, 3.2, 0),
        size: 0.45 * scale,
        lifetime: 0.5,
        count: 1,
        spread: 0.12,
      });
    }

    const nEmbers = this.emberAcc.take(14 * rateScale, dt);
    if (nEmbers > 0) {
      fire.embers.spawn({
        position: this.info.center,
        velocity: this.tmp.set(0, 1.4, 0),
        lifetime: 1.8,
        count: nEmbers,
        spread: this.info.halfWidth,
      });
    }
  }

  override dispose(): void {
    this.alive = false;
    this.light?.release();
    this.light = null;
  }
}

// ---------------------------------------------------------------------------
// Cinder Lash (Fire Whip): a quadratic arc cracked out over WHIP_PULSE_SEC
// as a traveling pulse of flame spawns, ember burst at the tip.
// ---------------------------------------------------------------------------

class WhipEffect extends BaseEffect {
  private age = 0;
  private prevU = 0;
  private cracked = false;
  private light: FireLightHandle | null;
  private readonly empowered: boolean;
  private readonly p0: THREE.Vector3;
  private readonly p1: THREE.Vector3;
  private readonly p2: THREE.Vector3;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(
    fx: MoveEffects,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    empowered: boolean,
  ) {
    super('fire-whip', fx);
    this.empowered = empowered;
    const reach = empowered ? 2.3 * EMPOWERED_SCALE : 2.3;
    this.p0 = origin.clone();
    this.p1 = origin
      .clone()
      .addScaledVector(direction, reach * 0.5)
      .add(new THREE.Vector3(0, 0.55, 0));
    this.p2 = origin.clone().addScaledVector(direction, reach).add(new THREE.Vector3(0, -0.1, 0));
    this.light = fx.fire.lights.acquire(
      this.p0,
      3.4 * (empowered ? EMPOWERED_LIGHT_SCALE : 1),
      6,
    );
  }

  private bezier(u: number, out: THREE.Vector3): THREE.Vector3 {
    const a = (1 - u) * (1 - u);
    const b = 2 * (1 - u) * u;
    const c = u * u;
    return out.set(
      a * this.p0.x + b * this.p1.x + c * this.p2.x,
      a * this.p0.y + b * this.p1.y + c * this.p2.y,
      a * this.p0.z + b * this.p1.z + c * this.p2.z,
    );
  }

  update(dt: number): void {
    if (!this.alive) return;
    this.age += dt;
    const u = Math.min(1, this.age / WHIP_PULSE_SEC);
    const fire = this.fx.fire;
    const scale = this.empowered ? EMPOWERED_SCALE : 1;

    // Fast sequential spawns from the previous pulse position to the new one.
    const STEP = 0.08;
    for (let s = this.prevU; s < u; s += STEP) {
      const pos = this.bezier(s, this.tmp);
      // Tangent (derivative) gives the lick direction along the arc.
      this.tmp2
        .set(
          2 * (1 - s) * (this.p1.x - this.p0.x) + 2 * s * (this.p2.x - this.p1.x),
          2 * (1 - s) * (this.p1.y - this.p0.y) + 2 * s * (this.p2.y - this.p1.y),
          2 * (1 - s) * (this.p1.z - this.p0.z) + 2 * s * (this.p2.z - this.p1.z),
        )
        .normalize()
        .multiplyScalar(2.2);
      fire.flames.spawn({
        position: pos,
        velocity: this.tmp2,
        size: 0.38 * scale,
        lifetime: 0.45,
        count: this.fx.count(3, this.empowered),
        spread: 0.06,
        // The lash heats toward the tip: the crack end burns white-hot.
        temperature: 0.72 + 0.24 * s,
      });
    }
    this.prevU = u;
    this.light?.move(this.bezier(u, this.tmp));

    if (u >= 1 && !this.cracked) {
      // The crack: ember burst at the tip.
      this.cracked = true;
      this.tmp2.subVectors(this.p2, this.p1).normalize().multiplyScalar(4.5);
      this.tmp2.y += 1.2;
      fire.embers.spawn({
        position: this.p2,
        velocity: this.tmp2,
        lifetime: 0.8,
        count: this.fx.count(18, this.empowered),
        spread: 0.22,
        temperature: 0.9, // white-hot crack spray
      });
    }
    if (this.age >= WHIP_PULSE_SEC + 0.1) this.dispose();
  }

  override dispose(): void {
    this.alive = false;
    this.light?.release();
    this.light = null;
  }
}

// ---------------------------------------------------------------------------
// Inner Coal (Breath Charge): embers converge INWARD onto the fists over
// CHARGE_DURATION_SEC with a small pulsing light.
// ---------------------------------------------------------------------------

class ChargeEffect extends BaseEffect {
  private age = 0;
  private k = 0;
  private light: FireLightHandle | null;
  private readonly acc = new RateAccumulator(4);
  private readonly origin: THREE.Vector3;
  private readonly right: THREE.Vector3;
  private readonly baseIntensity: number;
  private readonly rng = mulberry32(0xc0a1);
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(fx: MoveEffects, origin: THREE.Vector3, camera: THREE.PerspectiveCamera) {
    super('breath-charge', fx);
    this.origin = origin.clone();
    camera.getWorldQuaternion(_q);
    this.right = new THREE.Vector3(1, 0, 0).applyQuaternion(_q).setY(0).normalize();
    this.baseIntensity = 1.6;
    this.light = fx.fire.lights.acquire(this.origin, this.baseIntensity, 4);
  }

  update(dt: number): void {
    if (!this.alive) return;
    this.age += dt;
    if (this.age >= CHARGE_DURATION_SEC) {
      this.dispose();
      return;
    }
    const FLIGHT = 0.45; // seconds from ring to fist; lifetime matches, so
    // embers wink out exactly as they arrive (motion is shader-side linear).
    const n = this.acc.take(46 * this.fx.rateScale(false), dt);
    for (let i = 0; i < n; i++) {
      // Alternate the gather between the two fists (offset along camera x).
      const side = this.k++ % 2 === 0 ? 1 : -1;
      const base = this.tmp.copy(this.origin).addScaledVector(this.right, side * 0.22);
      const ang = this.rng() * Math.PI * 2;
      const rad = 0.3 + this.rng() * 0.3;
      this.tmp2.set(
        base.x + Math.cos(ang) * rad,
        base.y + (this.rng() - 0.5) * 0.5,
        base.z + Math.sin(ang) * rad,
      );
      const vel = this.tmp.copy(base).sub(this.tmp2).divideScalar(FLIGHT);
      this.fx.fire.embers.spawn({
        position: this.tmp2,
        velocity: vel,
        lifetime: FLIGHT,
        size: 0.05,
        count: 1,
        // Hot and tight: gathered embers must not sink or scatter mid-flight
        // (temperature drives buoyancy in the ember shader).
        temperature: 0.95,
      });
    }
    // Small pulsing light at the fists.
    this.light?.setIntensity(this.baseIntensity * (0.75 + 0.35 * Math.sin(this.age * 14)));
  }

  override dispose(): void {
    this.alive = false;
    this.light?.release();
    this.light = null;
  }
}

// ---------------------------------------------------------------------------
// MoveEffects: the dispatcher
// ---------------------------------------------------------------------------

export class MoveEffects {
  readonly scene: THREE.Group | THREE.Scene;
  readonly fire: FireSystem;
  /**
   * Degrade-ladder hook (Section 14): 0..1 multiplier on every spawn count
   * and rate. 1 = full fidelity.
   */
  intensityScale = 1;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly rig: CameraShaker | undefined;
  private readonly effects: BaseEffect[] = [];
  private readonly projectileList: ProjectileEffect[] = [];
  private readonly sustains = new Map<string, SustainedConeEffect>();
  private wall: WallEffect | null = null;
  private charge: ChargeEffect | null = null;
  private chargeUntil: number | null = null;
  private clock = 0;

  constructor(
    scene: THREE.Group | THREE.Scene,
    fire: FireSystem,
    camera: THREE.PerspectiveCamera,
    rig?: CameraShaker,
  ) {
    this.scene = scene;
    this.fire = fire;
    this.camera = camera;
    this.rig = rig;
  }

  /** MoveEffects clock, seconds. WallInfo.until / ChargeInfo.until use it. */
  get time(): number {
    return this.clock;
  }

  /** Live projectiles for combat's collision sweep. */
  get projectiles(): readonly ProjectileEffect[] {
    return this.projectileList;
  }

  /** Rising Flame wall, or null when none is up (combat blocking checks). */
  get activeWall(): WallInfo | null {
    if (this.wall && this.wall.alive && this.clock < this.wall.info.until) {
      return this.wall.info;
    }
    return null;
  }

  /** Breath Charge exposure until consumed by the next move or lapsed. */
  get chargeActive(): ChargeInfo | null {
    if (this.chargeUntil !== null && this.clock < this.chargeUntil) {
      return { until: this.chargeUntil };
    }
    return null;
  }

  /** Number of live effects in the registry (bounded; for tests/debug). */
  get effectCount(): number {
    return this.effects.length;
  }

  /** Internal: spawn-count scaling (degrade ladder + empowerment). */
  count(base: number, empowered: boolean): number {
    const scaled = base * this.intensityScale * (empowered ? EMPOWERED_SCALE : 1);
    return Math.max(1, Math.round(scaled));
  }

  /** Internal: continuous-rate scaling (degrade ladder + empowerment). */
  rateScale(empowered: boolean): number {
    return this.intensityScale * (empowered ? EMPOWERED_SCALE : 1);
  }

  /**
   * Dispatch one MoveEvent to its effect. Returns the live effect handle, or
   * null when the move/kind combination is not one this layer produces
   * (e.g. a sustain-tick with no active sustain). Never throws on odd input.
   */
  handleEvent(e: MoveEvent): EffectHandle | null {
    // Any other move igniting consumes the exposed charge (the MoveEngine
    // owns the actual empowerment; this is the VFX-side mirror of it).
    if (
      e.move !== 'breath-charge' &&
      (e.kind === 'trigger' || e.kind === 'sustain-start')
    ) {
      this.chargeUntil = null;
    }

    switch (e.move) {
      case 'jab-blast':
        if (e.kind !== 'trigger') return null;
        this.rig?.shake(0.05, 0.12);
        return this.launchProjectile(e, PROJECTILE_PARAMS['jab-blast']);

      case 'cross-combo':
        if (e.kind !== 'trigger') return null;
        this.rig?.shake(0.12, 0.2);
        return this.launchProjectile(e, PROJECTILE_PARAMS['cross-combo']);

      case 'twin-cannon': {
        if (e.kind !== 'trigger') return null;
        // Combat owns the 120 ms hit-stop and kill slow-mo; here it is only
        // the launch weight: big muzzle burst plus a heavy shake.
        this.rig?.shake(0.35, 0.45);
        return this.launchProjectile(e, PROJECTILE_PARAMS['twin-cannon']);
      }

      case 'fire-stream':
        return this.handleSustain(e, STREAM_PARAMS);

      case 'rising-flame': {
        if (e.kind !== 'trigger') return null;
        this.wall?.dispose();
        this.wall = new WallEffect(this, this.camera, e.empowered);
        return this.add(this.wall);
      }

      case 'fire-whip': {
        if (e.kind !== 'trigger') return null;
        const m = screenToWorld(e.origin, e.aim, this.camera);
        this.rig?.shake(0.15, 0.2);
        return this.add(new WhipEffect(this, m.origin, m.direction, e.empowered));
      }

      case 'breath-charge': {
        if (e.kind !== 'trigger') return null;
        const m = screenToWorld(e.origin, e.aim, this.camera);
        this.charge?.dispose();
        this.charge = new ChargeEffect(this, m.origin, this.camera);
        this.chargeUntil = this.clock + CHARGE_WINDOW_SEC;
        return this.add(this.charge);
      }

      default:
        return null;
    }
  }

  /** Advance every live effect and prune the dead. Call once per frame. */
  update(dt: number): void {
    this.clock += dt;
    for (const fxE of this.effects) fxE.update(dt);

    // Prune dead effects (registry stays bounded by construction).
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const eff = this.effects[i];
      if (eff && !eff.alive) this.effects.splice(i, 1);
    }
    for (let i = this.projectileList.length - 1; i >= 0; i--) {
      const p = this.projectileList[i];
      if (p && !p.alive) this.projectileList.splice(i, 1);
    }
    for (const [key, s] of this.sustains) {
      if (!s.alive) this.sustains.delete(key);
    }
    if (this.wall && !this.wall.alive) this.wall = null;
    if (this.charge && !this.charge.alive) this.charge = null;
    if (this.chargeUntil !== null && this.clock >= this.chargeUntil) this.chargeUntil = null;
  }

  dispose(): void {
    for (const e of this.effects) e.dispose();
    this.effects.length = 0;
    this.projectileList.length = 0;
    this.sustains.clear();
    this.wall = null;
    this.charge = null;
    this.chargeUntil = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private add<T extends BaseEffect>(effect: T): T {
    this.effects.push(effect);
    return effect;
  }

  private launchProjectile(e: MoveEvent, params: ProjectileParams): ProjectileEffect {
    const m = screenToWorld(e.origin, e.aim, this.camera);

    // Muzzle burst at the hand (no pooled light: the comet carries its own).
    this.fire.spawnBurst(m.origin, m.direction, {
      flameCount: this.count(params.muzzleFlames, e.empowered),
      emberCount: this.count(params.muzzleEmbers, e.empowered),
      size: (e.empowered ? params.empoweredSize : params.size) * 0.9,
      speed: 3,
      spread: params.muzzleSpread,
      lifetime: 0.25,
      light: false,
    });

    const p = new ProjectileEffect(this, e.move, params, m.origin, m.direction, e.empowered);
    // Bound live projectiles: force-expire the oldest beyond the cap.
    while (this.projectileList.length >= MAX_LIVE_PROJECTILES) {
      const oldest = this.projectileList.shift();
      oldest?.dispose();
    }
    this.projectileList.push(p);
    return this.add(p);
  }

  private handleSustain(e: MoveEvent, params: SustainParams): EffectHandle | null {
    const key = `${e.move}:${e.hand}`;
    const existing = this.sustains.get(key);

    switch (e.kind) {
      case 'sustain-start': {
        existing?.end();
        const m = screenToWorld(e.origin, e.aim, this.camera);
        const s = new SustainedConeEffect(e.move, this, params, m.origin, m.direction, e.empowered);
        s.tick(m.origin, m.direction); // ignition slice on the start frame
        this.sustains.set(key, s);
        return this.add(s);
      }
      case 'sustain-tick': {
        if (!existing || !existing.alive) return null; // orphan tick, ignore
        const m = screenToWorld(e.origin, e.aim, this.camera); // steerable
        existing.tick(m.origin, m.direction);
        return existing;
      }
      case 'sustain-end': {
        if (!existing) return null;
        existing.end();
        this.sustains.delete(key);
        return existing;
      }
      default:
        return null; // a bare 'trigger' for a sustained move is not a thing
    }
  }
}
