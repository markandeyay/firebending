// Headless per-move VFX checks (T041): coordinate mapping, dispatch, comet
// projectiles, sustained cones, the wall, budgets and the impact layer. No
// WebGL, no DOM; visual quality is a HUMAN item in the tracker.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FireSystem } from '../src/vfx/fire';
import {
  EFFECT_NAMES,
  MAX_LIVE_PROJECTILES,
  MoveEffects,
  PROJECTILE_LIFETIME_SEC,
  REACH_PLANE_DISTANCE,
  screenToWorld,
  WALL_DURATION_SEC,
} from '../src/vfx/moveEffects';
import { ImpactSystem, DECAL_FADE_SEC, MAX_DECALS } from '../src/vfx/impact';
import type { MoveEvent, MoveName } from '../src/gestures/moves';
import type { Vec3 } from '../src/tracking/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_MOVES: MoveName[] = [
  'jab-blast',
  'fire-stream',
  'cross-combo',
  'twin-cannon',
  'rising-flame',
  'fire-whip',
  'breath-charge',
];

const AIM_FWD: Vec3 = { x: 0, y: 0, z: -1 };
const CENTER: Vec3 = { x: 0.5, y: 0.5, z: 0 };

function makeCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  cam.position.set(0, 1.5, 0); // default orientation: looking down world -z
  cam.updateMatrixWorld();
  return cam;
}

function ev(move: MoveName, over: Partial<MoveEvent> = {}): MoveEvent {
  return {
    move,
    hand: 'right',
    t: 0,
    aim: AIM_FWD,
    origin: CENTER,
    empowered: false,
    kind: 'trigger',
    triggerLatencyMs: 0,
    ...over,
  };
}

interface Rig {
  calls: Array<{ intensity: number; duration: number }>;
  shake(intensity: number, duration: number): void;
}

function makeRig(): Rig {
  const calls: Array<{ intensity: number; duration: number }> = [];
  return {
    calls,
    shake(intensity: number, duration: number): void {
      calls.push({ intensity, duration });
    },
  };
}

interface World {
  fire: FireSystem;
  fx: MoveEffects;
  rig: Rig;
  camera: THREE.PerspectiveCamera;
}

function makeWorld(): World {
  const scene = new THREE.Group();
  const fire = new FireSystem(scene);
  const camera = makeCamera();
  const rig = makeRig();
  const fx = new MoveEffects(scene, fire, camera, rig);
  return { fire, fx, rig, camera };
}

/** Step both systems the way the game loop would. */
function step(w: World, dt: number, frames = 1): void {
  for (let i = 0; i < frames; i++) {
    w.fx.update(dt);
    w.fire.update(dt);
  }
}

// ---------------------------------------------------------------------------
// screenToWorld
// ---------------------------------------------------------------------------

describe('screenToWorld', () => {
  it('center origin with aim (0,0,-1) maps to camera-forward, origin ahead of camera', () => {
    const cam = makeCamera();
    const { origin, direction } = screenToWorld(CENTER, AIM_FWD, cam);
    // Default camera orientation: forward is world -z.
    expect(direction.x).toBeCloseTo(0, 5);
    expect(direction.y).toBeCloseTo(0, 5);
    expect(direction.z).toBeCloseTo(-1, 5);
    expect(direction.length()).toBeCloseTo(1, 6);
    // Origin sits on the reach plane straight ahead.
    expect(origin.x).toBeCloseTo(cam.position.x, 5);
    expect(origin.y).toBeCloseTo(cam.position.y, 5);
    expect(origin.z).toBeCloseTo(cam.position.z - REACH_PLANE_DISTANCE, 5);
  });

  it('aim (1,0,0) maps to camera-right', () => {
    const cam = makeCamera();
    const { direction } = screenToWorld(CENTER, { x: 1, y: 0, z: 0 }, cam);
    expect(direction.x).toBeCloseTo(1, 5);
    expect(direction.y).toBeCloseTo(0, 5);
    expect(direction.z).toBeCloseTo(0, 5);
  });

  it('aim (0,1,0) (screen down) maps to world-down-ish', () => {
    const cam = makeCamera();
    const { direction } = screenToWorld(CENTER, { x: 0, y: 1, z: 0 }, cam);
    expect(direction.y).toBeCloseTo(-1, 5);
  });

  it('origin x=0.2 (player left) lands left of camera center in world', () => {
    const cam = makeCamera();
    const { origin } = screenToWorld({ x: 0.2, y: 0.5, z: 0 }, AIM_FWD, cam);
    expect(origin.x).toBeLessThan(cam.position.x);
  });

  it('mixed aim normalizes and blends axes; degenerate aim falls back to forward', () => {
    const cam = makeCamera();
    const mixed = screenToWorld(CENTER, { x: 1, y: 0, z: -1 }, cam);
    expect(mixed.direction.length()).toBeCloseTo(1, 6);
    expect(mixed.direction.x).toBeGreaterThan(0);
    expect(mixed.direction.z).toBeLessThan(0);
    const degenerate = screenToWorld(CENTER, { x: 0, y: 0, z: 0 }, cam);
    expect(degenerate.direction.z).toBeCloseTo(-1, 5);
  });
});

// ---------------------------------------------------------------------------
// Dispatch: every move produces a distinct, named effect
// ---------------------------------------------------------------------------

describe('MoveEffects dispatch', () => {
  it('each of the 7 moves produces a non-null handle with a distinct name', () => {
    const w = makeWorld();
    const names = new Set<string>();
    for (const move of ALL_MOVES) {
      const sustained = move === 'fire-stream';
      const start = w.fx.handleEvent(
        ev(move, { kind: sustained ? 'sustain-start' : 'trigger' }),
      );
      expect(start, `move ${move} must produce an effect`).not.toBeNull();
      expect(start?.move).toBe(move);
      expect(start?.effectName).toBe(EFFECT_NAMES[move]);
      names.add(start?.effectName ?? '');
      if (sustained) {
        const tick = w.fx.handleEvent(ev(move, { kind: 'sustain-tick' }));
        expect(tick).not.toBeNull();
        const end = w.fx.handleEvent(ev(move, { kind: 'sustain-end' }));
        expect(end).not.toBeNull();
      }
      step(w, 1 / 60);
    }
    expect(names.size).toBe(7); // every effect name is distinct
    w.fx.dispose();
    w.fire.dispose();
  });

  it('ignores unknown move/kind combinations gracefully', () => {
    const w = makeWorld();
    // Discrete move with a sustain kind.
    expect(w.fx.handleEvent(ev('jab-blast', { kind: 'sustain-tick' }))).toBeNull();
    expect(w.fx.handleEvent(ev('twin-cannon', { kind: 'sustain-end' }))).toBeNull();
    // Sustained move with a bare trigger.
    expect(w.fx.handleEvent(ev('fire-stream', { kind: 'trigger' }))).toBeNull();
    // Orphan tick/end with no active sustain.
    expect(w.fx.handleEvent(ev('fire-stream', { kind: 'sustain-tick' }))).toBeNull();
    expect(w.fx.handleEvent(ev('fire-stream', { kind: 'sustain-end' }))).toBeNull();
    w.fx.dispose();
    w.fire.dispose();
  });

  it('makes the specced shake calls through the rig', () => {
    const w = makeWorld();
    w.fx.handleEvent(ev('jab-blast'));
    w.fx.handleEvent(ev('twin-cannon'));
    w.fx.handleEvent(ev('fire-whip'));
    const intensities = w.rig.calls.map((c) => c.intensity);
    expect(intensities).toEqual([0.05, 0.35, 0.15]);
    w.fx.dispose();
    w.fire.dispose();
  });
});

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

describe('projectiles', () => {
  it('jab spawns exactly one projectile flying along the mapped direction', () => {
    const w = makeWorld();
    w.fx.handleEvent(ev('jab-blast'));
    expect(w.fx.projectiles.length).toBe(1);
    const p = w.fx.projectiles[0];
    expect(p).toBeDefined();
    if (!p) return;
    expect(p.sourceMove).toBe('jab-blast');
    expect(p.radius).toBeGreaterThan(0);
    // Starts on the reach plane straight ahead of the camera.
    expect(p.position.z).toBeCloseTo(w.camera.position.z - REACH_PLANE_DISTANCE, 4);
    const z0 = p.position.z;
    step(w, 0.1);
    // aim (0,0,-1) maps to world -z at 14 m/s.
    expect(p.position.z).toBeCloseTo(z0 - 1.4, 4);
    expect(p.position.x).toBeCloseTo(0, 4);
    w.fx.dispose();
    w.fire.dispose();
  });

  it('expires within the lifetime cap, calls onExpire and releases its light', () => {
    const w = makeWorld();
    expect(w.fire.stats().lightsActive).toBe(0); // baseline
    w.fx.handleEvent(ev('jab-blast'));
    const p = w.fx.projectiles[0];
    expect(p).toBeDefined();
    if (!p) return;
    let expired = 0;
    p.onExpire = () => {
      expired++;
    };
    expect(w.fire.stats().lightsActive).toBe(1); // the comet's traveling light
    const frames = Math.ceil((PROJECTILE_LIFETIME_SEC + 0.2) / (1 / 60));
    step(w, 1 / 60, frames);
    expect(p.alive).toBe(false);
    expect(expired).toBe(1);
    expect(w.fx.projectiles.length).toBe(0);
    expect(w.fire.stats().lightsActive).toBe(0); // back to baseline
    w.fx.dispose();
    w.fire.dispose();
  });

  it('onImpact terminates the projectile when combat calls it', () => {
    const w = makeWorld();
    w.fx.handleEvent(ev('cross-combo'));
    const p = w.fx.projectiles[0];
    expect(p).toBeDefined();
    if (!p) return;
    const flamesBefore = w.fire.flames.liveCount();
    p.onImpact(new THREE.Vector3(0, 1.2, -5), new THREE.Vector3(0, 0, 1));
    expect(p.alive).toBe(false);
    // Terminal flash spawned flames at the impact point.
    expect(w.fire.flames.liveCount()).toBeGreaterThan(flamesBefore);
    step(w, 1 / 60);
    expect(w.fx.projectiles.length).toBe(0);
    expect(w.fire.stats().lightsActive).toBe(0);
    // A second call is a no-op.
    p.onImpact(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    w.fx.dispose();
    w.fire.dispose();
  });

  it('empowered jab is bigger than a normal one', () => {
    const w = makeWorld();
    w.fx.handleEvent(ev('jab-blast'));
    w.fx.handleEvent(ev('jab-blast', { hand: 'left', empowered: true }));
    const [normal, empowered] = w.fx.projectiles;
    expect(normal && empowered).toBeTruthy();
    if (!normal || !empowered) return;
    expect(empowered.radius).toBeGreaterThan(normal.radius);
    expect(empowered.empowered).toBe(true);
    w.fx.dispose();
    w.fire.dispose();
  });
});

// ---------------------------------------------------------------------------
// Sustained moves
// ---------------------------------------------------------------------------

describe('sustained effects', () => {
  it('stream start + 3 ticks + end spawns flames per tick and releases its light', () => {
    const w = makeWorld();
    const start = w.fx.handleEvent(ev('fire-stream', { kind: 'sustain-start' }));
    expect(start).not.toBeNull();
    expect(w.fire.stats().lightsActive).toBe(1);
    for (let i = 0; i < 3; i++) {
      const before = w.fire.flames.liveCount();
      const tick = w.fx.handleEvent(ev('fire-stream', { kind: 'sustain-tick' }));
      expect(tick).not.toBeNull();
      // Spawn times are float32; a fresh spawn registers as live once the
      // clock steps past it, so assert after the frame advances.
      step(w, 1 / 60);
      expect(w.fire.flames.liveCount()).toBeGreaterThan(before);
    }
    const end = w.fx.handleEvent(ev('fire-stream', { kind: 'sustain-end' }));
    expect(end).not.toBeNull();
    expect(end?.alive).toBe(false);
    expect(w.fire.stats().lightsActive).toBe(0);
    step(w, 1 / 60);
    expect(w.fx.effectCount).toBe(0);
    w.fx.dispose();
    w.fire.dispose();
  });

  it('stream ticks re-map the aim each tick (steerable jet)', () => {
    const w = makeWorld();
    w.fx.handleEvent(ev('fire-stream', { kind: 'sustain-start' }));
    // Sweeping right then left: both ticks accepted on the live cone.
    expect(
      w.fx.handleEvent(ev('fire-stream', { kind: 'sustain-tick', aim: { x: 1, y: 0, z: -0.4 } })),
    ).not.toBeNull();
    expect(
      w.fx.handleEvent(ev('fire-stream', { kind: 'sustain-tick', aim: { x: -1, y: 0, z: -0.4 } })),
    ).not.toBeNull();
    w.fx.handleEvent(ev('fire-stream', { kind: 'sustain-end' }));
    expect(w.fire.stats().lightsActive).toBe(0);
    w.fx.dispose();
    w.fire.dispose();
  });

  it('rising-flame wall is active for ~1.2s, spawns continuously, then goes down', () => {
    const w = makeWorld();
    const handle = w.fx.handleEvent(ev('rising-flame'));
    expect(handle).not.toBeNull();
    const wall = w.fx.activeWall;
    expect(wall).not.toBeNull();
    if (!wall) return;
    expect(wall.until).toBeCloseTo(WALL_DURATION_SEC, 5);
    expect(wall.halfWidth).toBeCloseTo(1.2, 5);
    // Wall stands ahead of the player (camera looks down -z).
    expect(wall.center.z).toBeLessThan(w.camera.position.z);
    // Mid-life: still up, jets burning.
    step(w, 1 / 60, 36); // 0.6 s
    expect(w.fx.activeWall).not.toBeNull();
    expect(w.fire.flames.liveCount()).toBeGreaterThan(0);
    expect(w.fire.stats().lightsActive).toBe(1);
    // Past the duration: down, light released.
    step(w, 1 / 60, 45); // 1.35 s total
    expect(w.fx.activeWall).toBeNull();
    expect(handle?.alive).toBe(false);
    expect(w.fire.stats().lightsActive).toBe(0);
    w.fx.dispose();
    w.fire.dispose();
  });

  it('breath-charge exposes chargeActive until consumed by the next move', () => {
    const w = makeWorld();
    w.fx.handleEvent(ev('breath-charge'));
    expect(w.fx.chargeActive).not.toBeNull();
    step(w, 1 / 60, 6);
    expect(w.fx.chargeActive).not.toBeNull();
    // Embers are gathering inward while the charge holds.
    expect(w.fire.embers.liveCount()).toBeGreaterThan(0);
    // The next move consumes the exposed charge.
    w.fx.handleEvent(ev('jab-blast'));
    expect(w.fx.chargeActive).toBeNull();
    w.fx.dispose();
    w.fire.dispose();
  });
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

describe('budget under spam', () => {
  it('300 frames of all-7-move spam stays within particle caps and a bounded registry', () => {
    const w = makeWorld();
    const dt = 1 / 60;
    for (let frame = 0; frame < 300; frame++) {
      if (frame % 10 === 0) {
        w.fx.handleEvent(ev('jab-blast'));
        w.fx.handleEvent(ev('cross-combo', { hand: 'left' }));
        w.fx.handleEvent(ev('twin-cannon', { hand: 'both' }));
        w.fx.handleEvent(ev('rising-flame', { hand: 'both' }));
        w.fx.handleEvent(ev('fire-whip'));
        w.fx.handleEvent(ev('breath-charge', { hand: 'both' }));
        w.fx.handleEvent(ev('fire-stream', { kind: 'sustain-start', hand: 'left' }));
      }
      w.fx.handleEvent(ev('fire-stream', { kind: 'sustain-tick', hand: 'left' }));
      step(w, dt);
      const stats = w.fire.stats();
      expect(stats.total).toBeLessThanOrEqual(6000);
      expect(w.fx.projectiles.length).toBeLessThanOrEqual(MAX_LIVE_PROJECTILES);
      expect(w.fx.effectCount).toBeLessThanOrEqual(64);
    }
    // Everything drains once the spam stops.
    step(w, 0.1, 40); // 4 s
    expect(w.fx.projectiles.length).toBe(0);
    w.fx.dispose();
    w.fire.dispose();
  });

  it('intensityScale reduces spawn volume for the degrade ladder', () => {
    const full = makeWorld();
    const half = makeWorld();
    half.fx.intensityScale = 0.4;
    full.fx.handleEvent(ev('jab-blast'));
    half.fx.handleEvent(ev('jab-blast'));
    expect(half.fire.flames.liveCount()).toBeLessThan(full.fire.flames.liveCount());
    full.fx.dispose();
    full.fire.dispose();
    half.fx.dispose();
    half.fire.dispose();
  });
});

// ---------------------------------------------------------------------------
// ImpactSystem
// ---------------------------------------------------------------------------

describe('ImpactSystem', () => {
  const NORMAL = new THREE.Vector3(0, 1, 0);

  function makeImpactWorld(): { scene: THREE.Group; fire: FireSystem; impact: ImpactSystem } {
    const scene = new THREE.Group();
    const fire = new FireSystem(scene);
    const impact = new ImpactSystem(scene, fire);
    return { scene, fire, impact };
  }

  it('burst creates a decal, sparks and a light pulse', () => {
    const { fire, impact } = makeImpactWorld();
    impact.burst(new THREE.Vector3(1, 0, -5), NORMAL, 1);
    expect(impact.activeDecalCount()).toBe(1);
    const state = impact.decalStates().find((d) => d.active);
    expect(state).toBeDefined();
    expect(state?.opacity ?? 0).toBeGreaterThan(0);
    expect(fire.embers.liveCount()).toBeGreaterThan(0);
    expect(fire.flames.liveCount()).toBeGreaterThan(0);
    expect(fire.stats().lightsActive).toBe(1);
    // The light pulse expires quickly.
    for (let i = 0; i < 30; i++) {
      impact.update(1 / 60);
      fire.update(1 / 60);
    }
    expect(fire.stats().lightsActive).toBe(0);
    impact.dispose();
    fire.dispose();
  });

  it('13th decal recycles the oldest (pool cap 12)', () => {
    const { fire, impact } = makeImpactWorld();
    for (let i = 0; i < MAX_DECALS; i++) {
      impact.burst(new THREE.Vector3(i, 0, -5), NORMAL, 1);
    }
    expect(impact.activeDecalCount()).toBe(MAX_DECALS);
    const oldest = impact.decalStates().reduce((a, b) => (a.seq < b.seq ? a : b));
    expect(oldest.seq).toBe(0);
    impact.burst(new THREE.Vector3(99, 0, -5), NORMAL, 1);
    const states = impact.decalStates();
    expect(states.length).toBe(MAX_DECALS); // pool never grows
    expect(impact.activeDecalCount()).toBe(MAX_DECALS);
    // Slot seq 0 is gone; the recycled slot now sits at the newest position.
    expect(Math.min(...states.map((d) => d.seq))).toBe(1);
    const newest = states.reduce((a, b) => (a.seq > b.seq ? a : b));
    expect(newest.position.x).toBeCloseTo(99, 3);
    impact.dispose();
    fire.dispose();
  });

  it('decals fade to 0 opacity within 10 s and free their slot', () => {
    const { fire, impact } = makeImpactWorld();
    impact.burst(new THREE.Vector3(0, 0, -4), NORMAL, 1.5);
    const first = impact.decalStates().find((d) => d.active);
    const startOpacity = first?.opacity ?? 0;
    expect(startOpacity).toBeGreaterThan(0);
    // Halfway: dimmer but still there.
    for (let i = 0; i < 10; i++) impact.update(DECAL_FADE_SEC / 20);
    const mid = impact.decalStates().find((d) => d.active);
    expect(mid?.opacity ?? 0).toBeGreaterThan(0);
    expect(mid?.opacity ?? 0).toBeLessThan(startOpacity);
    // Full fade.
    for (let i = 0; i < 12; i++) impact.update(DECAL_FADE_SEC / 20);
    expect(impact.activeDecalCount()).toBe(0);
    for (const d of impact.decalStates()) expect(d.opacity).toBe(0);
    impact.dispose();
    fire.dispose();
  });

  it('decal orients to the impact normal', () => {
    const { fire, impact } = makeImpactWorld();
    // A wall hit: normal facing the player (+z).
    impact.burst(new THREE.Vector3(0, 1, -6), new THREE.Vector3(0, 0, 1), 1);
    const state = impact.decalStates().find((d) => d.active);
    expect(state).toBeDefined();
    // Lifted slightly off the surface along the normal.
    expect(state?.position.z ?? -99).toBeGreaterThan(-6);
    impact.dispose();
    fire.dispose();
  });
});
