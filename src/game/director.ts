/**
 * Director (T052 / Phase 5, spec Section 8): the kill -> travel -> next
 * enemy chain over the courtyard STATIONS. Owns the fight loop's pacing:
 * spawn construct N at its station anchor, wait for the kill, hold a 0.5 s
 * kill window (slow-mo + ember burst, driven by the integration layer
 * through onKillWindow), then fly the camera along the AUTHORED travel
 * recipe for the next station. The next construct spawns BEFORE the travel
 * starts, so the arrival reveals it already waiting.
 *
 * STATIONS (killTravel.ts): six authored stations around the courtyard,
 * cycled in fixed order forever (killIndex % STATION_COUNT). The difficulty
 * ramp (HP + tier 2 coal lobbers every third construct) keeps climbing by
 * kill index across cycles.
 *
 * TRAVEL STYLES: every transition has an authored spline recipe showing off
 * one environment feature (gate pull-back, colonnade arc, canopy rise,
 * steps descent, bridge sweep, channel glide). The director enforces the
 * no-repeat rule: the same path style never plays twice in a row. The fixed
 * six-station cycle satisfies this by construction; travelRecipeFor's
 * banned-style parameter is the defensive backstop.
 *
 * WHAT REPLACED THE LANE RE-BASE: nothing needs re-basing anymore. The
 * courtyard is finite real space, every station anchor is a real place in
 * it, and the camera always flies between authored poses inside it. Dead
 * constructs' debris stays where it fell as battle scars; the construct
 * manager caps the kept debris bodies (DEBRIS_KEEP_CAP ~ 24) and fades the
 * oldest out. The old applyArenaShift / arenaShift plumbing is gone.
 *
 * PLAYER FRAME: the player is planted and never turns, but each station
 * orients the camera differently, so combat aim mapping is camera-relative
 * (see combat.ts CameraPoseProvider). The director itself only needs the
 * camera base POSITION: tier 2 constructs lob coals at wherever the camera
 * (the player's eye) currently stands. Injected via deps.cameraPose; the
 * legacy fixed PLAYER_WORLD_POSITION is the fallback for headless tests.
 *
 * Headless by design: the only three.js dependency is vector math, and the
 * camera rig is injected as a tiny DirectorRig interface so tests can use a
 * fake that resolves travels on demand.
 */

import * as THREE from 'three';
import type { CombatSystem, CameraPoseProvider } from './combat';
import { PLAYER_WORLD_POSITION } from './combat';
import type { Construct, ConstructManager, ConstructTier } from './enemies';
import { DEFAULT_HP } from './enemies';
import {
  stationFor,
  stationIndexFor,
  travelRecipeFor,
  type PathStyle,
} from './killTravel';
import type { TravelEasing } from './cameraRig';

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
  controlPoints?: THREE.Vector3[];
  endPosition?: THREE.Vector3;
  easing?: TravelEasing;
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
   * Camera base pose provider (Phase 5): coal lobs target the CURRENT
   * camera base position. Fallback: the fixed PLAYER_WORLD_POSITION.
   */
  cameraPose?: CameraPoseProvider;
}

// ---------------------------------------------------------------------------
// Director
// ---------------------------------------------------------------------------

export class Director {
  private readonly deps: DirectorDeps;

  private stateValue: DirectorState = 'fighting';
  private index = 0;
  private killTimer = 0;
  private current: Construct | null = null;
  private pendingKillPos: THREE.Vector3 | null = null;
  private travelToken = 0;
  private started = false;
  private disposed = false;
  private lastStyle: PathStyle | null = null;
  private readonly styleLog: PathStyle[] = [];

  constructor(deps: DirectorDeps) {
    this.deps = deps;
  }

  /** Current chain state: fighting -> killWindow -> traveling -> fighting. */
  get state(): DirectorState {
    return this.stateValue;
  }

  /** Index of the construct currently in play (0-based, never resets). */
  get constructIndex(): number {
    return this.index;
  }

  /** Which courtyard station the current construct occupies. */
  get stationIndex(): number {
    return stationIndexFor(this.index);
  }

  /** Kill count passthrough from the combat layer. */
  get kills(): number {
    return this.deps.combat.kills;
  }

  /** The construct the chain currently points at (may be mid-death). */
  get currentConstruct(): Construct | null {
    return this.current;
  }

  /** Every path style traveled so far, in order (tests: no-repeat rule). */
  get pathStyleLog(): readonly PathStyle[] {
    return this.styleLog;
  }

  /**
   * Begin the chain: claim combat.onKill and spawn construct 0 at station 0
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

  /** The camera base position: where coal lobs aim. */
  private playerTarget(): THREE.Vector3 {
    return this.deps.cameraPose?.position().clone() ?? PLAYER_WORLD_POSITION.clone();
  }

  private spawnConstruct(index: number): Construct {
    const st = stationFor(index);
    const construct = this.deps.manager.spawn(
      st.anchor,
      constructTierFor(index),
      constructHpFor(index),
      st.floorY,
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
    this.index = nextIndex;

    // Spawn BEFORE the travel starts: the arrival reveals the construct
    // already waiting at its station.
    const construct = this.spawnConstruct(nextIndex);
    this.current = construct;
    this.stateValue = 'traveling';
    this.deps.onTravelStart?.(nextIndex);

    // Authored travel: never the same path style twice in a row.
    const recipe = travelRecipeFor(nextIndex, this.lastStyle ?? undefined);
    this.lastStyle = recipe.style;
    this.styleLog.push(recipe.style);

    const st = stationFor(nextIndex);
    const opts: DirectorTravelOptions = {
      durationSec: recipe.durationSec,
      easing: recipe.easing,
      endPosition: recipe.endPosition,
      ...(recipe.controlPoints.length > 0 ? { controlPoints: recipe.controlPoints } : {}),
    };

    const token = ++this.travelToken;
    void this.deps.rig.travelTo(st.anchor.clone(), opts).then(() => {
      if (this.disposed || token !== this.travelToken) return;
      this.arrive(construct, nextIndex);
    });
  }

  private arrive(construct: Construct, index: number): void {
    // Tier 2 constructs only open fire once the player has actually arrived,
    // and they aim at the camera's CURRENT base position (the station pose).
    if (constructTierFor(index) === 2 && construct.isAlive) {
      construct.startLobbing(this.playerTarget(), lobIntervalFor(index));
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
