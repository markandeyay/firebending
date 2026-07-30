/**
 * Arena screen (T052 integration): the full playable loop. Wires together
 * every Phase 3-5 system behind the ScreenManager Screen interface:
 *
 *   tracking (LandmarkSource -> FilteredSource) -> MoveEngine -> events
 *     -> MoveEffects (fire VFX) + CombatSystem (damage) + AudioHooks
 *   ConstructManager + rapier physics, CameraRig (head parallax + travels),
 *   Director (kill -> travel -> next chain), HUD (Breath, seal, numbers),
 *   FireSystem ambient brazier flames, ImpactSystem sparks/decals.
 *
 * ctx contract (see ArenaContext): the screen receives the RAW landmark
 * source and wraps it in FilteredSource itself (same convention as gameplay
 * everywhere else; calibration consumed the raw source before this screen).
 *
 * TIME SCALING: one animation loop. A frame computes rawDt (wall clock,
 * clamped) and a world dt: frozen to 0 while a hit-stop is active (120 ms on
 * Twin Cannon impact), scaled by the slow-mo factor while a kill window's
 * slow-mo runs (0.25 for 500 ms). World systems (physics, VFX, combat,
 * arena ambience) advance on world dt; the camera rig, HUD and director
 * pacing advance on rawDt so camera motion and UI stay smooth and the 0.5 s
 * kill window is a wall-clock beat.
 *
 * DAMAGE NUMBERS: combat exposes no per-hit callback, so the screen polls
 * the current construct's hp once per frame and turns downward deltas into
 * floating numbers at the construct's projected chest position. Deltas are
 * accumulated and flushed when they reach DAMAGE_FLUSH_IMMEDIATE (discrete
 * hits show instantly) or every DAMAGE_FLUSH_SEC otherwise (sustained beams
 * batch into one readable number a few times a second instead of spamming
 * "1" every frame). Empowered styling keys off recently seen empowered
 * trigger events (EMPOWERED_HOT_SEC covers the projectile flight time).
 * Documented tradeoff: a frame containing two different hits merges them.
 *
 * ARENA SHIFT (director's lane re-base, see director.ts header): the arena
 * group itself never moves; the action recenters INTO the static arena. The
 * shift only relocates stale world-anchored content, i.e. dead constructs
 * (group position + debris rigid bodies) by +deltaZ so the previous kill
 * ends up behind the player. Scorch decals are deliberately left in place:
 * they read as accumulated battle scars on the same stretch of floor.
 *
 * AUDIO: src/audio/* may be written concurrently, so this module never
 * imports it. AudioHooks is the seam: the orchestrator constructs the real
 * hooks later and passes them through ctx.audio; every callback is optional
 * and defaults to a no-op.
 */

import * as THREE from 'three';
import type { Screen } from './screenManager';
import type {
  FrameListener,
  LandmarkFrame,
  LandmarkSource,
} from '../tracking/types';
import { FilteredSource } from '../tracking/filters';
import type { ReplaySource } from '../tracking/replaySource';
import { MoveEngine, type MoveEvent } from '../gestures/moves';
import {
  velocityScaleFor,
  type CalibrationStats,
} from '../gestures/calibrationStats';
import { buildArena, type Arena } from '../game/arena';
import { CameraRig } from '../game/cameraRig';
import {
  ConstructManager,
  createPhysicsWorld,
  type Construct,
  type PhysicsWorld,
} from '../game/enemies';
import {
  CombatSystem,
  CHEST_HEIGHT,
  KILL_SLOWMO_MS,
  KILL_SLOWMO_SCALE,
  PLAYER_WORLD_POSITION,
  type EffectsProvider,
} from '../game/combat';
import { Director } from '../game/director';
import { FireSystem } from '../vfx/fire';
import { MoveEffects } from '../vfx/moveEffects';
import { ImpactSystem } from '../vfx/impact';
import { HUD } from '../ui/hud';

// ---------------------------------------------------------------------------
// Audio seam (see module header). The orchestrator wires the real hooks.
// ---------------------------------------------------------------------------

export interface AudioHooks {
  /** Every MoveEvent routed to VFX/combat (triggers, sustain lifecycle). */
  onMoveEvent?(event: MoveEvent): void;
  /** A construct died; position is its torso world position at death. */
  onKill?(position: { x: number; y: number; z: number }): void;
  /** Twin Cannon impact freeze began (ms of frozen time). */
  onHitStop?(ms: number): void;
  /** Kill slow-mo began (time scale, duration ms). Master ducking hook. */
  onSlowMo?(scale: number, ms: number): void;
  /** A coal reached the player (screen flash moment). */
  onPlayerHit?(damage: number): void;
  /** Camera travel toward construct `index` began / arrived. */
  onTravelStart?(index: number): void;
  onTravelEnd?(index: number): void;
}

// ---------------------------------------------------------------------------
// Screen context
// ---------------------------------------------------------------------------

export interface ArenaContext {
  /** RAW landmark source; the screen wraps it in FilteredSource itself. */
  source: LandmarkSource;
  stats: CalibrationStats;
  audio?: AudioHooks;
  /**
   * Explicit velocity-scale override. The replay path needs the One Euro
   * compensation factor (REPLAY_VELOCITY_SCALE, see movesDebug.ts); live
   * play omits this and uses velocityScaleFor(stats.wristSpan).
   */
  velocityScale?: number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const CAMERA_FOV = 55;
/** Largest wall-clock dt a frame will integrate (tab-switch protection). */
const MAX_FRAME_DT_SEC = 0.1;
/** Seal floats this high above the construct's base (world y). */
const SEAL_ANCHOR_Y = 2.5;
/** Damage-number accumulator: flush immediately at or above this. */
const DAMAGE_FLUSH_IMMEDIATE = 5;
/** Otherwise flush at most this often (sustained-beam batching). */
const DAMAGE_FLUSH_SEC = 0.25;
/** Minimum accumulated damage worth a number at the periodic flush. */
const DAMAGE_FLUSH_MIN = 0.5;
/** An empowered trigger marks numbers empowered for this long. */
const EMPOWERED_HOT_SEC = 1.2;
/** Ambient brazier flame scale. */
const BRAZIER_FLAME_SCALE = 0.8;

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Looping replay adapter (same seam-safe design as the tracking overlay's
// private one: timestamps stay monotonic across loops so One Euro filters
// and confidence gates never see time run backward). Exported for main.ts's
// ?screen=arena&replay=... dev entry.
// ---------------------------------------------------------------------------

export class LoopingReplaySource implements LandmarkSource {
  private readonly listeners = new Set<FrameListener>();
  private offset = 0;
  private lastT = 0;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly detach: () => void;

  constructor(private readonly replay: ReplaySource) {
    this.detach = replay.onFrame((frame) => {
      this.lastT = frame.t + this.offset;
      const shifted: LandmarkFrame = { ...frame, t: this.lastT };
      for (const l of this.listeners) l(shifted);
      if (replay.done && !this.stopped) {
        const interval = 1000 / Math.max(replay.fps, 1);
        this.restartTimer = setTimeout(() => {
          this.offset = this.lastT + interval;
          this.replay.reset();
          void this.replay.start();
        }, interval);
      }
    });
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    await this.replay.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.replay.stop();
    this.detach();
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// World -> screen projection helper (kept OUT of hud.ts by design)
// ---------------------------------------------------------------------------

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

const _proj = new THREE.Vector3();

/**
 * Project a world position through `camera` into CSS pixel coordinates of
 * `element`. `visible` is false behind the camera or well outside the view.
 * Writes into `out` (no allocation in the hot path).
 */
export function projectWorldToScreen(
  world: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  element: { clientWidth: number; clientHeight: number },
  out: ScreenPoint,
): ScreenPoint {
  _proj.copy(world).project(camera);
  out.visible =
    _proj.z < 1 && _proj.x > -1.15 && _proj.x < 1.15 && _proj.y > -1.15 && _proj.y < 1.15;
  out.x = (_proj.x * 0.5 + 0.5) * element.clientWidth;
  out.y = (-_proj.y * 0.5 + 0.5) * element.clientHeight;
  return out;
}

// ---------------------------------------------------------------------------
// ArenaScreen
// ---------------------------------------------------------------------------

export class ArenaScreen implements Screen {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private arena: Arena | null = null;
  private rig: CameraRig | null = null;
  private physics: PhysicsWorld | null = null;
  private manager: ConstructManager | null = null;
  private fire: FireSystem | null = null;
  private fx: MoveEffects | null = null;
  private impacts: ImpactSystem | null = null;
  private engine: MoveEngine | null = null;
  private combat: CombatSystem | null = null;
  private hud: HUD | null = null;
  private director: Director | null = null;
  private filtered: FilteredSource | null = null;
  private detachFrames: (() => void) | null = null;
  private onResize: (() => void) | null = null;
  private audio: AudioHooks = {};
  private disposed = false;

  // Frame state (reused, no per-frame allocation).
  private readonly clock = new THREE.Clock();
  private elapsed = 0;
  private latestFrame: LandmarkFrame | null = null;
  private frameFresh = false;
  private hitStopMs = 0;
  private slowMoMs = 0;
  private slowMoScale = 1;

  // Damage-number bookkeeping (see module header).
  private dmgRef: Construct | null = null;
  private dmgHp = 0;
  private dmgAcc = 0;
  private dmgTimer = 0;
  private empoweredHotUntil = -Infinity;

  private readonly tmpWorld = new THREE.Vector3();
  private readonly point: ScreenPoint = { x: 0, y: 0, visible: false };

  async enter(root: HTMLElement, ctx?: unknown): Promise<void> {
    const context = ctx as ArenaContext | undefined;
    if (!context || !context.source || !context.stats) {
      throw new Error('ArenaScreen requires ctx { source, stats }');
    }
    this.audio = context.audio ?? {};
    this.disposed = false;

    // --- Renderer / scene / camera ---------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    root.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    const camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      100,
    );
    this.camera = camera;

    this.onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this.onResize);

    // --- World systems -----------------------------------------------------
    this.arena = buildArena(scene);
    this.rig = new CameraRig(camera);
    this.physics = await createPhysicsWorld();
    if (this.disposed) {
      // exit() raced the rapier init; tear down what enter built so far.
      this.physics.dispose();
      this.physics = null;
      return;
    }
    this.manager = new ConstructManager(this.physics, scene);

    this.fire = new FireSystem(scene);
    for (const anchor of this.arena.brazierAnchors) {
      this.fire.attachAmbient(anchor, BRAZIER_FLAME_SCALE);
    }
    this.fx = new MoveEffects(scene, this.fire, camera, this.rig);
    this.impacts = new ImpactSystem(scene, this.fire);

    // --- Gesture engine ----------------------------------------------------
    const velocityScale =
      context.velocityScale ?? velocityScaleFor(context.stats.wristSpan);
    this.engine = new MoveEngine({ velocityScale });

    // --- Combat (MoveEffects adapter per the combat.ts header) -------------
    const fx = this.fx;
    const effectsProvider: EffectsProvider = {
      get projectiles() {
        return fx.projectiles;
      },
      wallActiveUntil: () => (fx.activeWall ? fx.activeWall.until : null),
    };
    this.hud = new HUD(root);
    const hud = this.hud;
    const engine = this.engine;
    this.combat = new CombatSystem({
      manager: this.manager,
      effects: effectsProvider,
      impacts: this.impacts,
      onHitStop: (ms) => {
        this.hitStopMs = Math.max(this.hitStopMs, ms);
        this.audio.onHitStop?.(ms);
      },
      onSlowMo: (scale, ms) => this.startSlowMo(scale, ms),
      onPlayerHit: (damage) => {
        hud.playerHitFlash();
        this.audio.onPlayerHit?.(damage);
      },
      onBreathPenalty: (amount) => engine.spend(amount),
    });

    // --- Director ----------------------------------------------------------
    this.director = new Director({
      manager: this.manager,
      combat: this.combat,
      rig: this.rig,
      hud,
      playerPosition: PLAYER_WORLD_POSITION,
      arenaShift: (offsetZ) => this.applyArenaShift(offsetZ),
      onKillWindow: (position) => {
        // Section 8: 0.5 s slow-mo with ember burst on every kill.
        this.startSlowMo(KILL_SLOWMO_SCALE, KILL_SLOWMO_MS);
        this.fire?.spawnBurst(position, UP, {
          flameCount: 16,
          emberCount: 44,
          size: 0.5,
          speed: 3.4,
          spread: 0.8,
          lifetime: 0.5,
          lightIntensity: 4.2,
          lightRadius: 7,
          lightDuration: 0.5,
        });
        this.audio.onKill?.(position);
      },
      onTravelStart: (index) => this.audio.onTravelStart?.(index),
      onTravelEnd: (index) => this.audio.onTravelEnd?.(index),
    });
    this.director.start();

    // --- Input pipeline ----------------------------------------------------
    this.filtered = new FilteredSource(context.source);
    this.detachFrames = this.filtered.onFrame((frame) => {
      this.latestFrame = frame;
      this.frameFresh = true;
      const events = engine.update(frame);
      for (const e of events) this.routeEvent(e);
    });

    // --- The loop ----------------------------------------------------------
    this.clock.start();
    renderer.setAnimationLoop(() => this.tick());
    await this.filtered.start();
  }

  async exit(_root: HTMLElement): Promise<void> {
    this.disposed = true;
    this.renderer?.setAnimationLoop(null);
    if (this.onResize) {
      window.removeEventListener('resize', this.onResize);
      this.onResize = null;
    }
    this.detachFrames?.();
    this.detachFrames = null;
    this.filtered?.stop();
    this.filtered?.dispose();
    this.filtered = null;
    this.director?.dispose();
    this.director = null;
    this.hud?.dispose();
    this.hud = null;
    this.fx?.dispose();
    this.fx = null;
    this.impacts?.dispose();
    this.impacts = null;
    this.fire?.dispose();
    this.fire = null;
    this.manager?.dispose();
    this.manager = null;
    this.physics?.dispose();
    this.physics = null;
    this.arena?.dispose();
    this.arena = null;
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
    this.rig = null;
    this.engine = null;
    this.combat = null;
    this.latestFrame = null;
    this.dmgRef = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private routeEvent(e: MoveEvent): void {
    this.fx?.handleEvent(e);
    this.combat?.handleMoveEvent(e);
    this.audio.onMoveEvent?.(e);
    if (e.empowered && (e.kind === 'trigger' || e.kind === 'sustain-start')) {
      this.empoweredHotUntil = this.elapsed + EMPOWERED_HOT_SEC;
    }
  }

  private startSlowMo(scale: number, ms: number): void {
    this.slowMoScale = scale;
    this.slowMoMs = Math.max(this.slowMoMs, ms);
    this.audio.onSlowMo?.(scale, ms);
  }

  /**
   * Director lane re-base: shift dead constructs' visuals AND physics bodies
   * by +offsetZ so the previous kill relocates behind the player. Alive
   * constructs are skipped (the new one already spawned re-based). See the
   * module header for why the arena group itself stays put.
   */
  private applyArenaShift(offsetZ: number): void {
    if (!this.manager || !this.physics) return;
    for (const construct of this.manager.constructs) {
      if (construct.isAlive) continue;
      construct.group.position.z += offsetZ;
      for (const piece of construct.debris) {
        const t = piece.body.translation();
        piece.body.setTranslation({ x: t.x, y: t.y, z: t.z + offsetZ }, false);
      }
    }
  }

  private tick(): void {
    const renderer = this.renderer;
    const camera = this.camera;
    const scene = this.scene;
    const rig = this.rig;
    if (!renderer || !camera || !scene || !rig) return;

    const rawDt = Math.min(this.clock.getDelta(), MAX_FRAME_DT_SEC);

    // Hit-stop freezes the world; slow-mo stretches it (see module header).
    let dt = rawDt;
    if (this.hitStopMs > 0) {
      this.hitStopMs -= rawDt * 1000;
      dt = 0;
    } else if (this.slowMoMs > 0) {
      this.slowMoMs -= rawDt * 1000;
      dt = rawDt * this.slowMoScale;
    }
    this.elapsed += dt;

    // World systems, in the combat.ts contract order.
    const frame = this.frameFresh ? this.latestFrame : null;
    this.frameFresh = false;
    this.manager?.update(dt);
    this.fx?.update(dt);
    if (frame) this.combat?.update(dt, frame);
    else this.combat?.update(dt);
    this.fire?.update(dt);
    this.impacts?.update(dt);
    this.arena?.update(dt, this.elapsed);

    // Camera and pacing on wall-clock time.
    this.director?.update(rawDt);
    rig.applyHeadPose(this.latestFrame?.face ?? null, rawDt);
    rig.update(rawDt);

    this.updateHud(rawDt, camera, renderer.domElement);

    renderer.render(scene, camera);
  }

  private updateHud(
    rawDt: number,
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
  ): void {
    const hud = this.hud;
    const director = this.director;
    if (!hud || !director) return;

    if (this.engine) hud.setBreath(this.engine.breath);

    const construct = director.currentConstruct;

    // Seal above the construct.
    if (construct) {
      this.tmpWorld
        .copy(construct.group.position)
        .setY(SEAL_ANCHOR_Y);
      projectWorldToScreen(this.tmpWorld, camera, canvas, this.point);
      hud.projectTo(this.point.x, this.point.y, this.point.visible);
    }

    // Damage numbers: poll hp deltas on the current construct (see header).
    if (this.dmgRef !== construct) {
      this.dmgRef = construct;
      this.dmgHp = construct ? construct.hp : 0;
      this.dmgAcc = 0;
      this.dmgTimer = 0;
    } else if (construct) {
      const delta = this.dmgHp - construct.hp;
      if (delta > 0) this.dmgAcc += delta;
      this.dmgHp = construct.hp;
    }
    this.dmgTimer += rawDt;
    const flush =
      this.dmgAcc >= DAMAGE_FLUSH_IMMEDIATE ||
      (this.dmgTimer >= DAMAGE_FLUSH_SEC && this.dmgAcc >= DAMAGE_FLUSH_MIN);
    if (flush && construct) {
      this.tmpWorld.copy(construct.group.position).setY(CHEST_HEIGHT);
      projectWorldToScreen(this.tmpWorld, camera, canvas, this.point);
      if (this.point.visible) {
        hud.damageNumber(this.point.x, this.point.y, this.dmgAcc, {
          empowered: this.elapsed <= this.empoweredHotUntil,
          faceYaw: this.latestFrame?.face?.yaw ?? 0,
        });
      }
      this.dmgAcc = 0;
      this.dmgTimer = 0;
    }

    hud.update(rawDt);
  }
}
