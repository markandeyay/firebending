// Headless director-chain checks (T052 / Phase 5): the kill -> killWindow ->
// travel -> next-construct loop over the courtyard STATIONS, the difficulty
// ramp, station cycling, spawn-before-travel, the no-repeat path-style rule,
// and the exit criterion: the full loop driven end to end by REAL replay
// input (jab-right fixture -> FilteredSource -> MoveEngine -> real
// MoveEffects projectiles -> CombatSystem -> Director). Real rapier physics
// throughout; the camera rig is a manual-resolve fake.

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import {
  ConstructManager,
  createPhysicsWorld,
  type PhysicsWorld,
} from '../src/game/enemies';
import {
  CombatSystem,
  PLAYER_WORLD_POSITION,
  type CameraPoseProvider,
  type EffectsProvider,
  type ProjectileEffectLike,
} from '../src/game/combat';
import {
  constructHpFor,
  constructTierFor,
  Director,
  KILL_WINDOW_SEC,
  lobIntervalFor,
  type DirectorRig,
  type DirectorTravelOptions,
} from '../src/game/director';
import { STATION_COUNT, stationFor } from '../src/game/killTravel';
import { FireSystem } from '../src/vfx/fire';
import { MoveEffects } from '../src/vfx/moveEffects';
import { MoveEngine } from '../src/gestures/moves';
import { FilteredSource } from '../src/tracking/filters';
import { ReplaySource } from '../src/tracking/replaySource';
import type { LandmarkRecording } from '../src/tracking/types';
import type { Construct } from '../src/game/enemies';
import type { MoveName } from '../src/gestures/moves';

// ---------------------------------------------------------------------------
// Fakes and helpers
// ---------------------------------------------------------------------------

const DT = 1 / 60;

class FakeRig implements DirectorRig {
  readonly calls: Array<{
    anchor: THREE.Vector3;
    opts: DirectorTravelOptions | undefined;
  }> = [];
  private pending: (() => void) | null = null;
  /** Optional probe run synchronously inside travelTo (spawn-before-travel). */
  onTravel: (() => void) | null = null;

  travelTo(anchor: THREE.Vector3, opts?: DirectorTravelOptions): Promise<void> {
    this.calls.push({ anchor: anchor.clone(), opts });
    this.onTravel?.();
    return new Promise<void>((resolve) => {
      this.pending = resolve;
    });
  }

  /** Complete the in-flight travel (the test controls arrival timing). */
  arrive(): void {
    const resolve = this.pending;
    this.pending = null;
    resolve?.();
  }
}

interface FakeHud {
  attached: Array<{ damagePercent: number; isAlive: boolean }>;
  attachConstruct(c: { damagePercent: number; isAlive: boolean }): void;
}

function makeHud(): FakeHud {
  const hud: FakeHud = {
    attached: [],
    attachConstruct(c) {
      hud.attached.push(c);
    },
  };
  return hud;
}

interface FakeEffects extends EffectsProvider {
  projectiles: ProjectileEffectLike[];
}

function makeEffects(): FakeEffects {
  const effects: FakeEffects = {
    projectiles: [],
    wallActiveUntil: () => null,
  };
  return effects;
}

function makeProjectile(
  sourceMove: MoveName,
  position: THREE.Vector3,
): ProjectileEffectLike {
  return {
    position: position.clone(),
    radius: 0.3,
    sourceMove,
    onImpact: () => {},
  };
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

interface World {
  physics: PhysicsWorld;
  manager: ConstructManager;
  combat: CombatSystem;
  effects: FakeEffects;
  rig: FakeRig;
  hud: FakeHud;
  director: Director;
  onKillWindow: ReturnType<typeof vi.fn>;
}

async function setup(cameraPose?: CameraPoseProvider): Promise<World> {
  const physics = await createPhysicsWorld();
  const parent = new THREE.Group();
  const manager = new ConstructManager(physics, parent);
  const effects = makeEffects();
  const combat = new CombatSystem({ manager, effects });
  const rig = new FakeRig();
  const hud = makeHud();
  const onKillWindow = vi.fn();
  const director = new Director({
    manager,
    combat,
    rig,
    hud,
    onKillWindow,
    ...(cameraPose ? { cameraPose } : {}),
  });
  return { physics, manager, combat, effects, rig, hud, director, onKillWindow };
}

/** Kill the director's current construct through the combat projectile path. */
function killActive(w: World): void {
  const c = w.director.currentConstruct;
  if (!c) throw new Error('no current construct to kill');
  const chest = new THREE.Vector3(
    c.group.position.x,
    c.group.position.y + 1.25,
    c.group.position.z,
  );
  let guard = 0;
  while (c.isAlive && guard++ < 20) {
    w.effects.projectiles = [makeProjectile('twin-cannon', chest)];
    w.combat.update(DT);
  }
  w.effects.projectiles = [];
  w.combat.update(DT);
  if (c.isAlive) throw new Error('construct survived the kill helper');
}

/** Kill, run out the kill window, and complete the travel. */
async function killAndTravel(w: World): Promise<void> {
  killActive(w);
  w.director.update(KILL_WINDOW_SEC + 0.01);
  w.rig.arrive();
  await flushMicrotasks();
}

// ---------------------------------------------------------------------------
// Pure difficulty helpers
// ---------------------------------------------------------------------------

describe('difficulty helpers', () => {
  it('ramps HP 15% per index on the tier base, capped at 2.5x', () => {
    expect(constructHpFor(0)).toBeCloseTo(100);
    expect(constructHpFor(1)).toBeCloseTo(115);
    expect(constructHpFor(2)).toBeCloseTo(160 * 1.3); // tier 2 base
    expect(constructHpFor(4)).toBeCloseTo(160);
    expect(constructHpFor(30)).toBeCloseTo(250); // cap: 100 * 2.5
    expect(constructHpFor(32)).toBeCloseTo(400); // cap: 160 * 2.5
  });

  it('makes every third construct tier 2', () => {
    expect([0, 1, 2, 3, 4, 5, 8].map(constructTierFor)).toEqual([1, 1, 2, 1, 1, 2, 2]);
  });

  it('tightens the lob interval with index, floored at 1.2 s', () => {
    expect(lobIntervalFor(2)).toBeCloseTo(2.0);
    expect(lobIntervalFor(5)).toBeCloseTo(1.7);
    expect(lobIntervalFor(11)).toBeCloseTo(1.2);
    expect(lobIntervalFor(50)).toBeCloseTo(1.2);
  });
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

describe('Director chain', () => {
  it('runs spawn -> kill -> killWindow -> travel -> next construct -> fighting', async () => {
    const w = await setup();
    try {
      w.director.start();

      // Construct 0: anchor 0, tier 1, base HP, attached to the HUD.
      expect(w.director.state).toBe('fighting');
      expect(w.director.constructIndex).toBe(0);
      const c0 = w.director.currentConstruct;
      if (!c0) throw new Error('no construct 0');
      expect(c0.tier).toBe(1);
      expect(c0.maxHp).toBeCloseTo(100);
      expect(c0.group.position.x).toBeCloseTo(0);
      expect(c0.group.position.z).toBeCloseTo(-6);
      expect(w.hud.attached).toEqual([c0]);

      // Kill it via combat projectiles: the kill window opens.
      killActive(w);
      expect(w.combat.kills).toBe(1);
      expect(w.director.kills).toBe(1);
      expect(w.director.state).toBe('killWindow');
      expect(w.onKillWindow).toHaveBeenCalledTimes(1);
      expect(w.onKillWindow.mock.calls[0]?.[0]).toBeInstanceOf(THREE.Vector3);

      // The window holds for 0.5 s of real time.
      w.director.update(KILL_WINDOW_SEC * 0.5);
      expect(w.director.state).toBe('killWindow');
      expect(w.rig.calls).toHaveLength(0);

      // Window elapses: travel begins and construct 1 already waits at
      // station 1's anchor (spawned BEFORE the travel).
      w.director.update(KILL_WINDOW_SEC * 0.5 + 0.01);
      expect(w.director.state).toBe('traveling');
      expect(w.rig.calls).toHaveLength(1);
      const st1 = stationFor(1);
      expect(w.rig.calls[0]?.anchor.x).toBeCloseTo(st1.anchor.x);
      expect(w.rig.calls[0]?.anchor.z).toBeCloseTo(st1.anchor.z);
      // The authored travel recipe rides along.
      expect(w.rig.calls[0]?.opts?.durationSec).toBeGreaterThanOrEqual(2);
      expect(w.rig.calls[0]?.opts?.durationSec).toBeLessThanOrEqual(4);
      expect(w.rig.calls[0]?.opts?.endPosition?.distanceTo(st1.cameraPos)).toBeLessThan(1e-6);
      const c1 = w.director.currentConstruct;
      if (!c1) throw new Error('no construct 1');
      expect(c1).not.toBe(c0);
      expect(c1.isAlive).toBe(true);
      expect(c1.group.position.z).toBeCloseTo(st1.anchor.z);
      expect(c1.maxHp).toBeCloseTo(115); // 15% ramp
      expect(w.hud.attached).toEqual([c0, c1]);
      expect(w.director.constructIndex).toBe(1);
      expect(w.director.stationIndex).toBe(1);

      // Arrival resumes the fight.
      w.rig.arrive();
      await flushMicrotasks();
      expect(w.director.state).toBe('fighting');
    } finally {
      w.director.dispose();
      w.physics.dispose();
    }
  });

  it('spawns a tier 2 lobber at index 2 that starts lobbing only after arrival', async () => {
    const w = await setup();
    try {
      w.director.start();
      await killAndTravel(w); // -> construct 1
      killActive(w);
      w.director.update(KILL_WINDOW_SEC + 0.01); // -> traveling to construct 2

      const c2 = w.director.currentConstruct;
      if (!c2) throw new Error('no construct 2');
      expect(c2.tier).toBe(2);
      expect(c2.maxHp).toBeCloseTo(160 * 1.3);
      const lobSpy = vi.spyOn(c2, 'startLobbing');
      expect(lobSpy).not.toHaveBeenCalled(); // it awaits the player mid-travel

      w.rig.arrive();
      await flushMicrotasks();
      expect(w.director.state).toBe('fighting');
      expect(lobSpy).toHaveBeenCalledTimes(1);
      const [target, interval] = lobSpy.mock.calls[0] ?? [];
      expect(interval).toBeCloseTo(lobIntervalFor(2));
      expect(target?.x).toBeCloseTo(PLAYER_WORLD_POSITION.x);
      expect(target?.z).toBeCloseTo(PLAYER_WORLD_POSITION.z);
    } finally {
      w.director.dispose();
      w.physics.dispose();
    }
  });

  it('cycles the courtyard stations in fixed order, looping past the end', async () => {
    const w = await setup();
    try {
      w.director.start();
      // 8 kills cross the six-station cycle boundary (index 7 -> station 1).
      for (let k = 1; k <= 8; k++) {
        await killAndTravel(w);
        expect(w.director.constructIndex).toBe(k);
        expect(w.director.stationIndex).toBe(k % STATION_COUNT);
        const st = stationFor(k);
        const c = w.director.currentConstruct;
        expect(c?.group.position.x).toBeCloseTo(st.anchor.x);
        expect(c?.group.position.z).toBeCloseTo(st.anchor.z);
        // Elevated stations (bridge deck) spawn on their local floor.
        expect(c?.group.position.y).toBeCloseTo(st.floorY);
        // The travel targeted the same station anchor.
        const call = w.rig.calls[k - 1];
        expect(call?.anchor.x).toBeCloseTo(st.anchor.x);
        expect(call?.anchor.z).toBeCloseTo(st.anchor.z);
      }
      // Difficulty keeps ramping by KILL index across cycles, not station.
      expect(w.director.currentConstruct?.maxHp).toBeCloseTo(constructHpFor(8));
    } finally {
      w.director.dispose();
      w.physics.dispose();
    }
  }, 20000);

  it('spawns the next construct at its anchor BEFORE the travel starts', async () => {
    const w = await setup();
    try {
      w.director.start();
      const seen: Array<{ alive: boolean; x: number; z: number }> = [];
      w.rig.onTravel = () => {
        const c = w.director.currentConstruct;
        if (!c) throw new Error('travelTo called with no current construct');
        seen.push({
          alive: c.isAlive,
          x: c.group.position.x,
          z: c.group.position.z,
        });
      };
      await killAndTravel(w);
      await killAndTravel(w);
      expect(seen).toHaveLength(2);
      seen.forEach((probe, i) => {
        const st = stationFor(i + 1);
        expect(probe.alive).toBe(true);
        expect(probe.x).toBeCloseTo(st.anchor.x);
        expect(probe.z).toBeCloseTo(st.anchor.z);
      });
    } finally {
      w.director.dispose();
      w.physics.dispose();
    }
  });

  it('never plays the same path style twice in a row across 12 kills', async () => {
    const w = await setup();
    try {
      w.director.start();
      for (let k = 0; k < 12; k++) {
        await killAndTravel(w);
      }
      const log = w.director.pathStyleLog;
      expect(log).toHaveLength(12);
      for (let i = 1; i < log.length; i++) {
        expect(log[i]).not.toBe(log[i - 1]);
      }
      // The six-station cycle exercises all six authored styles.
      expect(new Set(log).size).toBe(6);
    } finally {
      w.director.dispose();
      w.physics.dispose();
    }
  }, 30000);

  it('lobbers target the camera base position from the pose provider', async () => {
    const eye = new THREE.Vector3(6.4, 2.55, -17.9);
    const w = await setup({
      position: () => eye.clone(),
      quaternion: () => new THREE.Quaternion(),
    });
    try {
      w.director.start();
      await killAndTravel(w); // -> construct 1
      killActive(w);
      w.director.update(KILL_WINDOW_SEC + 0.01); // -> traveling to construct 2
      const c2 = w.director.currentConstruct;
      if (!c2) throw new Error('no construct 2');
      const lobSpy = vi.spyOn(c2, 'startLobbing');
      w.rig.arrive();
      await flushMicrotasks();
      expect(lobSpy).toHaveBeenCalledTimes(1);
      const [target] = lobSpy.mock.calls[0] ?? [];
      expect(target?.x).toBeCloseTo(eye.x);
      expect(target?.y).toBeCloseTo(eye.y);
      expect(target?.z).toBeCloseTo(eye.z);
    } finally {
      w.director.dispose();
      w.physics.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 5 exit: the full loop on replay input (no rendering)
// ---------------------------------------------------------------------------

/**
 * The synthetic jab's punch vector carries the fixture's built-in upward and
 * lateral bias (~17 deg up, ~12 deg right of straight ahead), so with a
 * camera looking level down the lane the comet passes over the construct. In
 * live play the hand is the crosshair and the player steers by feedback; the
 * deterministic replay cannot. The test therefore probes the recorded aim
 * once (the engine is deterministic, every pass emits the identical event)
 * and orients the camera so that mapped punch vector points at the chest,
 * which is exactly the screenToWorld contract being exercised.
 */
function probeJabAim(rec: LandmarkRecording): THREE.Vector3 {
  const engine = new MoveEngine({ velocityScale: 1.1 });
  const replay = new ReplaySource(rec);
  const filtered = new FilteredSource(replay);
  let aim: THREE.Vector3 | null = null;
  filtered.onFrame((frame) => {
    for (const e of engine.update(frame)) {
      if (e.move === 'jab-blast' && aim === null) {
        // Screen -> camera-space mapping used by moveEffects.screenToWorld.
        aim = new THREE.Vector3(e.aim.x, -e.aim.y, e.aim.z).normalize();
      }
    }
  });
  replay.drain();
  filtered.dispose();
  if (aim === null) throw new Error('jab-right fixture emitted no jab-blast');
  return aim;
}

describe('end-to-end replay smoke', () => {
  it('kills construct 0 with real jab-right replay input and advances the chain', async () => {
    const rec = JSON.parse(
      readFileSync(
        new URL('../fixtures/synthetic/jab-right.json', import.meta.url),
        'utf8',
      ),
    ) as LandmarkRecording;

    const physics = await createPhysicsWorld();
    const parent = new THREE.Group();
    const manager = new ConstructManager(physics, parent);

    // REAL MoveEffects (headless-safe per its own tests) with a camera at the
    // rig's home position, oriented so the fixture's punch vector points at
    // the first construct's chest (see probeJabAim above).
    const vfxScene = new THREE.Group();
    const fire = new FireSystem(vfxScene);
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 100);
    camera.position.set(0, 1.5, 0.6);
    const chest = new THREE.Vector3(0, 1.25, -6);
    const toChest = chest.clone().sub(camera.position).normalize();
    camera.quaternion.setFromUnitVectors(probeJabAim(rec), toChest);
    camera.updateMatrixWorld();
    const fx = new MoveEffects(vfxScene, fire, camera);

    const effects: EffectsProvider = {
      get projectiles() {
        return fx.projectiles;
      },
      wallActiveUntil: () => (fx.activeWall ? fx.activeWall.until : null),
    };
    const combat = new CombatSystem({ manager, effects });
    const rig = new FakeRig();
    const hud = makeHud();
    const director = new Director({ manager, combat, rig, hud });
    director.start();
    const c0: Construct | null = director.currentConstruct;
    expect(c0?.isAlive).toBe(true);

    // Loop the fixture through the REAL gameplay pipeline until the kill:
    // fresh engine + FilteredSource per pass (the movesDebug convention; no
    // filter or cooldown state bleeds across loops), velocityScale 1.1 (the
    // One Euro replay compensation, see movesDebug.REPLAY_VELOCITY_SCALE).
    const FRAME = 1 / 30;
    let passes = 0;
    while (combat.kills === 0 && passes < 40) {
      passes++;
      const engine = new MoveEngine({ velocityScale: 1.1 });
      const replay = new ReplaySource(rec);
      const filtered = new FilteredSource(replay);
      const off = filtered.onFrame((frame) => {
        for (const e of engine.update(frame)) {
          fx.handleEvent(e);
          combat.handleMoveEvent(e);
        }
        manager.update(FRAME);
        fx.update(FRAME);
        combat.update(FRAME, frame);
      });
      while (!replay.done && combat.kills === 0) replay.tick();
      off();
      filtered.dispose();
      // Let in-flight projectiles finish traveling between passes.
      for (let i = 0; i < 45 && combat.kills === 0; i++) {
        manager.update(FRAME);
        fx.update(FRAME);
        combat.update(FRAME);
      }
    }

    expect(combat.kills).toBe(1);
    expect(c0?.isAlive).toBe(false);
    expect(director.state).toBe('killWindow');

    // Drive the beat: kill window -> travel -> arrival -> fighting again.
    director.update(KILL_WINDOW_SEC + 0.01);
    expect(director.state).toBe('traveling');
    rig.arrive();
    await flushMicrotasks();
    expect(director.state).toBe('fighting');
    expect(director.constructIndex).toBe(1);
    const c1 = director.currentConstruct;
    expect(c1?.isAlive).toBe(true);
    expect(c1?.group.position.z).toBeCloseTo(stationFor(1).anchor.z);
    expect(hud.attached).toHaveLength(2);

    director.dispose();
    physics.dispose();
  }, 15000);
});
