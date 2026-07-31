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
 * COURTYARD (Phase 5, replaced the lane re-base): the arena is a finite
 * courtyard of six authored stations (killTravel.ts). Nothing shifts
 * anymore; dead constructs and their debris stay where they fell as battle
 * scars (the construct manager caps kept debris bodies at ~24 and fades the
 * oldest). On travel arrival the screen relocates the four station point
 * lights to the new station (arena.setActiveStation) and combat aims
 * camera-relative through the rig's base pose (CameraPoseProvider).
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
import { buildArena, COURTYARD_COLLIDERS, type Arena } from '../game/arena';
import { CameraRig, SHOT_POSES } from '../game/cameraRig';
import { stationIndexFor } from '../game/killTravel';
import {
  ConstructManager,
  createPhysicsWorld,
  type CoalProjectile,
  type Construct,
  type PhysicsWorld,
} from '../game/enemies';
import {
  CombatSystem,
  CHEST_HEIGHT,
  KILL_SLOWMO_MS,
  KILL_SLOWMO_SCALE,
  type CameraPoseProvider,
  type EffectsProvider,
} from '../game/combat';
import { configureRenderer } from '../game/renderer';
import { createPostPipeline, type PostPipeline } from '../game/post';
import { Director } from '../game/director';
import { FireSystem, type AmbientFlameHandle } from '../vfx/fire';
import { MoveEffects } from '../vfx/moveEffects';
import { GloveSystem } from '../vfx/gloves';
import { WebcamPip } from '../ui/pip';
import { ImpactSystem } from '../vfx/impact';
import { HUD } from '../ui/hud';
import { EmpowerGlow } from '../ui/empowerGlow';
import { DegradeLadder } from '../game/degrade';
import { SingleHandHint, TrackingLoss } from '../game/trackingLoss';
import { FramingLossWatch } from '../game/framingGate';
import { handOutline } from '../ui/handOutlines';
import { DebugHud } from '../ui/debugHud';
import type { MotionProfile } from '../gestures/profile';

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
  /** A player projectile struck the current construct (damage dealt). */
  onConstructImpact?(damage: number): void;
  /** Camera travel toward construct `index` began / arrived. */
  onTravelStart?(index: number): void;
  onTravelEnd?(index: number): void;
  /** A tier 2 construct lobbed a coal; flight time in seconds (T062). */
  onCoalLob?(flightTimeSec: number): void;
  /** An in-flight coal burst against the Rising Flame wall (T062). */
  onCoalBlocked?(): void;
  /** An in-flight coal completed its arc and landed (T062). */
  onCoalLanded?(): void;
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
   * play omits this and uses velocityScaleFor(stats.wristSpan,
   * stats.shoulderWidth) (real pose shoulder width preferred).
   */
  velocityScale?: number;
  /**
   * Per-player motion profile from the calibration punch/push steps. Fed to
   * the MoveEngine; absent (replay paths) DEFAULT_PROFILE applies.
   */
  profile?: MotionProfile;
  /**
   * Screenshot-harness camera lock (tools/shots.ts): index into SHOT_POSES.
   * The rig pins to that pose and skips travel/parallax/shake entirely.
   */
  shot?: number;
  /**
   * Live camera stream for the webcam PIP panel (Phase 2). Replay paths
   * omit it; the panel then draws skeletons over near-black lacquer.
   */
  stream?: MediaStream;
  /**
   * Bare environment capture (shots harness &bare=1): skip the gloves, PIP
   * and HUD so hero shots show only the world.
   */
  bare?: boolean;
  /**
   * First arena entry of a LIVE session (set by main.ts on the live path
   * only): shows a small parchment hint chip for a few seconds on arrival.
   */
  firstRun?: boolean;
  /**
   * Mid-game framing watch (R3 Phase 3): LIVE path only. When body-pose
   * framing fails continuously for FRAMING_LOSS_SEC the TrackingLoss pause
   * flow triggers with the PIP silhouette guide and the specific corrective
   * line; the framing gate must pass again (2 s hold) before the normal
   * resume countdown runs. Replay paths leave this unset: fixtures are
   * never framing-gated.
   */
  framingGate?: boolean;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const CAMERA_FOV = 55;
/** Largest wall-clock dt a frame will integrate (tab-switch protection). */
const MAX_FRAME_DT_SEC = 0.1;
/** Seal hovers just over the construct's head (~1.9 m above its LOCAL floor). */
const SEAL_ANCHOR_Y = 1.9;
/** Projectile impact kick (a whisper of weight for jabs): base + damage
 *  scaling, capped, brief. Twin Cannon keeps its bigger hit-stop on top. */
const IMPACT_SHAKE_BASE = 0.03;
const IMPACT_SHAKE_PER_DAMAGE = 0.002;
const IMPACT_SHAKE_MAX = 0.09;
const IMPACT_SHAKE_SEC = 0.18;
/** First-run hint chip stays up this long before fading (seconds). */
const FIRST_RUN_HINT_MS = 6000;
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
/** Key light shadow map edge at full quality (matches game/arena.ts). */
const SHADOW_MAP_FULL = 1024;
/** No landmark frame for this long counts as both hands untracked (T070). */
const FRAME_STALE_SEC = 1.0;

const UP = new THREE.Vector3(0, 1, 0);
/** Scratch for construct wound-smoke emission (single threaded). */
const _woundV = new THREE.Vector3();
const WOUND_SMOKE_VEL = new THREE.Vector3(0, 0.55, 0);

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
  private post: PostPipeline | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private arena: Arena | null = null;
  private rig: CameraRig | null = null;
  private physics: PhysicsWorld | null = null;
  private manager: ConstructManager | null = null;
  private fire: FireSystem | null = null;
  private fx: MoveEffects | null = null;
  private gloves: GloveSystem | null = null;
  private pip: WebcamPip | null = null;
  private impacts: ImpactSystem | null = null;
  private engine: MoveEngine | null = null;
  private combat: CombatSystem | null = null;
  private hud: HUD | null = null;
  private glow: EmpowerGlow | null = null;
  /** Coal audio bookkeeping (T062): coals already reported as lobbed. */
  private readonly seenCoals = new WeakSet<CoalProjectile>();
  private trackedCoals: CoalProjectile[] = [];
  private director: Director | null = null;
  private filtered: FilteredSource | null = null;
  private detachFrames: (() => void) | null = null;
  private onResize: (() => void) | null = null;
  private audio: AudioHooks = {};
  private disposed = false;

  // Hardening (T070): degrade ladder, tracking-loss UX, single-hand hint,
  // WebGL context-loss overlay.
  private degrade: DegradeLadder | null = null;
  private readonly ambientHandles: AmbientFlameHandle[] = [];
  private loss: TrackingLoss | null = null;
  private hint: SingleHandHint | null = null;
  private framingWatch: FramingLossWatch | null = null;
  private sinceFrameSec = 0;
  private lossLayer: HTMLElement | null = null;
  private lossCountEl: HTMLElement | null = null;
  private lossTextEl: HTMLElement | null = null;
  private hintChipEl: HTMLElement | null = null;
  private firstRunChipEl: HTMLElement | null = null;
  private firstRunTimer: ReturnType<typeof setTimeout> | null = null;
  private faultLayer: HTMLElement | null = null;
  private onContextLost: ((e: Event) => void) | null = null;

  // Runtime debug keys (Task 1): P flips the parallax yaw sign with a toast.
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private toastEl: HTMLElement | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  // Debug HUD (D key): engine internals overlay, live and replay alike.
  private debugHud: DebugHud | null = null;
  private ctxProfile: MotionProfile | null = null;

  // Frame state (reused, no per-frame allocation).
  private renderedFrames = 0;
  /** Wound-smoke puff accumulator (constructs above 50% damage smolder). */
  private woundSmokeAcc = 0;
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
    configureRenderer(renderer);
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
      this.post?.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this.onResize);

    // Fire before post: the pipeline's half-res fire pass and soft-particle
    // depth fade need the FireSystem at construction (brazier ambients attach
    // after the arena builds, below).
    this.fire = new FireSystem(scene);

    // Post chain (Phase 6 + fire rebuild): half-res fire pass with depth-aware
    // upsample and heat shimmer, then bloom + grain + vignette. The perf gate
    // renders through the same pipeline, so the budget numbers cover it.
    this.post = createPostPipeline(renderer, scene, camera, { fire: this.fire });

    // --- World systems -----------------------------------------------------
    this.arena = buildArena(scene);
    this.rig = new CameraRig(camera);
    const shotPose = context.shot !== undefined ? SHOT_POSES[context.shot] : undefined;
    if (shotPose) this.rig.lockForShot(shotPose.position, shotPose.look);
    this.physics = await createPhysicsWorld();
    if (this.disposed) {
      // exit() raced the rapier init; tear down what enter built so far.
      this.physics.dispose();
      this.physics = null;
      return;
    }
    // Raised courtyard structures (terrace, steps, bridge deck) get static
    // colliders so death debris can rest on them as battle scars.
    for (const solid of COURTYARD_COLLIDERS) {
      this.physics.world.createCollider(
        this.physics.rapier.ColliderDesc.cuboid(...solid.halfExtents)
          .setTranslation(...solid.center)
          .setFriction(0.9),
      );
    }
    this.manager = new ConstructManager(this.physics, scene);

    // FireSystem was constructed before the post chain (see above); the
    // brazier ambients attach here once the arena's anchors exist.
    for (const anchor of this.arena.brazierAnchors) {
      // Handles kept so the degrade ladder can scale ambient flames (T070).
      this.ambientHandles.push(this.fire.attachAmbient(anchor, BRAZIER_FLAME_SCALE));
    }
    this.fx = new MoveEffects(scene, this.fire, camera, this.rig);
    this.impacts = new ImpactSystem(scene, this.fire);

    // In-world gloves (Phase 2): the player's hands, always on, EXCEPT in
    // bare environment captures (ctx.bare: the shots harness hero angles),
    // where camera-attached overlays would photobomb the composition.
    if (!context.bare) {
      this.gloves = new GloveSystem(scene, this.fire, camera);
      // Webcam PIP mirror panel (Phase 2): C toggles, on by default.
      this.pip = new WebcamPip(root, context.stream);
    }

    // --- Gesture engine ----------------------------------------------------
    // Real shoulder width (body pose) preferred over the wrist-span proxy.
    const velocityScale =
      context.velocityScale ??
      velocityScaleFor(context.stats.wristSpan, context.stats.shoulderWidth);
    this.ctxProfile = context.profile ?? null;
    this.engine = new MoveEngine({
      velocityScale,
      ...(context.profile ? { profile: context.profile } : {}),
    });

    // --- Combat (MoveEffects adapter per the combat.ts header) -------------
    const fx = this.fx;
    const effectsProvider: EffectsProvider = {
      get projectiles() {
        return fx.projectiles;
      },
      wallActiveUntil: () => (fx.activeWall ? fx.activeWall.until : null),
    };
    if (!context.bare) {
      this.glow = new EmpowerGlow(root); // under the HUD in paint order
      this.hud = new HUD(root);
    }
    const hud = this.hud;
    const engine = this.engine;
    // Camera-relative combat frame (Phase 5): screen aim maps through the
    // rig's undeflected base pose at the current station.
    const rig = this.rig;
    const cameraPose: CameraPoseProvider = {
      // Allocation-free refs (GC audit): combat copies into scratch each
      // frame, so the cloning getters would cost two heap objects per tick.
      position: () => rig.basePositionRef,
      quaternion: () => rig.baseQuaternionRef,
    };
    this.combat = new CombatSystem({
      manager: this.manager,
      effects: effectsProvider,
      impacts: this.impacts,
      cameraPose,
      onHitStop: (ms) => {
        this.hitStopMs = Math.max(this.hitStopMs, ms);
        this.audio.onHitStop?.(ms);
      },
      onSlowMo: (scale, ms) => this.startSlowMo(scale, ms),
      // Every discrete projectile impact lands a small physical kick; the
      // clamp keeps a jab a tap and a twin-cannon slug still modest (its
      // real weight is the hit-stop).
      onImpact: (_position, damage) => {
        rig.shake(
          Math.min(IMPACT_SHAKE_BASE + damage * IMPACT_SHAKE_PER_DAMAGE, IMPACT_SHAKE_MAX),
          IMPACT_SHAKE_SEC,
        );
        this.audio.onConstructImpact?.(damage);
      },
      onPlayerHit: (damage) => {
        hud?.playerHitFlash();
        this.audio.onPlayerHit?.(damage);
      },
      onBreathPenalty: (amount) => engine.spend(amount),
    });

    // --- Director ----------------------------------------------------------
    // Shot harness: start the chain at the captured station so the shot
    // frames its own construct at its own anchor with its station lights.
    const startIndex =
      context.shot !== undefined && shotPose ? context.shot - 1 : 0;
    this.director = new Director({
      manager: this.manager,
      combat: this.combat,
      rig: this.rig,
      startIndex,
      ...(hud ? { hud } : {}),
      cameraPose,
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
      onTravelEnd: (index) => {
        // Light policy: the four station point lights relocate to the
        // ACTIVE station on arrival (all braziers burn emissive-only).
        this.arena?.setActiveStation(stationIndexFor(index));
        this.audio.onTravelEnd?.(index);
      },
    });
    this.director.start();
    // The four relocatable station lights start at the first construct's
    // station (relevant when the shot harness starts mid-cycle).
    this.arena.setActiveStation(stationIndexFor(startIndex));

    // Screenshot/debug hook: drive the active construct to an exact damage
    // percent (0..100; 100 kills it). Zero impulse keeps stills clean.
    (window as unknown as { __FB_DAMAGE?: (pct: number) => void }).__FB_DAMAGE = (pct) => {
      const construct = this.manager?.activeConstruct;
      if (!construct) return;
      const target = construct.maxHp * (1 - Math.min(Math.max(pct, 0), 100) / 100);
      const damage = construct.hp - target;
      if (damage <= 0) return;
      construct.takeHit(
        damage,
        new THREE.Vector3(0, 0, 0),
        construct.group.position.clone().add(new THREE.Vector3(0, 1.3, 0)),
      );
    };

    // --- Hardening (T070) --------------------------------------------------
    // Degrade ladder: particle scale -> MoveEffects + ambient braziers, pose
    // rate -> live source (replay sources lack the setter: no-op), shadows
    // -> renderer + key light shadow map. (No face rung: head pose rides
    // the pose samples since R3 Phase 2.)
    const maybeLive = context.source as Partial<{
      setPoseIntervalMultiplier(multiplier: number): void;
    }>;
    this.degrade = new DegradeLadder({
      setParticleScale: (scale) => {
        if (this.fx) this.fx.intensityScale = scale;
        for (const handle of this.ambientHandles) {
          handle.scale = BRAZIER_FLAME_SCALE * scale;
        }
      },
      setPoseIntervalMultiplier: (multiplier) => {
        maybeLive.setPoseIntervalMultiplier?.(multiplier);
      },
      setShadowHalved: (halved) => this.setShadowHalved(halved),
    });

    // Tracking-loss pause overlay + single-hand hint chip.
    this.loss = new TrackingLoss();
    this.hint = new SingleHandHint();
    // Mid-game framing watch: LIVE path only (ctx.framingGate); replay
    // fixtures must never be framing-gated.
    this.framingWatch = context.framingGate ? new FramingLossWatch() : null;
    this.buildLossOverlay(root);
    this.buildHintChip(root);

    // First-run hint (live flow only): fade in on arrival, out after 6 s.
    if (context.firstRun && !context.bare) this.buildFirstRunChip(root);

    // Debug HUD overlay (D key), hidden until toggled.
    this.debugHud = new DebugHud(root);

    // Runtime keys: P toggles the parallax yaw sign (Section 8 verification),
    // D toggles the debug HUD (and the engine's near-miss diagnostics).
    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'p' || e.key === 'P') {
        const rig = this.rig;
        if (!rig) return;
        rig.parallaxYawSign = -rig.parallaxYawSign;
        const windowStyle = rig.parallaxYawSign < 0;
        this.showToast(
          root,
          windowStyle
            ? 'Parallax yaw: head left pans left (window style, default)'
            : 'Parallax yaw: head left pans right (flipped)',
        );
      } else if (e.key === 'c' || e.key === 'C') {
        const pip = this.pip;
        if (!pip) return;
        this.showToast(
          root,
          pip.toggle() ? 'Camera panel shown' : 'Camera panel hidden',
        );
      } else if (e.key === 'd' || e.key === 'D') {
        const hud = this.debugHud;
        const eng = this.engine;
        if (!hud || !eng) return;
        if (hud.visible) {
          hud.hide();
          eng.debugEnabled = false;
        } else {
          hud.show();
          eng.debugEnabled = true; // near-miss tracing only while open
        }
      }
    };
    window.addEventListener('keydown', this.onKeyDown);

    // WebGL context loss: the flame guttered.
    this.onContextLost = (e: Event) => {
      e.preventDefault();
      this.showContextLossOverlay(root);
    };
    renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);

    // --- Input pipeline ----------------------------------------------------
    this.filtered = new FilteredSource(context.source);
    this.detachFrames = this.filtered.onFrame((frame) => {
      this.latestFrame = frame;
      this.frameFresh = true;
      this.sinceFrameSec = 0;
      this.pip?.setFrame(frame);
      // While the tracking-loss overlay is up the world is frozen: keep the
      // engine idle too so no move can fire into the paused arena.
      if (this.loss && this.loss.paused) return;
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
    if (this.renderer && this.onContextLost) {
      this.renderer.domElement.removeEventListener(
        'webglcontextlost',
        this.onContextLost,
      );
    }
    this.onContextLost = null;
    if (this.onKeyDown) {
      window.removeEventListener('keydown', this.onKeyDown);
      this.onKeyDown = null;
    }
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toastEl?.remove();
    this.toastEl = null;
    this.debugHud?.dispose();
    this.debugHud = null;
    this.ctxProfile = null;
    this.degrade = null;
    this.loss = null;
    this.hint = null;
    this.framingWatch = null;
    this.ambientHandles.length = 0;
    this.lossLayer?.remove();
    this.lossLayer = null;
    this.lossCountEl = null;
    this.lossTextEl = null;
    this.hintChipEl?.remove();
    this.hintChipEl = null;
    if (this.firstRunTimer !== null) {
      clearTimeout(this.firstRunTimer);
      this.firstRunTimer = null;
    }
    this.firstRunChipEl?.remove();
    this.firstRunChipEl = null;
    this.faultLayer?.remove();
    this.faultLayer = null;
    this.detachFrames?.();
    this.detachFrames = null;
    this.filtered?.stop();
    this.filtered?.dispose();
    this.filtered = null;
    this.director?.dispose();
    this.director = null;
    this.hud?.dispose();
    this.hud = null;
    this.glow?.dispose();
    this.glow = null;
    this.trackedCoals = [];
    this.pip?.dispose();
    this.pip = null;
    this.gloves?.dispose();
    this.gloves = null;
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
    this.post?.dispose();
    this.post = null;
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

  /**
   * Damage staging (Section 11): constructs above 50% damage smolder. Thin
   * dark smoke rises from the wound point, rate scaling with damage. Uses
   * the shared smoke emitter pool; a fraction of a puff per frame at most.
   */
  private updateWoundSmoke(dt: number): void {
    const fire = this.fire;
    const manager = this.manager;
    if (!fire || !manager) return;
    for (const c of manager.constructs) {
      const s = c.smokeIntensity;
      if (s <= 0) continue;
      this.woundSmokeAcc += (1.5 + 5 * s) * dt;
      const n = Math.floor(this.woundSmokeAcc);
      if (n > 0 && c.smokeSource(_woundV)) {
        this.woundSmokeAcc -= n;
        fire.smoke.spawn({
          position: _woundV,
          count: Math.min(n, 3),
          size: 0.3 + 0.25 * s,
          lifetime: 2.4,
          velocity: WOUND_SMOKE_VEL,
          spread: 0.12,
        });
      }
    }
  }

  private startSlowMo(scale: number, ms: number): void {
    this.slowMoScale = scale;
    this.slowMoMs = Math.max(this.slowMoMs, ms);
    this.audio.onSlowMo?.(scale, ms);
  }

  private tick(): void {
    // Screenshot-harness stability signal: after 30 rendered frames the
    // scene is warmed (lights settled, first particles alive) and
    // tools/shots.ts may capture. Kept low because headless SwiftShader
    // renders a few fps at best; 90 frames blew the harness timeout.
    this.renderedFrames++;
    if (this.renderedFrames === 30) {
      (window as unknown as { __FB_READY?: boolean }).__FB_READY = true;
    }
    const renderer = this.renderer;
    const camera = this.camera;
    const scene = this.scene;
    const rig = this.rig;
    if (!renderer || !camera || !scene || !rig) return;

    const rawDt = Math.min(this.clock.getDelta(), MAX_FRAME_DT_SEC);
    this.sinceFrameSec += rawDt;

    // Tracking-loss and single-hand FSMs (T070). A stale landmark stream
    // (source stopped emitting) counts the same as both hands untracked.
    const stale = this.sinceFrameSec > FRAME_STALE_SEC;
    const latest = this.latestFrame;
    const leftTracked = !stale && latest !== null && latest.left !== null;
    const rightTracked = !stale && latest !== null && latest.right !== null;
    // Mid-game framing watch (R3 Phase 3, live only): a framing loss forces
    // the same pause flow; resuming demands the framing gate pass again.
    if (this.framingWatch && latest !== null && !stale) {
      this.framingWatch.update(latest, rawDt);
    }
    const framingLost = this.framingWatch?.lost ?? false;
    if (this.framingWatch) {
      this.pip?.setFramingState(this.framingWatch.gateState);
    }
    if (this.loss) {
      this.loss.update(
        leftTracked && rightTracked && !framingLost,
        rawDt,
        (leftTracked || rightTracked) && !framingLost,
        framingLost,
      );
      this.syncLossOverlay();
    }
    const paused = this.loss !== null && this.loss.paused;
    if (this.hint && !paused) {
      for (const ev of this.hint.update(leftTracked, rightTracked, rawDt)) {
        this.hintChipEl?.classList.toggle('is-on', ev === 'show');
      }
    }

    if (!paused) {
      // Frame-time feed for the degrade ladder (wall clock, ms). Paused
      // frames are cheap by construction and would only pump the step-up
      // counter, so they are not fed.
      this.degrade?.update(rawDt * 1000);

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
      this.updateWoundSmoke(dt);
      this.fx?.update(dt);
      if (frame) this.combat?.update(dt, frame);
      else this.combat?.update(dt);
      this.fire?.update(dt);
      this.impacts?.update(dt);
      this.arena?.update(dt, this.elapsed);
      // Gloves ARE the hands: pose from the latest frame on world dt so
      // hit-stop freezes them with everything else.
      this.gloves?.update(
        dt,
        this.latestFrame,
        this.fx !== null && this.fx.chargeIsActive,
      );
      this.pollCoals();

      // Breath Charge empowerment glow follows the exposed charge window.
      this.glow?.update(this.fx !== null && this.fx.chargeIsActive, rawDt);

      // Director pacing on wall-clock time.
      this.director?.update(rawDt);
    }

    // Camera keeps breathing while the world is frozen (Section 8 parallax
    // and idle sway), so the pause never reads as a hang.
    rig.applyHeadPose(this.latestFrame?.face ?? null, rawDt);
    rig.update(rawDt);

    this.updateHud(rawDt, camera, renderer.domElement);

    // Webcam PIP mirror: display-rate redraw, skips itself while hidden.
    this.pip?.render();

    // Debug HUD: pulls engine/rig state; internally throttled to ~10 Hz.
    if (this.debugHud && this.debugHud.visible && this.engine) {
      this.debugHud.update(performance.now(), {
        engine: this.engine,
        frame: this.latestFrame,
        profile: this.ctxProfile,
        parallax: rig.parallaxState,
        parallaxYawSign: rig.parallaxYawSign,
      });
    }

    if (this.post) this.post.render(rawDt);
    else renderer.render(scene, camera);
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

    // Seal above the construct (anchored to its LOCAL floor height: bridge
    // stations stand raised).
    if (construct) {
      this.tmpWorld
        .copy(construct.group.position)
        .setY(construct.group.position.y + SEAL_ANCHOR_Y);
      projectWorldToScreen(this.tmpWorld, camera, canvas, this.point);
      hud.projectTo(this.point.x, this.point.y, this.point.visible);
      // Crack lines follow the construct's hp (<75/50/25% reveal 1/2/3).
      hud.setSealDamage(construct.damagePercent);
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
      this.tmpWorld
        .copy(construct.group.position)
        .setY(construct.group.position.y + CHEST_HEIGHT);
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

  // -------------------------------------------------------------------------
  // Hardening internals (T070)
  // -------------------------------------------------------------------------

  /** Degrade rung 3: rebuild the key light shadow map at half resolution. */
  private setShadowHalved(halved: boolean): void {
    const key = this.arena?.lights.key;
    const renderer = this.renderer;
    if (!key || !renderer) return;
    const edge = halved ? SHADOW_MAP_FULL / 2 : SHADOW_MAP_FULL;
    key.shadow.mapSize.set(edge, edge);
    // The old render target is the wrong size; dispose it and let the
    // renderer rebuild lazily on the next shadow pass.
    key.shadow.map?.dispose();
    key.shadow.map = null;
    renderer.shadowMap.needsUpdate = true;
  }

  /** Parchment "Show your hands." overlay plus the ember resume countdown. */
  private buildLossOverlay(root: HTMLElement): void {
    const layer = document.createElement('div');
    layer.className = 'fb-loss';
    const panel = document.createElement('div');
    panel.className = 'fb-panel fb-loss-panel';
    const hands = document.createElement('div');
    hands.className = 'fb-loss-hands';
    hands.append(handOutline('left'), handOutline('right'));
    const text = document.createElement('div');
    text.className = 'fb-loss-text';
    text.textContent = 'Show your hands.';
    panel.append(hands, text);
    const count = document.createElement('div');
    count.className = 'fb-loss-count';
    layer.append(panel, count);
    root.appendChild(layer);
    this.lossLayer = layer;
    this.lossCountEl = count;
    this.lossTextEl = text;
  }

  /** Transient bottom-center chip for runtime toggles (P key feedback). */
  private showToast(root: HTMLElement, text: string): void {
    if (!this.toastEl) {
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.bottom = '12%';
      el.style.left = '50%';
      el.style.transform = 'translateX(-50%)';
      el.style.padding = '8px 18px';
      el.style.background = 'rgba(13, 10, 8, 0.85)';
      el.style.border = '1px solid rgba(201, 119, 46, 0.5)';
      el.style.borderRadius = '4px';
      el.style.color = '#e0a458';
      el.style.font = '14px/1.4 serif';
      el.style.letterSpacing = '0.04em';
      el.style.pointerEvents = 'none';
      el.style.zIndex = '40';
      root.appendChild(el);
      this.toastEl = el;
    }
    this.toastEl.textContent = text;
    this.toastEl.style.display = 'block';
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (this.toastEl) this.toastEl.style.display = 'none';
      this.toastTimer = null;
    }, 2500);
  }

  /** Non-blocking single-hand hint chip (hidden until the FSM says show). */
  private buildHintChip(root: HTMLElement): void {
    const chip = document.createElement('div');
    chip.className = 'fb-hint-chip';
    chip.textContent = 'One hand found. Fist moves ready.';
    root.appendChild(chip);
    this.hintChipEl = chip;
  }

  /** First-run parchment chip: fades in at arrival, out after 6 seconds. */
  private buildFirstRunChip(root: HTMLElement): void {
    const chip = document.createElement('div');
    chip.className = 'fb-hint-chip fb-hint-chip--firstrun';
    chip.textContent =
      'Punch at the screen. Palm pushes wave fire. D shows why a move did not fire.';
    root.appendChild(chip);
    this.firstRunChipEl = chip;
    // Next frame so the initial opacity: 0 commits and the fade-in runs.
    requestAnimationFrame(() => chip.classList.add('is-on'));
    this.firstRunTimer = setTimeout(() => {
      chip.classList.remove('is-on');
      this.firstRunTimer = null;
    }, FIRST_RUN_HINT_MS);
  }

  /** Mirror the TrackingLoss state onto the overlay DOM, once per frame. */
  private syncLossOverlay(): void {
    const loss = this.loss;
    const layer = this.lossLayer;
    if (!loss || !layer) return;
    layer.classList.toggle('is-on', loss.paused);
    layer.classList.toggle('is-counting', loss.state === 'resuming');
    // Framing loss reuses the pause panel with the SPECIFIC corrective line
    // (the PIP shows the silhouette guide); hand loss keeps the classic text.
    const gateState = this.framingWatch?.gateState ?? null;
    const lossText =
      gateState !== null
        ? gateState.top !== null
          ? gateState.top.text
          : 'Hold your stance.'
        : 'Show your hands.';
    if (this.lossTextEl && this.lossTextEl.textContent !== lossText) {
      this.lossTextEl.textContent = lossText;
    }
    const count = this.lossCountEl;
    if (count && loss.state === 'resuming') {
      const digit = String(loss.countdownStep);
      if (count.textContent !== digit) {
        count.textContent = digit;
        // Restart the ember pop animation for each digit.
        count.style.animation = 'none';
        void count.offsetWidth;
        count.style.animation = '';
      }
    } else if (count && count.textContent !== '') {
      count.textContent = '';
    }
  }

  /** WebGL context loss: parchment fault with a Reload button. */
  private showContextLossOverlay(root: HTMLElement): void {
    if (this.faultLayer) return;
    const layer = document.createElement('div');
    layer.className = 'fb-screen-layer fb-gate fb-fault';
    const panel = document.createElement('div');
    panel.className = 'fb-panel fb-gate-panel';
    const body = document.createElement('p');
    body.className = 'fb-gate-body';
    body.textContent = 'The flame guttered. Reload to rekindle.';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fb-reload-btn';
    button.textContent = 'Reload';
    button.addEventListener('click', () => window.location.reload());
    panel.append(body, button);
    layer.appendChild(panel);
    root.appendChild(layer);
    this.faultLayer = layer;
  }

  /**
   * Coal audio pass-throughs (T062, append-only): the combat layer owns coal
   * resolution but exposes no events, so the screen diffs the constructs'
   * projectile lists once per frame. A newly seen coal fires onCoalLob; a
   * coal that vanished after completing its flight landed (onCoalLanded);
   * one removed mid-flight was blocked by the Rising Flame wall
   * (onCoalBlocked). Counts are tiny (a handful of coals at most).
   */
  private pollCoals(): void {
    const manager = this.manager;
    if (!manager) return;
    for (const construct of manager.constructs) {
      for (const coal of construct.projectiles) {
        if (this.seenCoals.has(coal)) continue;
        this.seenCoals.add(coal);
        this.trackedCoals.push(coal);
        this.audio.onCoalLob?.(coal.flightTime);
      }
    }
    for (let i = this.trackedCoals.length - 1; i >= 0; i--) {
      const coal = this.trackedCoals[i];
      if (!coal) {
        this.trackedCoals.splice(i, 1);
        continue;
      }
      let present = false;
      for (const construct of manager.constructs) {
        if (construct.projectiles.includes(coal)) {
          present = true;
          break;
        }
      }
      if (present) continue;
      this.trackedCoals.splice(i, 1);
      if (coal.age >= coal.flightTime) this.audio.onCoalLanded?.();
      else this.audio.onCoalBlocked?.();
    }
  }
}
