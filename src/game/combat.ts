/**
 * Combat resolution (T051, spec Sections 7, 8, 11): the damage bookkeeping
 * layer between the move engine (MoveEvent), the VFX layer (traveling
 * projectiles, the Rising Flame wall) and the constructs (hp, wobble
 * impulses). Runs fully headless; three.js is used for vector math only.
 *
 * INTEGRATION CONTRACT (director / main loop):
 *   Per frame, in order:
 *     1. manager.update(dt)            (physics, coal arcs, coal arrivals)
 *     2. effects.update(dt)            (VFX projectiles advance)
 *     3. combat.update(dt, frame?)     (hit detection, coal defense)
 *   plus combat.handleMoveEvent(e) for every event the MoveEngine emitted
 *   this frame (before combat.update is fine; ordering within the frame does
 *   not matter to the bookkeeping).
 *
 *   Ownership: CombatSystem claims manager.onDeath (kill counting) and
 *   construct.onProjectileArrive (coal defense) for every construct it sees.
 *   Downstream consumers (director) subscribe to combat.onKill instead of
 *   manager.onDeath.
 *
 *   EffectsProvider is a structural (duck-typed) interface so this module
 *   never imports src/vfx/moveEffects.ts. Adapting the real MoveEffects:
 *     const provider: EffectsProvider = {
 *       get projectiles() { return fx.projectiles; },
 *       wallActiveUntil: () => (fx.activeWall ? fx.activeWall.until : null),
 *     };
 *   The wall is considered ACTIVE whenever wallActiveUntil() returns a
 *   non-null value; the number itself is informational (the provider's own
 *   clock) and is never compared against the combat clock, because the VFX
 *   clock (seconds since construction) and the gesture clock (ms since
 *   source start) share no epoch.
 *
 *   Player hits: the player has no HP bar in the demo. A coal that lands in
 *   the player zone calls onPlayerHit(COAL_DAMAGE) (wire it to
 *   HUD.playerHitFlash and any screen-edge feedback) and
 *   onBreathPenalty(PLAYER_HIT_BREATH_PENALTY). MoveEngine currently has no
 *   public method to spend Breath externally, so the integration wiring must
 *   apply the penalty itself (either by adding a small `spend(amount)` to
 *   MoveEngine at integration time or by tracking a HUD-side debit). This is
 *   deliberately exposed as a callback so combat stays decoupled.
 *
 * COORDINATES (Phase 5, courtyard stations): MoveEvent.aim/origin are
 * normalized screen space (x right, y DOWN, z negative toward the camera).
 * The player is physically planted and never turns, but each station puts
 * the camera at a different world position/orientation, so the mapping is
 * CAMERA-RELATIVE: screen -z maps to the camera's forward at the current
 * station, screen x to camera-right, screen y (down) to camera-down. The
 * camera base pose (undeflected by parallax/shake) comes from the injected
 * CameraPoseProvider (deps.cameraPose, wired to CameraRig.basePosition /
 * baseQuaternion at integration). Without a provider the legacy fixed frame
 * applies: position PLAYER_WORLD_POSITION (or deps.playerPosition) looking
 * down world -z, which keeps the original tests' fixed-lane semantics.
 * Coal defense (wall plane, player zone) is expressed in the same camera
 * frame; duck detection is screen-space and unaffected.
 */

import * as THREE from 'three';
import type { LandmarkFrame, PoseFrame, Vec3 } from '../tracking/types';
import { verticalCenterOfMass } from '../tracking/body';
import { EMPOWER_MULTIPLIER, type MoveEvent, type MoveName } from '../gestures/moves';
import type { Construct, ConstructManager } from './enemies';

// ---------------------------------------------------------------------------
// Damage table (spec Section 7 semantics)
// ---------------------------------------------------------------------------

export interface MoveDamageSpec {
  /** Hit points removed per impact, or per second when perSecond is true. */
  damage: number;
  /** Knockback impulse magnitude (N*s) applied along the hit direction. */
  impulse: number;
  /** True for sustained moves whose damage applies via sustain ticks. */
  perSecond: boolean;
}

/**
 * Per Section 7, folded to the 7-move set (palm-wave and flame-fan retired
 * with the pose-agnostic thrust simplification): jab light; cross-combo
 * bigger plus knockback; stream sustained per-second ticks; twin-cannon
 * huge with hit-stop; whip medium; rising-flame purely defensive;
 * breath-charge deals nothing itself (it empowers the next move by
 * EMPOWER_MULTIPLIER, applied here to whatever it empowered).
 */
export const DAMAGE_TABLE: Readonly<Record<MoveName, MoveDamageSpec>> = {
  'jab-blast': { damage: 8, impulse: 0, perSecond: false },
  'cross-combo': { damage: 18, impulse: 20, perSecond: false },
  'fire-stream': { damage: 14, impulse: 0, perSecond: true },
  'twin-cannon': { damage: 42, impulse: 40, perSecond: false },
  'rising-flame': { damage: 0, impulse: 0, perSecond: false },
  'fire-whip': { damage: 16, impulse: 14, perSecond: false },
  'breath-charge': { damage: 0, impulse: 0, perSecond: false },
};

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Default planted player position (Section 2: never moves). */
export const PLAYER_WORLD_POSITION = new THREE.Vector3(0, 1.4, 0);

/** Construct torso approximated as a sphere at chest height (T050 capsule). */
export const CHEST_HEIGHT = 1.25;
export const CHEST_RADIUS = 0.55;

/** Fire Whip: melee arc reach and lateral tolerance around dead ahead. */
export const WHIP_RANGE = 4.0;
export const WHIP_LATERAL_TOLERANCE = 0.75;
/** |world aim x| below this treats the swing as a full frontal arc. */
const WHIP_MIN_LATERAL_AIM = 0.35;

/** Sustained beam: max ray length and radius of the fire-stream. */
export const STREAM_RANGE = 14.0;
export const STREAM_BEAM_RADIUS = 0.25;

/** Twin Cannon feel (Section 7): 120 ms hit-stop, slow-mo on kill. */
export const TWIN_HIT_STOP_MS = 120;
export const KILL_SLOWMO_SCALE = 0.25;
export const KILL_SLOWMO_MS = 500;

/** Incoming coals (Section 8): damage, breath penalty, player zone plane. */
export const COAL_DAMAGE = 8;
export const PLAYER_HIT_BREATH_PENALTY = 15;
/** A coal landing with z greater than playerZ + PLAYER_ZONE_Z is a threat. */
export const PLAYER_ZONE_Z = -1.0;

/** Rising Flame wall blocking region: a plane about 2 m ahead of the player. */
export const WALL_PLANE_AHEAD = 2.0;
export const WALL_HALF_WIDTH = 2.5;
export const WALL_TOP = 3.0;

/** A pending projectile empowerment lapses after this long (ms). */
const PENDING_EMPOWER_TTL_MS = 3000;
/**
 * Fallback dt for a sustain tick that arrives with NO prior tick clock (a
 * defensive path: the engine always emits sustain-start first, and every
 * later tick derives dt from measured timestamps). Was one 30 fps frame
 * (33 ms), which silently undercounted the first tick's damage on the real
 * ~14 fps capture cadence; 70 ms matches one frame at that measured
 * cadence, keeping the fallback frame-rate-honest.
 */
const DEFAULT_TICK_MS = 70;
/** Sustain tick dt clamp, seconds (a long hitch must not dump damage). */
const MAX_TICK_SEC = 0.25;

/** Samples averaged into a duck baseline when uncalibrated. */
const DUCK_BASELINE_SAMPLES = 45;

/** A torso (pose) sample older than this falls back to the head-y duck. */
const TORSO_STALE_MS = 1000;

// ---------------------------------------------------------------------------
// Duck detection (Section 8: body drop > 20% of baseline within 0.4 s)
// ---------------------------------------------------------------------------

export const DUCK_DROP_FRACTION = 0.2;
export const DUCK_WINDOW_MS = 400;
/** Un-ducks once the tracked point is back within this fraction of baseline. */
export const DUCK_RECOVER_FRACTION = 0.1;
/** The point must sit at least this far below baseline to count as ducked. */
export const DUCK_MIN_ABS_FRACTION = 0.15;

/**
 * Torso center y from body pose: the weighted vertical center of mass
 * (src/tracking/body.ts, hip-heavy 0.4 shoulder / 0.6 hip), normalized
 * screen space (y grows DOWN). The PREFERRED duck input: the torso is rigid
 * and cannot fake a duck by nodding (head-y fallback can), and the hip
 * weighting means a bow from the waist (shoulders only dropping) reads
 * weaker than a real knees-bent duck. Pure; kept as the combat-layer name
 * for the shared body signal.
 */
export function torsoCenterY(pose: PoseFrame): number {
  return verticalCenterOfMass(pose);
}

/**
 * Pure duck detector over any vertical body signal (torso center y from
 * pose, or head y from face tracking as fallback). y is normalized screen
 * space where y grows DOWN, so ducking (the body physically dropping) means
 * y INCREASES. "Drop > 20% of baseline within 0.4 s" therefore reads:
 * current y minus the smallest y in the trailing 400 ms window exceeds
 * 0.2 * baselineY, with the point actually below the baseline (not just
 * wobbling around it). The ducked state holds until the point returns to
 * within 10% of the baseline, the y-down equivalent of "returns above 90%
 * of the calibrated baseline height".
 */
export class DuckDetector {
  private readonly baselineY: number;
  private history: Array<{ t: number; y: number }> = [];
  private ducked = false;

  constructor(baselineY: number) {
    this.baselineY = baselineY;
  }

  get isDucked(): boolean {
    return this.ducked;
  }

  /** Feed one head-y sample; returns the current ducked state. */
  update(headY: number, tMs: number): boolean {
    const last = this.history[this.history.length - 1];
    if (last && tMs < last.t) this.history = []; // clock went backwards: reset
    this.history.push({ t: tMs, y: headY });
    while (this.history.length > 0) {
      const first = this.history[0];
      if (first && tMs - first.t > DUCK_WINDOW_MS) this.history.shift();
      else break;
    }

    const b = this.baselineY;
    if (this.ducked) {
      if (headY - b < DUCK_RECOVER_FRACTION * b) this.ducked = false;
    } else {
      let minY = headY;
      for (const s of this.history) {
        if (s.y < minY) minY = s.y;
      }
      const fastDrop = headY - minY > DUCK_DROP_FRACTION * b;
      const wellBelow = headY - b > DUCK_MIN_ABS_FRACTION * b;
      if (fastDrop && wellBelow) this.ducked = true;
    }
    return this.ducked;
  }
}

// ---------------------------------------------------------------------------
// Structural interfaces (wired to src/vfx/moveEffects.ts at integration)
// ---------------------------------------------------------------------------

/** Shape of a traveling VFX projectile; matches vfx ProjectileEffect. */
export interface ProjectileEffectLike {
  /** Live world position of the comet head. */
  readonly position: THREE.Vector3;
  /** Collision radius, meters. */
  readonly radius: number;
  /** Which move launched it (indexes DAMAGE_TABLE). */
  readonly sourceMove: MoveName;
  /**
   * Optional empowered flag carried by the VFX layer. When absent, combat
   * falls back to its own pending-empower bookkeeping fed by MoveEvents.
   */
  readonly empowered?: boolean;
  /** VFX-side terminal flash; combat calls it exactly once per hit. */
  onImpact(point: THREE.Vector3, normal: THREE.Vector3): void;
}

export interface EffectsProvider {
  readonly projectiles: readonly ProjectileEffectLike[];
  /**
   * Non-null while the Rising Flame wall is up. The value is the provider's
   * own expiry stamp and is treated as opaque (see module header).
   */
  wallActiveUntil(): number | null;
}

/** Impact feedback layer (src/vfx/impact.ts), duck-typed. */
export interface ImpactsLike {
  burst(position: THREE.Vector3, normal: THREE.Vector3, strength: number): void;
}

/**
 * The rig's undeflected base pose, injected as a provider so combat never
 * imports the camera rig. Integration wires it to CameraRig.basePositionRef /
 * baseQuaternionRef (allocation-free views; combat copies into scratch every
 * frame and never mutates them).
 */
export interface CameraPoseProvider {
  /** Current undeflected camera base position (the planted player's eye). */
  position(): Readonly<THREE.Vector3>;
  /** Current undeflected camera base orientation. */
  quaternion(): Readonly<THREE.Quaternion>;
}

/** Fixed-frame provider: `position` looking down world -z. */
export function fixedCameraPose(position: THREE.Vector3): CameraPoseProvider {
  const pos = position.clone();
  const quat = new THREE.Quaternion(); // identity: forward is world -z
  return {
    position: () => pos,
    quaternion: () => quat,
  };
}

export interface CombatDeps {
  manager: ConstructManager;
  effects: EffectsProvider;
  /**
   * Camera base pose provider (Phase 5 stations). Aim mapping, coal wall
   * blocking and the player hit zone all follow this pose. Defaults to a
   * fixed pose at deps.playerPosition ?? PLAYER_WORLD_POSITION, forward -z.
   */
  cameraPose?: CameraPoseProvider;
  /**
   * A discrete projectile resolved against a construct (same site where the
   * VFX impact/spark burst spawns). Wire to a small camera-shake kick so
   * jabs land with physical weight. Position is a clone; damage is the
   * final amount dealt (empowerment applied).
   */
  onImpact?: (position: THREE.Vector3, damage: number) => void;
  /** Twin Cannon impact freeze, milliseconds. */
  onHitStop?: (ms: number) => void;
  /** Kill slow-mo: time scale and duration in milliseconds. */
  onSlowMo?: (scale: number, ms: number) => void;
  /** A coal reached the player: drive HUD flash / screen-edge feedback. */
  onPlayerHit?: (damage: number) => void;
  /** Breath penalty on player hit; see module header for wiring notes. */
  onBreathPenalty?: (amount: number) => void;
  impacts?: ImpactsLike;
  /** Overrides PLAYER_WORLD_POSITION. */
  playerPosition?: THREE.Vector3;
  /** Calibrated neutral head y (screen space). Auto-sampled when omitted. */
  headBaselineY?: number;
}

// ---------------------------------------------------------------------------
// Screen-to-world helpers (combat's own mapping; VFX has a camera-accurate
// one, combat only needs hit-test geometry)
// ---------------------------------------------------------------------------

/** Approximate world reach of the normalized hand-position box, meters. */
const ORIGIN_SPAN_X = 1.2;
const ORIGIN_SPAN_Y = 1.0;

const IDENTITY_QUAT = new THREE.Quaternion();

/**
 * Map a screen-space aim direction into a normalized world direction.
 * `cameraQuat` is the camera base orientation at the current station: screen
 * -z maps to that camera's forward. Omitted (identity) it reduces to the
 * legacy fixed-lane mapping (world -z forward).
 */
export function screenAimToWorld(
  aim: Vec3,
  cameraQuat: THREE.Quaternion = IDENTITY_QUAT,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  out.set(aim.x, -aim.y, aim.z);
  if (out.lengthSq() < 1e-10) out.set(0, 0, -1);
  return out.normalize().applyQuaternion(cameraQuat);
}

/**
 * Map a screen-space wrist origin to a world beam origin near the player:
 * offsets from the screen center run along the camera's right/up axes.
 */
export function beamOriginToWorld(
  origin: Vec3,
  playerPos: THREE.Vector3,
  cameraQuat: THREE.Quaternion = IDENTITY_QUAT,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  out.set(
    (origin.x - 0.5) * ORIGIN_SPAN_X,
    -(origin.y - 0.5) * ORIGIN_SPAN_Y,
    0,
  );
  return out.applyQuaternion(cameraQuat).add(playerPos);
}

// ---------------------------------------------------------------------------
// CombatSystem
// ---------------------------------------------------------------------------

interface ProjectileBook {
  prev: THREE.Vector3;
  consumed: boolean;
}

interface SustainBook {
  lastT: number;
  empowered: boolean;
}

// Shared scratch vectors (single threaded; callbacks receive clones).
const _center = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _dirLocal = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _impulse = new THREE.Vector3();
const _toC = new THREE.Vector3();
const _local = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _invQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class CombatSystem {
  /** Director hook: fired exactly once per construct death, any cause. */
  onKill: ((construct: Construct, position: THREE.Vector3) => void) | null = null;

  private readonly deps: CombatDeps;
  private readonly pose: CameraPoseProvider;
  /** Scratch copies of the provider's pose, refreshed before every use. */
  private readonly playerPos = new THREE.Vector3();
  private readonly playerQuat = new THREE.Quaternion();

  private clockMs = 0;
  private killCount = 0;

  private readonly projectileBook = new Map<ProjectileEffectLike, ProjectileBook>();
  /** Scratch set for the per-frame projectile sweep (GC audit: reused). */
  private readonly seenProjectiles = new Set<ProjectileEffectLike>();
  private readonly pendingEmpower = new Map<MoveName, number>();
  private readonly sustainBook = new Map<string, SustainBook>();
  private readonly wiredConstructs = new WeakSet<Construct>();

  // Two duck detectors: torso (pose, preferred) and head (face, fallback).
  // Each auto-baselines from its own signal because torso center y and head
  // y live at different heights; isDucked prefers the torso detector while
  // torso samples are fresh.
  private torsoDuck: DuckDetector | null = null;
  private torsoBaselineSamples: number[] = [];
  private lastTorsoT = -Infinity;
  private headDuck: DuckDetector | null = null;
  private baselineSamples: number[] = [];

  constructor(deps: CombatDeps) {
    this.deps = deps;
    this.pose =
      deps.cameraPose ?? fixedCameraPose(deps.playerPosition ?? PLAYER_WORLD_POSITION);
    this.refreshPose();

    // Combat owns manager.onDeath; downstream listens to combat.onKill.
    deps.manager.onDeath = (construct, position) => {
      this.killCount++;
      this.onKill?.(construct, position);
    };
  }

  /** Constructs killed since this system was created. */
  get kills(): number {
    return this.killCount;
  }

  /** True while the player counts as ducked (Section 8): torso center from
   *  body pose when fresh, head y as the fallback. */
  get isDucked(): boolean {
    if (this.torsoDuck && this.clockMs - this.lastTorsoT <= TORSO_STALE_MS) {
      return this.torsoDuck.isDucked;
    }
    return this.headDuck?.isDucked ?? false;
  }

  /** Internal clock, ms. Synced to frame/event timestamps when available. */
  get timeMs(): number {
    return this.clockMs;
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  /**
   * Advance hit detection: VFX-projectile vs construct sphere sweeps and the
   * incoming-coal defense (wall block, duck, player hit). Pass the current
   * LandmarkFrame when available so duck detection sees head-y samples.
   */
  update(dt: number, frame?: LandmarkFrame): void {
    this.refreshPose();
    if (frame) this.clockMs = Math.max(this.clockMs, frame.t);
    else this.clockMs += dt * 1000;

    if (frame?.pose) this.feedTorso(torsoCenterY(frame.pose), frame.t);
    if (frame?.face) this.feedFace(frame.face.position.y, frame.t);
    this.wireConstructs();
    this.sweepEffectProjectiles();
    this.blockCoalsWithWall();
  }

  // -------------------------------------------------------------------------
  // Move event routing
  // -------------------------------------------------------------------------

  /**
   * Route one MoveEvent. The effects provider already spawned the visuals;
   * combat only does damage bookkeeping: instant melee-range hits
   * (fire-whip), pending empowerment for projectile moves, and sustain tick
   * damage (delegated to applySustainTick).
   */
  handleMoveEvent(e: MoveEvent): void {
    this.refreshPose();
    this.clockMs = Math.max(this.clockMs, e.t);
    switch (e.kind) {
      case 'trigger':
        if (
          e.empowered &&
          (e.move === 'jab-blast' || e.move === 'cross-combo' || e.move === 'twin-cannon')
        ) {
          // The projectile damage lands later, on collision; remember the
          // charge until then (the VFX projectile may also carry the flag).
          this.pendingEmpower.set(e.move, e.t + PENDING_EMPOWER_TTL_MS);
        }
        if (e.move === 'fire-whip') this.whipInstantHit(e);
        break;
      case 'sustain-start':
        this.sustainBook.set(sustainKey(e), { lastT: e.t, empowered: e.empowered });
        break;
      case 'sustain-tick':
        this.applySustainTick(e);
        break;
      case 'sustain-end':
        this.sustainBook.delete(sustainKey(e));
        break;
    }
  }

  /**
   * Apply one sustained-beam tick (the fire-stream ray) against
   * the constructs, dealing damage * dt. Damage per second comes from
   * DAMAGE_TABLE; dt derives from consecutive tick timestamps, so any
   * capture rate is counted honestly. Only a first tick with no preceding
   * sustain-start falls back to DEFAULT_TICK_MS (one frame at the measured
   * ~14 fps cadence). Returns the damage actually dealt (0 on miss), which
   * tests use directly.
   */
  applySustainTick(e: MoveEvent): number {
    this.refreshPose();
    const spec = DAMAGE_TABLE[e.move];
    if (!spec.perSecond) return 0;

    const key = sustainKey(e);
    let book = this.sustainBook.get(key);
    if (!book) {
      book = { lastT: e.t - DEFAULT_TICK_MS, empowered: e.empowered };
      this.sustainBook.set(key, book);
    }
    const dtSec = Math.min(MAX_TICK_SEC, Math.max(0, (e.t - book.lastT) / 1000));
    book.lastT = e.t;
    if (dtSec <= 0) return 0;

    const origin = beamOriginToWorld(e.origin, this.playerPos, this.playerQuat, _origin);
    const aim = screenAimToWorld(e.aim, this.playerQuat, _dir);
    const target = this.pickBeamTarget(origin, aim);
    if (!target) return 0;

    const empowered = book.empowered || e.empowered;
    const damage = spec.damage * dtSec * (empowered ? EMPOWER_MULTIPLIER : 1);
    const center = this.chestCenter(target, _center);
    // Hit point on the player-facing side of the torso sphere.
    _normal.copy(origin).sub(center).normalize();
    const hitPoint = _hit.copy(center).addScaledVector(_normal, CHEST_RADIUS);
    target.takeHit(damage, _impulse.set(0, 0, 0), hitPoint);
    return damage;
  }

  // -------------------------------------------------------------------------
  // Instant melee-range hits
  // -------------------------------------------------------------------------

  /**
   * Fire Whip: an arcing crack within WHIP_RANGE meters, effective in the
   * lateral half-space the swing points into (with tolerance so a construct
   * dead ahead is always inside the arc).
   */
  private whipInstantHit(e: MoveEvent): void {
    // Lateral gating happens in the CAMERA frame (screen space is the
    // player's truth); the impulse is dealt in world space.
    const aimLocal = screenAimToWorld(e.aim, IDENTITY_QUAT, _dirLocal);
    const aimWorld = screenAimToWorld(e.aim, this.playerQuat, _dir);
    _invQ.copy(this.playerQuat).invert();
    for (const construct of this.deps.manager.constructs) {
      if (!construct.isAlive) continue;
      const center = this.chestCenter(construct, _center);
      _local.copy(center).sub(this.playerPos).applyQuaternion(_invQ);
      const horizontal = Math.hypot(_local.x, _local.z);
      if (horizontal > WHIP_RANGE) continue;
      if (_local.z > -0.1) continue; // behind or beside the player: no target
      if (Math.abs(aimLocal.x) >= WHIP_MIN_LATERAL_AIM) {
        const side = Math.sign(aimLocal.x);
        if (_local.x * side < -WHIP_LATERAL_TOLERANCE) continue;
      }
      this.dealInstantHit(construct, 'fire-whip', e.empowered, aimWorld);
    }
  }

  private dealInstantHit(
    construct: Construct,
    move: MoveName,
    empowered: boolean,
    aimWorld: THREE.Vector3,
  ): void {
    const spec = DAMAGE_TABLE[move];
    const damage = spec.damage * (empowered ? EMPOWER_MULTIPLIER : 1);
    const center = this.chestCenter(construct, _center);
    // Push direction: mostly into the scene, tinted by the swing's lateral aim.
    _impulse
      .copy(center)
      .sub(this.playerPos)
      .setY(0)
      .normalize()
      .addScaledVector(aimWorld, 0.6)
      .normalize();
    _normal.copy(this.playerPos).sub(center).normalize();
    const hitPoint = _hit.copy(center).addScaledVector(_normal, CHEST_RADIUS * 0.5);
    construct.takeHit(damage, _impulse.multiplyScalar(spec.impulse), hitPoint);
    this.deps.impacts?.burst(hitPoint.clone(), _normal.clone(), damage / 20);
  }

  // -------------------------------------------------------------------------
  // VFX projectile sweep
  // -------------------------------------------------------------------------

  private sweepEffectProjectiles(): void {
    const list = this.deps.effects.projectiles;
    // Reused across frames (GC audit): cleared, never reallocated.
    const seen = this.seenProjectiles;
    seen.clear();
    for (const p of list) {
      seen.add(p);
      let book = this.projectileBook.get(p);
      if (!book) {
        book = { prev: p.position.clone(), consumed: false };
        this.projectileBook.set(p, book);
      }
      if (!book.consumed) {
        const target = this.findSphereHit(p.position, p.radius);
        if (target) this.applyProjectileHit(p, book, target);
      }
      book.prev.copy(p.position);
    }
    // Forget projectiles the effects layer has despawned. Deleting during
    // Map iteration is spec-safe; no snapshot array is allocated.
    for (const key of this.projectileBook.keys()) {
      if (!seen.has(key)) this.projectileBook.delete(key);
    }
  }

  private findSphereHit(position: THREE.Vector3, radius: number): Construct | null {
    for (const construct of this.deps.manager.constructs) {
      if (!construct.isAlive) continue;
      const center = this.chestCenter(construct, _center);
      const reach = radius + CHEST_RADIUS;
      if (position.distanceToSquared(center) <= reach * reach) return construct;
    }
    return null;
  }

  private applyProjectileHit(
    p: ProjectileEffectLike,
    book: ProjectileBook,
    construct: Construct,
  ): void {
    book.consumed = true;
    const spec = DAMAGE_TABLE[p.sourceMove];
    const empowered = p.empowered === true || this.consumePendingEmpower(p.sourceMove);
    const damage = spec.damage * (empowered ? EMPOWER_MULTIPLIER : 1);
    const center = this.chestCenter(construct, _center);

    // Travel direction from the last-seen position; falls back to the line
    // from the player when the projectile has not moved yet.
    _dir.copy(p.position).sub(book.prev);
    if (_dir.lengthSq() < 1e-10) _dir.copy(center).sub(this.playerPos);
    if (_dir.lengthSq() < 1e-10) _dir.set(0, 0, -1);
    _dir.normalize();

    _normal.copy(p.position).sub(center);
    if (_normal.lengthSq() < 1e-10) _normal.copy(_dir).negate();
    else _normal.normalize();
    const hitPoint = _hit.copy(center).addScaledVector(_normal, CHEST_RADIUS);

    const wasAlive = construct.isAlive;
    construct.takeHit(damage, _impulse.copy(_dir).multiplyScalar(spec.impulse), hitPoint);
    p.onImpact(hitPoint.clone(), _normal.clone());
    this.deps.impacts?.burst(hitPoint.clone(), _normal.clone(), damage / 20);
    this.deps.onImpact?.(hitPoint.clone(), damage);

    if (p.sourceMove === 'twin-cannon') {
      this.deps.onHitStop?.(TWIN_HIT_STOP_MS);
      if (wasAlive && !construct.isAlive) {
        this.deps.onSlowMo?.(KILL_SLOWMO_SCALE, KILL_SLOWMO_MS);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Incoming coals: wall block, duck, player hit
  // -------------------------------------------------------------------------

  private wireConstructs(): void {
    for (const construct of this.deps.manager.constructs) {
      if (this.wiredConstructs.has(construct)) continue;
      this.wiredConstructs.add(construct);
      construct.onProjectileArrive = (landPos) => this.handleCoalArrive(landPos);
    }
  }

  private blockCoalsWithWall(): void {
    if (this.deps.effects.wallActiveUntil() === null) return;
    // The Rising Flame wall stands perpendicular to the CAMERA's flattened
    // forward, WALL_PLANE_AHEAD meters in front of the player (matching the
    // camera-relative WallEffect in moveEffects.ts). A coal whose forward
    // distance has shrunk to the plane, inside the wall's lateral span and
    // below its top, bursts against it.
    this.cameraBasis(_fwd, _right);
    for (const construct of this.deps.manager.constructs) {
      const coals = construct.projectiles;
      for (let i = coals.length - 1; i >= 0; i--) {
        const coal = coals[i];
        if (!coal) continue;
        const pos = coal.position;
        _rel.copy(pos).sub(this.playerPos);
        const distFront = _rel.dot(_fwd);
        if (
          distFront <= WALL_PLANE_AHEAD &&
          Math.abs(_rel.dot(_right)) <= WALL_HALF_WIDTH &&
          pos.y <= WALL_TOP
        ) {
          coal.mesh.removeFromParent();
          coals.splice(i, 1);
          this.deps.impacts?.burst(pos.clone(), _fwd.clone().negate(), 0.8);
        }
      }
    }
  }

  private handleCoalArrive(landPos: THREE.Vector3): void {
    this.refreshPose();
    this.cameraBasis(_fwd, _right);
    const distFront = _rel.copy(landPos).sub(this.playerPos).dot(_fwd);
    const inPlayerZone = distFront < -PLAYER_ZONE_Z;
    if (!inPlayerZone) {
      // Fell short: just a small ground burst.
      this.deps.impacts?.burst(landPos.clone(), UP.clone(), 0.4);
      return;
    }
    if (this.isDucked) return; // sails harmlessly overhead
    this.deps.onPlayerHit?.(COAL_DAMAGE);
    this.deps.onBreathPenalty?.(PLAYER_HIT_BREATH_PENALTY);
  }

  private feedFace(headY: number, tMs: number): void {
    if (!this.headDuck) {
      const fixed = this.deps.headBaselineY;
      if (fixed !== undefined) {
        this.headDuck = new DuckDetector(fixed);
      } else {
        // Auto-calibrate from the first samples (the calibration screen's
        // stats should provide headBaselineY at integration; this is the
        // fallback and assumes the player starts standing).
        this.baselineSamples.push(headY);
        if (this.baselineSamples.length < DUCK_BASELINE_SAMPLES) return;
        let sum = 0;
        for (const y of this.baselineSamples) sum += y;
        this.headDuck = new DuckDetector(sum / this.baselineSamples.length);
        this.baselineSamples = [];
      }
    }
    this.headDuck.update(headY, tMs);
  }

  /** Torso duck feed (preferred path): auto-baselines from its own signal. */
  private feedTorso(torsoY: number, tMs: number): void {
    if (!this.torsoDuck) {
      this.torsoBaselineSamples.push(torsoY);
      if (this.torsoBaselineSamples.length < DUCK_BASELINE_SAMPLES) return;
      let sum = 0;
      for (const y of this.torsoBaselineSamples) sum += y;
      this.torsoDuck = new DuckDetector(sum / this.torsoBaselineSamples.length);
      this.torsoBaselineSamples = [];
    }
    this.lastTorsoT = tMs;
    this.torsoDuck.update(torsoY, tMs);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Refresh the scratch pose from the provider (cheap; every entry point). */
  private refreshPose(): void {
    this.playerPos.copy(this.pose.position());
    this.playerQuat.copy(this.pose.quaternion());
  }

  /** Flattened camera forward and right axes (unit, horizontal). */
  private cameraBasis(fwd: THREE.Vector3, right: THREE.Vector3): void {
    fwd.set(0, 0, -1).applyQuaternion(this.playerQuat);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
    fwd.normalize();
    right.crossVectors(fwd, UP);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
  }

  private chestCenter(construct: Construct, out: THREE.Vector3): THREE.Vector3 {
    // CHEST_HEIGHT is measured above the construct's LOCAL floor (stations
    // on the bridge deck stand elevated).
    return out
      .copy(construct.group.position)
      .setY(construct.group.position.y + CHEST_HEIGHT);
  }

  private pickBeamTarget(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
  ): Construct | null {
    let best: Construct | null = null;
    let bestAlong = Infinity;
    for (const construct of this.deps.manager.constructs) {
      if (!construct.isAlive) continue;
      const center = this.chestCenter(construct, _center);
      _toC.copy(center).sub(origin);
      const along = _toC.dot(dir);
      if (along <= 0) continue; // behind the beam
      if (along > STREAM_RANGE) continue;
      const offAxisSq = _toC.lengthSq() - along * along;
      const reach = CHEST_RADIUS + STREAM_BEAM_RADIUS;
      if (offAxisSq > reach * reach) continue;
      if (along < bestAlong) {
        bestAlong = along;
        best = construct;
      }
    }
    return best;
  }

  private consumePendingEmpower(move: MoveName): boolean {
    const expiry = this.pendingEmpower.get(move);
    if (expiry === undefined) return false;
    this.pendingEmpower.delete(move);
    return this.clockMs <= expiry;
  }
}

function sustainKey(e: MoveEvent): string {
  return `${e.move}:${e.hand}`;
}
