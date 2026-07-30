/**
 * Director (T052, spec Section 8): the kill -> travel -> next enemy chain.
 * Owns the fight loop's pacing: spawn construct N, wait for the kill, hold a
 * 0.5 s kill window (slow-mo + ember burst, driven by the integration layer
 * through onKillWindow), fly the camera to the next arena anchor while the
 * next construct spawns there, then resume fighting. Infinite chain with a
 * difficulty ramp (HP + tier 2 coal lobbers every third construct).
 *
 * Headless by design: the only three.js dependency is vector math, and the
 * camera rig is injected as a tiny DirectorRig interface so tests can use a
 * fake that resolves travels on demand.
 *
 * ENVIRONMENT ILLUSION (the killTravel.ts note): nextArenaAnchor() marches
 * z toward negative infinity forever, but the built arena is only ~21 m deep
 * and the combat layer's math assumes the player stands near z = 0. The
 * director therefore keeps a running lane offset (zOffset) and re-bases the
 * chain whenever the next anchor's effective z would pass REBASE_TRIGGER_Z:
 * the next construct is recentered to RECENTER_Z (= -6, the canonical first
 * anchor depth) and arenaShift(deltaZ) tells the integration layer to shift
 * stale world-anchored content (dead constructs' debris) by the same delta so
 * the old kill ends up behind the player instead of down the lane.
 * nextArenaAnchor itself stays pure; the offset lives only here.
 *
 * WHY THE ARENA GROUP ITSELF DOES NOT MOVE: anchors always live inside
 * [RECENTER_Z, REBASE_TRIGGER_Z] = [-6, -16] and the camera inside roughly
 * [-16, +0.6], both permanently within the built lane (z in [2, -22]), so
 * recentering the ACTION into the static arena is the whole illusion; moving
 * the arena group by +deltaZ would carry the lane geometry away from the
 * recentered anchors and break coverage. The corridor is self-similar, so
 * returning to the same stretch of it reads as endless. This deviates from
 * the task sketch deliberately and is the "think it through" documented here.
 *
 * THE RE-BASE TRAVEL AND viewDistance SIGN: CameraRig.travelTo derives its
 * viewing pose from the approach side (endPos = anchor + norm(basePos -
 * anchor) * viewDistance), so a camera that is DEEPER down the lane than the
 * re-based anchor (base z ~ -10.5 vs anchor z = -6) would settle on the far
 * side looking backward. Passing viewDistance = -TRAVEL_VIEW_DISTANCE on
 * re-base travels flips the settle point through the anchor onto the +z side,
 * so the camera arcs from deep in the lane AROUND the waiting construct and
 * lands in front of it facing forward: an orbit reveal, and the standard
 * relative pose (camera ~5.5 m in front, at z ~ -0.5) is restored. Normal
 * travels always approach from the +z side, so they keep the default. This
 * also restores the CombatSystem frame (player planted near z = 0) every
 * re-base, keeping beams, whip range, coal player-zone checks and duck/block
 * valid forever instead of degrading as z runs away.
 */

import * as THREE from 'three';
import type { CombatSystem } from './combat';
import { PLAYER_WORLD_POSITION } from './combat';
import type { Construct, ConstructManager, ConstructTier } from './enemies';
import { DEFAULT_HP } from './enemies';
import { nextArenaAnchor } from './killTravel';

// ---------------------------------------------------------------------------
// Tuning constants (Section 8)
// ---------------------------------------------------------------------------

/** Kill window: 0.5 s slow-mo ember-burst beat before the travel starts. */
export const KILL_WINDOW_SEC = 0.5;

/** HP ramp: base * (1 + HP_RAMP_PER_INDEX * index), capped at HP_RAMP_CAP x. */
export const HP_RAMP_PER_INDEX = 0.15;
export const HP_RAMP_CAP = 2.5;

/** Every TIER2_EVERY-th construct (index 2, 5, 8, ...) is a tier 2 lobber. */
export const TIER2_EVERY = 3;

/** Coal lob cadence: max(BASE - STEP * index, MIN) seconds. */
export const LOB_INTERVAL_BASE_SEC = 2.2;
export const LOB_INTERVAL_STEP_SEC = 0.1;
export const LOB_INTERVAL_MIN_SEC = 1.2;

/** An effective anchor z past this triggers the lane re-base. */
export const REBASE_TRIGGER_Z = -16;
/** Re-based anchors recenter to this z (the canonical first-anchor depth). */
export const RECENTER_Z = -6;

/** Camera settle distance in front of the anchor (CameraRig default). */
export const TRAVEL_VIEW_DISTANCE = 5.5;

export type DirectorState = 'fighting' | 'killWindow' | 'traveling';

// ---------------------------------------------------------------------------
// Pure difficulty helpers (exported for tests)
// ---------------------------------------------------------------------------

export function constructTierFor(index: number): ConstructTier {
  return index % TIER2_EVERY === TIER2_EVERY - 1 ? 2 : 1;
}

export function constructHpFor(index: number): number {
  const ramp = Math.min(1 + HP_RAMP_PER_INDEX * index, HP_RAMP_CAP);
  return DEFAULT_HP[constructTierFor(index)] * ramp;
}

export function lobIntervalFor(index: number): number {
  return Math.max(LOB_INTERVAL_BASE_SEC - LOB_INTERVAL_STEP_SEC * index, LOB_INTERVAL_MIN_SEC);
}

// ---------------------------------------------------------------------------
// Injected interfaces (kept minimal so tests can fake them trivially)
// ---------------------------------------------------------------------------

export interface DirectorTravelOptions {
  durationSec?: number;
  viewDistance?: number;
  eyeHeight?: number;
  lateralSwing?: number;
}

/** The slice of CameraRig the director drives. */
export interface DirectorRig {
  travelTo(targetAnchor: THREE.Vector3, opts?: DirectorTravelOptions): Promise<void>;
  shake?(intensity: number, durationSec: number): void;
}

/** The slice of the HUD the director drives (duck-typed; HUD satisfies it). */
export interface DirectorHud {
  attachConstruct(construct: { damagePercent: number; isAlive: boolean }): void;
}

export interface DirectorDeps {
  manager: ConstructManager;
  combat: CombatSystem;
  rig: DirectorRig;
  hud?: DirectorHud;
  /** Fired when a kill window opens, with the death position (cloned). */
  onKillWindow?: (position: THREE.Vector3) => void;
  /** Fired as the travel toward construct `index` begins. */
  onTravelStart?: (index: number) => void;
  /** Fired when the camera arrives in front of construct `index`. */
  onTravelEnd?: (index: number) => void;
  /**
   * Lane re-base hook: shift stale world-anchored content (dead constructs'
   * debris, lingering world VFX) by +offsetZ. See the module header.
   */
  arenaShift?: (offsetZ: number) => void;
  /** Coal lob target; defaults to combat's planted player position. */
  playerPosition?: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Director
// ---------------------------------------------------------------------------

export class Director {
  private readonly deps: DirectorDeps;
  private readonly playerPos: THREE.Vector3;

  private stateValue: DirectorState = 'fighting';
  private index = 0;
  private zOffset = 0;
  private killTimer = 0;
  private current: Construct | null = null;
  private pendingKillPos: THREE.Vector3 | null = null;
  private travelToken = 0;
  private started = false;
  private disposed = false;

  constructor(deps: DirectorDeps) {
    this.deps = deps;
    this.playerPos = (deps.playerPosition ?? PLAYER_WORLD_POSITION).clone();
  }

  /** Current chain state: fighting -> killWindow -> traveling -> fighting. */
  get state(): DirectorState {
    return this.stateValue;
  }

  /** Index of the construct currently in play (0-based). */
  get constructIndex(): number {
    return this.index;
  }

  /** Kill count passthrough from the combat layer. */
  get kills(): number {
    return this.deps.combat.kills;
  }

  /** The construct the chain currently points at (may be mid-death). */
  get currentConstruct(): Construct | null {
    return this.current;
  }

  /** Accumulated lane re-base offset (tests; world z = pure z + this). */
  get laneOffsetZ(): number {
    return this.zOffset;
  }

  /**
   * Effective (re-based) anchor position for a construct index: the pure
   * nextArenaAnchor position with the running lane offset applied to z.
   */
  effectiveAnchorPosition(index: number): THREE.Vector3 {
    const pure = nextArenaAnchor(index);
    return new THREE.Vector3(pure.position.x, pure.position.y, pure.position.z + this.zOffset);
  }

  /**
   * Begin the chain: claim combat.onKill and spawn construct 0 at anchor 0
   * (tier 1, base HP). Call once, after CombatSystem construction (combat
   * claims manager.onDeath; the director listens one level up).
   */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.deps.combat.onKill = (construct, position) => this.handleKill(construct, position);
    this.current = this.spawnConstruct(0);
    this.stateValue = 'fighting';
  }

  /** Advance the kill-window timer. Call once per frame with REAL seconds
   *  (the kill window is a wall-clock beat; slow-mo scaling happens to the
   *  world underneath it, not to the director's own pacing). */
  update(dt: number): void {
    if (this.disposed || this.stateValue !== 'killWindow') return;
    this.killTimer -= Math.max(dt, 0);
    if (this.killTimer <= 0) this.beginTravel();
  }

  dispose(): void {
    this.disposed = true;
    this.travelToken++;
    this.deps.combat.onKill = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private spawnConstruct(index: number): Construct {
    const anchor = this.effectiveAnchorPosition(index);
    const construct = this.deps.manager.spawn(
      anchor,
      constructTierFor(index),
      constructHpFor(index),
    );
    this.deps.hud?.attachConstruct(construct);
    return construct;
  }

  private handleKill(construct: Construct, position: THREE.Vector3): void {
    if (this.disposed || construct !== this.current) return;
    if (this.stateValue === 'fighting') {
      this.openKillWindow(position);
    } else if (this.stateValue === 'traveling') {
      // A lingering projectile killed the freshly spawned construct while
      // the camera was still in flight; queue the beat for arrival.
      this.pendingKillPos = position.clone();
    }
    // A kill during an existing killWindow cannot involve this.current
    // (already dead), so it is unreachable via the construct guard above.
  }

  private openKillWindow(position: THREE.Vector3): void {
    this.stateValue = 'killWindow';
    this.killTimer = KILL_WINDOW_SEC;
    this.deps.onKillWindow?.(position.clone());
  }

  private beginTravel(): void {
    const nextIndex = this.index + 1;

    // Environment illusion: re-base the lane before computing anything else,
    // so the spawn anchor AND the travel target both see the new offset.
    const pureZ = nextArenaAnchor(nextIndex).position.z;
    let rebase = false;
    if (pureZ + this.zOffset < REBASE_TRIGGER_Z) {
      const delta = RECENTER_Z - (pureZ + this.zOffset);
      this.zOffset += delta;
      rebase = true;
      this.deps.arenaShift?.(delta);
    }

    this.index = nextIndex;
    const construct = this.spawnConstruct(nextIndex);
    this.current = construct;
    this.stateValue = 'traveling';
    this.deps.onTravelStart?.(nextIndex);

    // Travel target: the construct's anchor (the rig looks AT it and settles
    // TRAVEL_VIEW_DISTANCE in front). Re-base travels flip viewDistance so
    // the camera lands on the near (+z) side; see the module header.
    const target = this.effectiveAnchorPosition(nextIndex);
    const opts: DirectorTravelOptions = rebase
      ? { viewDistance: -TRAVEL_VIEW_DISTANCE }
      : {};

    const token = ++this.travelToken;
    void this.deps.rig.travelTo(target, opts).then(() => {
      if (this.disposed || token !== this.travelToken) return;
      this.arrive(construct, nextIndex);
    });
  }

  private arrive(construct: Construct, index: number): void {
    // Tier 2 constructs only open fire once the player has actually arrived.
    if (constructTierFor(index) === 2 && construct.isAlive) {
      construct.startLobbing(this.playerPos, lobIntervalFor(index));
    }
    this.deps.onTravelEnd?.(index);
    if (this.pendingKillPos !== null) {
      const pos = this.pendingKillPos;
      this.pendingKillPos = null;
      this.openKillWindow(pos);
    } else {
      this.stateValue = 'fighting';
    }
  }
}
