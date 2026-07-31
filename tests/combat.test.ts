// Headless combat + HUD-logic checks (T051). Real ConstructManager with real
// rapier physics (proven in node by enemies.test.ts); the effects layer is a
// hand-rolled fake matching the structural EffectsProvider interface.

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  ConstructManager,
  createPhysicsWorld,
  FIXED_TIMESTEP,
  type PhysicsWorld,
} from '../src/game/enemies';
import {
  beamOriginToWorld,
  COAL_DAMAGE,
  CombatSystem,
  DAMAGE_TABLE,
  DuckDetector,
  KILL_SLOWMO_MS,
  KILL_SLOWMO_SCALE,
  PLAYER_HIT_BREATH_PENALTY,
  PLAYER_WORLD_POSITION,
  screenAimToWorld,
  torsoCenterY,
  TWIN_HIT_STOP_MS,
  type EffectsProvider,
  type ProjectileEffectLike,
} from '../src/game/combat';
import { EMPOWER_MULTIPLIER, type MoveEvent, type MoveName } from '../src/gestures/moves';
import {
  approach,
  DAMAGE_NUMBER_JITTER_DEG,
  DAMAGE_NUMBER_SECONDS,
  DamageNumberLedger,
  damageNumberRotationDeg,
  sealCrackLevel,
  sideBiasFromYaw,
} from '../src/ui/hud';
import type { LandmarkFrame, PoseFrame } from '../src/tracking/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAR_ANCHOR = new THREE.Vector3(0, 0, -6); // 6 m ahead of the player
const CHEST = new THREE.Vector3(0, 1.25, -6);

interface FakeEffects extends EffectsProvider {
  projectiles: ProjectileEffectLike[];
  wallUntil: number | null;
}

function makeEffects(): FakeEffects {
  const state: FakeEffects = {
    projectiles: [],
    wallUntil: null,
    wallActiveUntil: () => state.wallUntil,
  };
  return state;
}

interface FakeProjectile extends ProjectileEffectLike {
  onImpact: ReturnType<typeof vi.fn>;
}

function makeProjectile(
  sourceMove: MoveName,
  position: THREE.Vector3,
  radius = 0.3,
  empowered?: boolean,
): FakeProjectile {
  return {
    position: position.clone(),
    radius,
    sourceMove,
    ...(empowered !== undefined ? { empowered } : {}),
    onImpact: vi.fn(),
  };
}

function ev(partial: Partial<MoveEvent> & { move: MoveName }): MoveEvent {
  return {
    hand: 'right',
    t: 0,
    aim: { x: 0, y: 0, z: -1 },
    origin: { x: 0.5, y: 0.5, z: 0 },
    empowered: false,
    kind: 'trigger',
    triggerLatencyMs: 0,
    ...partial,
  };
}

function faceFrame(tMs: number, headY: number): LandmarkFrame {
  return {
    t: tMs,
    left: null,
    right: null,
    face: {
      yaw: 0,
      pitch: 0,
      position: { x: 0.5, y: headY, z: 0 },
      confidence: 1,
    },
  };
}

/** Body pose whose shoulders sit at torsoY - 0.15 and hips at torsoY + 0.15;
 *  with the hip-heavy COM weighting torsoCenterY(pose) === torsoY + 0.03,
 *  a constant offset that every relative duck threshold absorbs. */
function bodyPose(tMs: number, torsoY: number): PoseFrame {
  const arm = (m: number) => ({
    shoulder: { x: 0.5 + 0.12 * m, y: torsoY - 0.15, z: 0 },
    elbow: { x: 0.5 + 0.16 * m, y: torsoY, z: 0 },
    wrist: { x: 0.5 + 0.2 * m, y: torsoY + 0.05, z: 0 },
    hip: { x: 0.5 + 0.08 * m, y: torsoY + 0.15, z: 0 },
  });
  return { t: tMs, left: arm(-1), right: arm(1), world: null, confidence: 1 };
}

function poseFrame(
  tMs: number,
  torsoY: number,
  headY: number | null = null,
): LandmarkFrame {
  const base = headY !== null ? faceFrame(tMs, headY) : { t: tMs, left: null, right: null, face: null };
  return { ...base, pose: bodyPose(tMs, torsoY) };
}

async function setup(): Promise<{
  physics: PhysicsWorld;
  manager: ConstructManager;
  root: THREE.Group;
}> {
  const physics = await createPhysicsWorld();
  const root = new THREE.Group();
  const manager = new ConstructManager(physics, root);
  return { physics, manager, root };
}

// ---------------------------------------------------------------------------
// Damage table
// ---------------------------------------------------------------------------

describe('DAMAGE_TABLE', () => {
  it('matches the Section 7 semantics folded to the 7-move set', () => {
    expect(DAMAGE_TABLE['jab-blast']).toEqual({ damage: 8, impulse: 0, perSecond: false });
    expect(DAMAGE_TABLE['cross-combo']).toEqual({ damage: 18, impulse: 20, perSecond: false });
    expect(DAMAGE_TABLE['fire-stream']).toEqual({ damage: 14, impulse: 0, perSecond: true });
    expect(DAMAGE_TABLE['twin-cannon']).toEqual({ damage: 42, impulse: 40, perSecond: false });
    expect(DAMAGE_TABLE['rising-flame']).toEqual({ damage: 0, impulse: 0, perSecond: false });
    expect(DAMAGE_TABLE['fire-whip']).toEqual({ damage: 16, impulse: 14, perSecond: false });
    expect(DAMAGE_TABLE['breath-charge']).toEqual({ damage: 0, impulse: 0, perSecond: false });
    // Hearth Wave and Ember Fan are retired: the table carries exactly 7 moves.
    expect(Object.keys(DAMAGE_TABLE)).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Screen-to-world mapping
// ---------------------------------------------------------------------------

describe('screen-to-world mapping', () => {
  it('maps screen aim into world space (y flips, forward stays -z)', () => {
    const forward = screenAimToWorld({ x: 0, y: 0, z: -1 });
    expect(forward.x).toBeCloseTo(0, 6);
    expect(forward.y).toBeCloseTo(0, 6);
    expect(forward.z).toBeCloseTo(-1, 6);

    const down = screenAimToWorld({ x: 0, y: 1, z: 0 }); // screen y grows down
    expect(down.y).toBeCloseTo(-1, 6);

    const zero = screenAimToWorld({ x: 0, y: 0, z: 0 }); // degenerate: forward
    expect(zero.z).toBeCloseTo(-1, 6);
  });

  it('maps a centered wrist origin onto the player position', () => {
    const origin = beamOriginToWorld({ x: 0.5, y: 0.5, z: 0 }, PLAYER_WORLD_POSITION);
    expect(origin.x).toBeCloseTo(PLAYER_WORLD_POSITION.x, 6);
    expect(origin.y).toBeCloseTo(PLAYER_WORLD_POSITION.y, 6);
    expect(origin.z).toBeCloseTo(PLAYER_WORLD_POSITION.z, 6);
  });

  it('rotates screen aim into the camera frame when a quaternion is given', () => {
    // Camera yawed -90 degrees: its forward (-z screen) is world +x.
    const quat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      -Math.PI / 2,
    );
    const forward = screenAimToWorld({ x: 0, y: 0, z: -1 }, quat);
    expect(forward.x).toBeCloseTo(1, 6);
    expect(forward.z).toBeCloseTo(0, 6);
    // Screen-right maps to the camera's right (world +z here).
    const rightward = screenAimToWorld({ x: 1, y: 0, z: 0 }, quat);
    expect(rightward.z).toBeCloseTo(1, 6);
    // Wrist offsets run along the camera's axes too.
    const origin = beamOriginToWorld(
      { x: 1.0, y: 0.5, z: 0 },
      new THREE.Vector3(2, 1.4, -8),
      quat,
    );
    expect(origin.x).toBeCloseTo(2, 6);
    expect(origin.z).toBeCloseTo(-8 + 0.6, 6); // half of ORIGIN_SPAN_X along +z
  });
});

// ---------------------------------------------------------------------------
// Camera-relative combat frame (Phase 5 stations)
// ---------------------------------------------------------------------------

describe('camera-relative combat frame', () => {
  // The station camera stands at (2, 1.4, -8) looking along world +x.
  const EYE = new THREE.Vector3(2, 1.4, -8);
  const QUAT = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    -Math.PI / 2,
  );
  const provider = {
    position: () => EYE.clone(),
    quaternion: () => QUAT.clone(),
  };

  it('sustained beams aimed at screen center hit the construct down the camera forward', async () => {
    const { physics, manager } = await setup();
    // 6 m in FRONT of the rotated camera: along +x.
    const construct = manager.spawn(new THREE.Vector3(8, 0, -8), 1);
    const effects = makeEffects();
    const combat = new CombatSystem({ manager, effects, cameraPose: provider });

    combat.handleMoveEvent(ev({ move: 'fire-stream', kind: 'sustain-start', t: 1000 }));
    for (let i = 1; i <= 10; i++) {
      combat.handleMoveEvent(ev({ move: 'fire-stream', kind: 'sustain-tick', t: 1000 + i * 100 }));
    }
    expect(construct.hp).toBeCloseTo(100 - 14, 4);

    manager.dispose();
    physics.dispose();
  });

  it('a construct down world -z is NOT hit when the camera faces +x', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(new THREE.Vector3(2, 0, -14), 1); // behind the frame
    const effects = makeEffects();
    const combat = new CombatSystem({ manager, effects, cameraPose: provider });

    combat.handleMoveEvent(ev({ move: 'fire-stream', kind: 'sustain-start', t: 0 }));
    for (let i = 1; i <= 10; i++) {
      combat.handleMoveEvent(ev({ move: 'fire-stream', kind: 'sustain-tick', t: i * 100 }));
    }
    expect(construct.hp).toBe(100);

    manager.dispose();
    physics.dispose();
  });

  it('fire-whip works in the rotated frame at close range', async () => {
    const { physics, manager } = await setup();
    const near = manager.spawn(new THREE.Vector3(4.5, 0, -8), 1); // 2.5 m ahead
    const effects = makeEffects();
    const combat = new CombatSystem({ manager, effects, cameraPose: provider });

    combat.handleMoveEvent(ev({ move: 'fire-whip', t: 200, aim: { x: 1, y: 0, z: 0 } }));
    expect(near.hp).toBeCloseTo(100 - 16, 6);

    manager.dispose();
    physics.dispose();
  });

  it('coal defense follows the camera frame: wall blocks, otherwise the player is hit', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(new THREE.Vector3(8, 0, -8), 2);
    const effects = makeEffects();
    const onPlayerHit = vi.fn();
    const combat = new CombatSystem({
      manager,
      effects,
      onPlayerHit,
      cameraPose: provider,
    });

    // No wall: the coal arcs to the eye position and hits the player.
    construct.startLobbing(EYE, 1.0);
    const dt = FIXED_TIMESTEP;
    for (let t = 0; t < 2.6; t += dt) {
      combat.update(dt);
      manager.update(dt);
    }
    expect(onPlayerHit).toHaveBeenCalledTimes(1);

    // Wall up: the next coal bursts against the camera-relative plane.
    onPlayerHit.mockClear();
    effects.wallUntil = Number.POSITIVE_INFINITY;
    construct.startLobbing(EYE, 1.0);
    for (let t = 0; t < 2.6; t += dt) {
      combat.update(dt);
      manager.update(dt);
      if (construct.projectiles.length > 0) construct.stopLobbing();
    }
    expect(onPlayerHit).not.toHaveBeenCalled();
    expect(construct.projectiles.length).toBe(0);

    manager.dispose();
    physics.dispose();
  });

  it('hits an elevated construct at its raised chest height (bridge deck)', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(new THREE.Vector3(0, 0, -6), 1, undefined, 0.5);
    const effects = makeEffects();
    const combat = new CombatSystem({ manager, effects });

    // Chest sits at floorY + 1.25.
    effects.projectiles.push(makeProjectile('jab-blast', new THREE.Vector3(0, 1.75, -6)));
    combat.update(FIXED_TIMESTEP);
    expect(construct.hp).toBeCloseTo(92, 6);

    manager.dispose();
    physics.dispose();
  });
});

// ---------------------------------------------------------------------------
// Projectile hits
// ---------------------------------------------------------------------------

describe('projectile hits', () => {
  it('applies table damage once, calls onImpact and burst', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(FAR_ANCHOR, 1); // hp 100
    const effects = makeEffects();
    const burst = vi.fn();
    const combat = new CombatSystem({ manager, effects, impacts: { burst } });

    const p = makeProjectile('jab-blast', CHEST);
    effects.projectiles.push(p);
    combat.update(FIXED_TIMESTEP);

    expect(construct.hp).toBeCloseTo(100 - 8, 6);
    expect(p.onImpact).toHaveBeenCalledTimes(1);
    expect(burst).toHaveBeenCalledTimes(1);

    // Consumed: the same projectile never hits twice.
    combat.update(FIXED_TIMESTEP);
    expect(construct.hp).toBeCloseTo(92, 6);
    expect(p.onImpact).toHaveBeenCalledTimes(1);

    manager.dispose();
    physics.dispose();
  });

  it('fires deps.onImpact with the hit position and damage on a jab hit', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(FAR_ANCHOR, 1);
    const effects = makeEffects();
    const onImpact = vi.fn();
    const combat = new CombatSystem({ manager, effects, onImpact });

    effects.projectiles.push(makeProjectile('jab-blast', CHEST));
    combat.update(FIXED_TIMESTEP);

    expect(construct.hp).toBeCloseTo(92, 6);
    expect(onImpact).toHaveBeenCalledTimes(1);
    const [position, damage] = onImpact.mock.calls[0] as [THREE.Vector3, number];
    expect(position).toBeInstanceOf(THREE.Vector3);
    expect(position.distanceTo(CHEST)).toBeLessThan(1);
    expect(damage).toBeCloseTo(DAMAGE_TABLE['jab-blast'].damage, 6);

    // Consumed projectile: no second kick.
    combat.update(FIXED_TIMESTEP);
    expect(onImpact).toHaveBeenCalledTimes(1);

    manager.dispose();
    physics.dispose();
  });

  it('empowers projectile damage by 1.6x via the pending MoveEvent flag', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(FAR_ANCHOR, 1);
    const effects = makeEffects();
    const combat = new CombatSystem({ manager, effects });

    combat.handleMoveEvent(ev({ move: 'jab-blast', empowered: true, t: 500 }));
    effects.projectiles.push(makeProjectile('jab-blast', CHEST));
    combat.update(FIXED_TIMESTEP);
    expect(construct.hp).toBeCloseTo(100 - 8 * EMPOWER_MULTIPLIER, 6);

    // The charge is consumed: a second jab projectile is back to base damage.
    effects.projectiles.push(makeProjectile('jab-blast', CHEST));
    combat.update(FIXED_TIMESTEP);
    expect(construct.hp).toBeCloseTo(100 - 8 * EMPOWER_MULTIPLIER - 8, 6);

    manager.dispose();
    physics.dispose();
  });

  it('honors an empowered flag carried by the projectile itself', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(FAR_ANCHOR, 1);
    const effects = makeEffects();
    const combat = new CombatSystem({ manager, effects });

    effects.projectiles.push(makeProjectile('cross-combo', CHEST, 0.3, true));
    combat.update(FIXED_TIMESTEP);
    expect(construct.hp).toBeCloseTo(100 - 18 * EMPOWER_MULTIPLIER, 6);

    manager.dispose();
    physics.dispose();
  });
});

// ---------------------------------------------------------------------------
// Sustained beams
// ---------------------------------------------------------------------------

describe('sustained beams', () => {
  it('fire-stream drains hp at 14/sec times tick dt when aimed at the construct', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(FAR_ANCHOR, 1);
    const effects = makeEffects();
    const combat = new CombatSystem({ manager, effects });

    combat.handleMoveEvent(ev({ move: 'fire-stream', kind: 'sustain-start', t: 1000 }));
    for (let i = 1; i <= 10; i++) {
      combat.handleMoveEvent(ev({ move: 'fire-stream', kind: 'sustain-tick', t: 1000 + i * 100 }));
    }
    // One full second of stream at 14/sec.
    expect(construct.hp).toBeCloseTo(100 - 14, 4);

    manager.dispose();
    physics.dispose();
  });

  it('deals no damage when the beam is aimed away', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(FAR_ANCHOR, 1);
    const effects = makeEffects();
    const combat = new CombatSystem({ manager, effects });

    const away = { x: 1, y: 0, z: 0 }; // lateral swing, misses the ray test
    combat.handleMoveEvent(ev({ move: 'fire-stream', kind: 'sustain-start', t: 0, aim: away }));
    let dealt = 0;
    for (let i = 1; i <= 10; i++) {
      dealt += combat.applySustainTick(
        ev({ move: 'fire-stream', kind: 'sustain-tick', t: i * 100, aim: away }),
      );
    }
    expect(dealt).toBe(0);
    expect(construct.hp).toBe(100);

    manager.dispose();
    physics.dispose();
  });

});

// ---------------------------------------------------------------------------
// Instant melee-range hits (whip)
// ---------------------------------------------------------------------------

describe('instant hit range gates', () => {
  it('fire-whip misses at 6 m and hits at 2.5 m', async () => {
    const { physics, manager } = await setup();
    const far = manager.spawn(FAR_ANCHOR, 1);
    const near = manager.spawn(new THREE.Vector3(0, 0, -2.5), 1);
    const effects = makeEffects();
    const combat = new CombatSystem({ manager, effects });

    const whipAim = { x: 1, y: 0, z: 0 }; // rightward lateral swing
    combat.handleMoveEvent(ev({ move: 'fire-whip', t: 200, aim: whipAim }));

    // 6 m: out of whip range (4 m).
    expect(far.hp).toBe(100);
    // 2.5 m: connects.
    expect(near.hp).toBeCloseTo(100 - 16, 6);

    manager.dispose();
    physics.dispose();
  });

  it('empowered fire-whip deals 1.6x', async () => {
    const { physics, manager } = await setup();
    const near = manager.spawn(new THREE.Vector3(0, 0, -2.5), 1);
    const effects = makeEffects();
    const combat = new CombatSystem({ manager, effects });

    combat.handleMoveEvent(
      ev({ move: 'fire-whip', t: 100, aim: { x: 1, y: 0, z: 0 }, empowered: true }),
    );
    expect(near.hp).toBeCloseTo(100 - 16 * EMPOWER_MULTIPLIER, 6);

    manager.dispose();
    physics.dispose();
  });
});

// ---------------------------------------------------------------------------
// Twin Cannon feel
// ---------------------------------------------------------------------------

describe('twin cannon', () => {
  it('fires 120 ms hit-stop on impact, no slow-mo without a kill', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(FAR_ANCHOR, 1); // hp 100 survives 42
    const effects = makeEffects();
    const onHitStop = vi.fn();
    const onSlowMo = vi.fn();
    const combat = new CombatSystem({ manager, effects, onHitStop, onSlowMo });

    effects.projectiles.push(makeProjectile('twin-cannon', CHEST, 0.5));
    combat.update(FIXED_TIMESTEP);

    expect(construct.hp).toBeCloseTo(58, 6);
    expect(onHitStop).toHaveBeenCalledTimes(1);
    expect(onHitStop).toHaveBeenCalledWith(TWIN_HIT_STOP_MS);
    expect(onSlowMo).not.toHaveBeenCalled();

    manager.dispose();
    physics.dispose();
  });

  it('triggers slow-mo when the impact kills', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(FAR_ANCHOR, 1, 40); // dies to 42
    const effects = makeEffects();
    const onHitStop = vi.fn();
    const onSlowMo = vi.fn();
    const combat = new CombatSystem({ manager, effects, onHitStop, onSlowMo });

    effects.projectiles.push(makeProjectile('twin-cannon', CHEST, 0.5));
    combat.update(FIXED_TIMESTEP);

    expect(construct.isAlive).toBe(false);
    expect(onHitStop).toHaveBeenCalledWith(TWIN_HIT_STOP_MS);
    expect(onSlowMo).toHaveBeenCalledTimes(1);
    expect(onSlowMo).toHaveBeenCalledWith(KILL_SLOWMO_SCALE, KILL_SLOWMO_MS);
    expect(combat.kills).toBe(1);

    manager.dispose();
    physics.dispose();
  });
});

// ---------------------------------------------------------------------------
// Coal defense: wall, duck, hit
// ---------------------------------------------------------------------------

describe('coal defense', () => {
  const TARGET = new THREE.Vector3(0, 1.4, 0); // lands in the player zone

  it('an active rising-flame wall destroys incoming coals', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(FAR_ANCHOR, 2);
    const effects = makeEffects();
    effects.wallUntil = Number.POSITIVE_INFINITY; // wall up the whole test
    const burst = vi.fn();
    const onPlayerHit = vi.fn();
    const combat = new CombatSystem({ manager, effects, impacts: { burst }, onPlayerHit });

    construct.startLobbing(TARGET, 1.0); // launch at 1.0 s, arrival would be ~2.33 s
    const dt = FIXED_TIMESTEP;
    for (let t = 0; t < 2.6; t += dt) {
      combat.update(dt);
      manager.update(dt);
      // One coal is enough; stop new launches so the final state is clean.
      if (construct.projectiles.length > 0) construct.stopLobbing();
    }

    expect(burst.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(onPlayerHit).not.toHaveBeenCalled();
    expect(construct.projectiles.length).toBe(0);

    manager.dispose();
    physics.dispose();
  });

  it('ducking lets the coal pass overhead harmlessly', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(FAR_ANCHOR, 2);
    const effects = makeEffects(); // no wall
    const onPlayerHit = vi.fn();
    const combat = new CombatSystem({ manager, effects, onPlayerHit, headBaselineY: 0.3 });

    construct.startLobbing(TARGET, 1.0); // launch at 1.0 s, arrival ~2.33 s
    const dt = FIXED_TIMESTEP;
    let duckedSeen = false;
    for (let t = 0; t < 2.6; t += dt) {
      // Fast head drop (30% of baseline) between 1.9 s and 2.0 s, then hold.
      let headY = 0.3;
      if (t >= 2.0) headY = 0.39;
      else if (t >= 1.9) headY = 0.3 + ((t - 1.9) / 0.1) * 0.09;
      combat.update(dt, faceFrame(t * 1000, headY));
      manager.update(dt);
      if (combat.isDucked) duckedSeen = true;
    }

    expect(duckedSeen).toBe(true);
    expect(onPlayerHit).not.toHaveBeenCalled();

    manager.dispose();
    physics.dispose();
  });

  it('with no wall and no duck the coal hits: onPlayerHit(8) plus breath penalty', async () => {
    const { physics, manager } = await setup();
    const construct = manager.spawn(FAR_ANCHOR, 2);
    const effects = makeEffects();
    const onPlayerHit = vi.fn();
    const onBreathPenalty = vi.fn();
    const combat = new CombatSystem({ manager, effects, onPlayerHit, onBreathPenalty });

    construct.startLobbing(TARGET, 1.0);
    const dt = FIXED_TIMESTEP;
    for (let t = 0; t < 2.6; t += dt) {
      combat.update(dt);
      manager.update(dt);
    }

    expect(onPlayerHit).toHaveBeenCalledTimes(1);
    expect(onPlayerHit).toHaveBeenCalledWith(COAL_DAMAGE);
    expect(onBreathPenalty).toHaveBeenCalledTimes(1);
    expect(onBreathPenalty).toHaveBeenCalledWith(PLAYER_HIT_BREATH_PENALTY);

    manager.dispose();
    physics.dispose();
  });
});

// ---------------------------------------------------------------------------
// DuckDetector
// ---------------------------------------------------------------------------

describe('DuckDetector', () => {
  it('detects a 25% drop within 0.4 s', () => {
    const duck = new DuckDetector(0.3);
    for (let t = 0; t <= 300; t += 100) expect(duck.update(0.3, t)).toBe(false);
    expect(duck.update(0.375, 400)).toBe(true); // 25% of baseline in 100 ms
  });

  it('ignores a slow 25% drift over 2 s', () => {
    const duck = new DuckDetector(0.3);
    let ever = false;
    for (let t = 0; t <= 2000; t += 100) {
      const y = 0.3 + (t / 2000) * 0.075;
      if (duck.update(y, t)) ever = true;
    }
    expect(ever).toBe(false);
  });

  it('stays ducked until the head returns near the baseline', () => {
    const duck = new DuckDetector(0.3);
    duck.update(0.3, 0);
    duck.update(0.3, 100);
    expect(duck.update(0.375, 200)).toBe(true);
    expect(duck.update(0.36, 300)).toBe(true); // still well below baseline
    expect(duck.update(0.32, 400)).toBe(false); // within 10% of baseline again
  });
});

// ---------------------------------------------------------------------------
// Torso duck (body pose preferred, head-y fallback)
// ---------------------------------------------------------------------------

/** CombatSystem with a construct-free stub manager: duck logic only. */
function duckOnlyCombat(headBaselineY?: number): CombatSystem {
  const manager = {
    constructs: [] as never[],
    onDeath: null,
  } as unknown as ConstructManager;
  return new CombatSystem({
    manager,
    effects: makeEffects(),
    ...(headBaselineY !== undefined ? { headBaselineY } : {}),
  });
}

describe('torso duck detection', () => {
  it('torsoCenterY is the hip-heavy weighted vertical center of mass', () => {
    // bodyPose: shoulders at torsoY - 0.15, hips at torsoY + 0.15; the R3
    // Phase 3 weighting (0.4 shoulder / 0.6 hip, src/tracking/body.ts)
    // lands 0.03 below the old 4-point midpoint.
    expect(torsoCenterY(bodyPose(0, 0.45))).toBeCloseTo(0.48, 10);
  });

  it('ducks on a fast torso drop when pose is present (no face at all)', () => {
    const combat = duckOnlyCombat();
    const dt = 1 / 30;
    let t = 0;
    // Baseline: 50 samples at torso 0.45.
    for (let i = 0; i < 50; i++) {
      combat.update(dt, poseFrame(t, 0.45));
      t += dt * 1000;
    }
    expect(combat.isDucked).toBe(false);
    // Fast drop: torso down 30% of baseline within ~130 ms.
    for (let i = 0; i < 4; i++) {
      combat.update(dt, poseFrame(t, 0.45 + 0.035 * (i + 1)));
      t += dt * 1000;
    }
    expect(combat.isDucked).toBe(true);
    // Recover.
    for (let i = 0; i < 4; i++) {
      combat.update(dt, poseFrame(t, 0.45));
      t += dt * 1000;
    }
    expect(combat.isDucked).toBe(false);
  });

  it('prefers the torso verdict over the head while pose is fresh', () => {
    const combat = duckOnlyCombat(0.3);
    const dt = 1 / 30;
    let t = 0;
    for (let i = 0; i < 50; i++) {
      // Head nods hard (would count as a head-duck) but the torso holds.
      combat.update(dt, poseFrame(t, 0.45, i < 45 ? 0.3 : 0.39));
      t += dt * 1000;
    }
    expect(combat.isDucked).toBe(false);
  });

  it('falls back to head y when pose goes stale', () => {
    const combat = duckOnlyCombat(0.3);
    const dt = 1 / 30;
    let t = 0;
    // Torso present and upright for the baseline window.
    for (let i = 0; i < 50; i++) {
      combat.update(dt, poseFrame(t, 0.45, 0.3));
      t += dt * 1000;
    }
    // Pose disappears; after >1 s the head signal decides. Head drops fast.
    for (let i = 0; i < 40; i++) {
      combat.update(dt, faceFrame(t, 0.3));
      t += dt * 1000;
    }
    for (let i = 0; i < 4; i++) {
      combat.update(dt, faceFrame(t, 0.3 + 0.025 * (i + 1)));
      t += dt * 1000;
    }
    expect(combat.isDucked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Kill flow
// ---------------------------------------------------------------------------

describe('kill flow', () => {
  it('counts kills and fires onKill once per construct', async () => {
    const { physics, manager } = await setup();
    const first = manager.spawn(FAR_ANCHOR, 1, 8);
    const effects = makeEffects();
    const combat = new CombatSystem({ manager, effects });
    const onKill = vi.fn();
    combat.onKill = onKill;

    effects.projectiles.push(makeProjectile('jab-blast', CHEST));
    combat.update(FIXED_TIMESTEP);
    expect(first.isAlive).toBe(false);
    expect(combat.kills).toBe(1);
    expect(onKill).toHaveBeenCalledTimes(1);

    // Further frames never refire the death.
    combat.update(FIXED_TIMESTEP);
    manager.update(FIXED_TIMESTEP);
    expect(combat.kills).toBe(1);

    // Second construct, second kill.
    const second = manager.spawn(new THREE.Vector3(1.5, 0, -6), 1, 8);
    effects.projectiles.push(makeProjectile('jab-blast', new THREE.Vector3(1.5, 1.25, -6)));
    combat.update(FIXED_TIMESTEP);
    expect(second.isAlive).toBe(false);
    expect(combat.kills).toBe(2);
    expect(onKill).toHaveBeenCalledTimes(2);

    manager.dispose();
    physics.dispose();
  });
});

// ---------------------------------------------------------------------------
// HUD pure logic
// ---------------------------------------------------------------------------

describe('HUD pure logic', () => {
  it('maps the damage fraction to seal crack levels 0..3 (<75/50/25% hp)', () => {
    expect(sealCrackLevel(-1)).toBe(0);
    expect(sealCrackLevel(0)).toBe(0);
    expect(sealCrackLevel(0.25)).toBe(0); // exactly 75% hp: still pristine
    expect(sealCrackLevel(0.26)).toBe(1); // below 75% hp: first crack
    expect(sealCrackLevel(0.5)).toBe(1);
    expect(sealCrackLevel(0.51)).toBe(2); // below 50% hp: second crack
    expect(sealCrackLevel(0.75)).toBe(2);
    expect(sealCrackLevel(0.76)).toBe(3); // below 25% hp: third crack
    expect(sealCrackLevel(1)).toBe(3);
    expect(sealCrackLevel(Number.NaN)).toBe(0);
  });

  it('damage number rotation jitter is deterministic and bounded', () => {
    for (let seq = 0; seq < 40; seq++) {
      const rot = damageNumberRotationDeg(seq);
      expect(rot).toBe(damageNumberRotationDeg(seq)); // deterministic
      expect(Math.abs(rot)).toBeLessThanOrEqual(DAMAGE_NUMBER_JITTER_DEG);
      expect(Number.isInteger(rot)).toBe(true);
    }
    // Consecutive spawns never share an angle.
    expect(damageNumberRotationDeg(1)).not.toBe(damageNumberRotationDeg(2));
  });

  it('approach converges smoothly toward the target', () => {
    let v = 0;
    const step = approach(v, 100, 1 / 60);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(100);
    for (let i = 0; i < 300; i++) v = approach(v, 100, 1 / 60);
    expect(v).toBeCloseTo(100, 1);
    expect(approach(50, 100, 0)).toBe(50); // dt 0 is a no-op
  });

  it('side bias follows head yaw with clamping', () => {
    expect(sideBiasFromYaw(0)).toBe(0);
    expect(sideBiasFromYaw(0.175)).toBeCloseTo(0.5, 6);
    expect(sideBiasFromYaw(2)).toBe(1);
    expect(sideBiasFromYaw(-2)).toBe(-1);
    expect(sideBiasFromYaw(Number.NaN)).toBe(0);
  });

  it('damage number ledger ages entries out after their duration', () => {
    const ledger = new DamageNumberLedger();
    const expired: number[] = [];
    ledger.spawn(DAMAGE_NUMBER_SECONDS, () => expired.push(1));
    ledger.spawn(DAMAGE_NUMBER_SECONDS, () => expired.push(2));
    expect(ledger.count).toBe(2);

    ledger.update(0.5);
    expect(ledger.count).toBe(2);
    expect(expired.length).toBe(0);

    ledger.update(0.45); // total 0.95 > 0.9
    expect(ledger.count).toBe(0);
    expect(expired).toEqual([1, 2]);

    ledger.spawn(DAMAGE_NUMBER_SECONDS, () => expired.push(3));
    ledger.clear();
    expect(ledger.count).toBe(0);
    expect(expired).toEqual([1, 2, 3]);
  });
});
