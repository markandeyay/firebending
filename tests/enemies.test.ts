// Headless construct + physics checks (T050). Rapier's compat build runs in
// node for real (inlined wasm, await RAPIER.init()), no camera, no WebGL.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CONSTRUCT_VARIANTS,
  ConstructManager,
  createPhysicsWorld,
  DEBRIS_KEEP_CAP,
  DEFAULT_HP,
  FIXED_TIMESTEP,
  SMOKE_THRESHOLD,
  type CoalProjectile,
  type PhysicsWorld,
} from '../src/game/enemies';

const ANCHOR = new THREE.Vector3(0, 1.1, -6);

async function makeWorld(): Promise<PhysicsWorld> {
  return createPhysicsWorld();
}

function makeManager(physics: PhysicsWorld): { manager: ConstructManager; root: THREE.Group } {
  const root = new THREE.Group();
  const manager = new ConstructManager(physics, root);
  return { manager, root };
}

/** Advance the manager in fixed frame-sized increments for `seconds`. */
function run(manager: ConstructManager, seconds: number, frameDt = FIXED_TIMESTEP): void {
  const frames = Math.round(seconds / frameDt);
  for (let i = 0; i < frames; i++) manager.update(frameDt);
}

function countMeshes(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) n++;
  });
  return n;
}

describe('PhysicsWorld', () => {
  it('fixed-timestep accumulator: 3 updates of 0.05s produce exactly 9 steps', async () => {
    const physics = await makeWorld();
    let total = 0;
    total += physics.step(0.05);
    total += physics.step(0.05);
    total += physics.step(0.05);
    expect(total).toBe(9);
    physics.dispose();
  });

  it('invokes beforeStep once per fixed step with the step size', async () => {
    const physics = await makeWorld();
    const dts: number[] = [];
    physics.step(0.1, (stepDt) => {
      dts.push(stepDt);
    });
    expect(dts.length).toBe(6);
    for (const dt of dts) expect(dt).toBeCloseTo(FIXED_TIMESTEP, 10);
    physics.dispose();
  });

  it('steps deterministically and has a ground plane at y = 0', async () => {
    const results: number[][] = [];
    for (let trial = 0; trial < 2; trial++) {
      const physics = await makeWorld();
      const { rapier, world } = physics;
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic().setTranslation(0.1, 2, -3),
      );
      world.createCollider(rapier.ColliderDesc.ball(0.2).setDensity(1), body);
      for (let i = 0; i < 180; i++) physics.step(FIXED_TIMESTEP);
      const t = body.translation();
      results.push([t.x, t.y, t.z]);
      physics.dispose();
    }
    const a = results[0];
    const b = results[1];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) return;
    expect(a[0]).toBe(b[0]);
    expect(a[1]).toBe(b[1]);
    expect(a[2]).toBe(b[2]);
    // Ball came to rest on the ground, not falling forever.
    expect(a[1] ?? 0).toBeGreaterThan(0.05);
    expect(a[1] ?? 0).toBeLessThan(0.5);
  });
});

describe('Construct', () => {
  it('spawns upright at the anchor and stays upright without hits', async () => {
    const physics = await makeWorld();
    const { manager, root } = makeManager(physics);
    const construct = manager.spawn(ANCHOR, 1);
    expect(root.children).toContain(construct.group);
    expect(construct.group.position.x).toBeCloseTo(ANCHOR.x, 5);
    expect(construct.group.position.z).toBeCloseTo(ANCHOR.z, 5);
    expect(construct.tiltAngle).toBeCloseTo(0, 3);
    run(manager, 1.0);
    expect(construct.tiltAngle).toBeLessThan(0.02);
    expect(construct.isAlive).toBe(true);
    manager.dispose();
    physics.dispose();
  });

  it('uses tier HP defaults: 100 for tier 1, 160 for tier 2', async () => {
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    const t1 = manager.spawn(ANCHOR, 1);
    const t2 = manager.spawn(new THREE.Vector3(2, 1.1, -6), 2);
    expect(DEFAULT_HP[1]).toBe(100);
    expect(DEFAULT_HP[2]).toBe(160);
    expect(t1.maxHp).toBe(100);
    expect(t2.maxHp).toBe(160);
    const custom = manager.spawn(new THREE.Vector3(-2, 1.1, -6), 1, 250);
    expect(custom.maxHp).toBe(250);
    manager.dispose();
    physics.dispose();
  });

  it('takeHit wobbles the torso, then it springs back toward upright', async () => {
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    const construct = manager.spawn(ANCHOR, 1);

    construct.takeHit(
      10,
      new THREE.Vector3(0, 0, -14),
      new THREE.Vector3(ANCHOR.x, 1.9, ANCHOR.z + 0.25),
    );
    manager.update(FIXED_TIMESTEP);

    // Wobble: nonzero angular velocity right after the hit.
    const { world } = physics;
    let spinning = false;
    world.forEachRigidBody((body) => {
      const av = body.angvel();
      if (av.x * av.x + av.y * av.y + av.z * av.z > 0.01) spinning = true;
    });
    expect(spinning).toBe(true);

    // Peak tilt develops within the first half second.
    let peak = construct.tiltAngle;
    for (let i = 0; i < 30; i++) {
      manager.update(FIXED_TIMESTEP);
      peak = Math.max(peak, construct.tiltAngle);
    }
    expect(peak).toBeGreaterThan(0.03);

    // Spring-back: tilt decays well below peak within ~2s of settling.
    run(manager, 2.0);
    expect(construct.tiltAngle).toBeLessThan(peak * 0.5);
    expect(construct.tiltAngle).toBeLessThan(0.1);
    expect(construct.isAlive).toBe(true);
    manager.dispose();
    physics.dispose();
  });

  it('accumulates damage and chars monotonically; other constructs unaffected', async () => {
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    const a = manager.spawn(ANCHOR, 1);
    const b = manager.spawn(new THREE.Vector3(2, 1.1, -6), 1);

    const strawOf = (c: typeof a): THREE.MeshStandardMaterial => {
      let found: THREE.MeshStandardMaterial | null = null;
      c.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.name === 'construct-straw-torso') {
          found = obj.material as THREE.MeshStandardMaterial;
        }
      });
      expect(found).not.toBeNull();
      return found as unknown as THREE.MeshStandardMaterial;
    };

    const matA = strawOf(a);
    const matB = strawOf(b);
    expect(matA).not.toBe(matB); // materials cloned per construct
    const bBefore = matB.color.getHex();

    const lightness = (m: THREE.MeshStandardMaterial): number =>
      m.color.r + m.color.g + m.color.b;
    const start = lightness(matA);
    const hitPoint = new THREE.Vector3(ANCHOR.x, 1.4, ANCHOR.z + 0.26);
    const impulse = new THREE.Vector3(0, 0, -2);

    let previous = start;
    for (let i = 0; i < 3; i++) {
      a.takeHit(20, impulse, hitPoint);
      const now = lightness(matA);
      expect(now).toBeLessThan(previous); // darkens monotonically with damage
      previous = now;
    }
    expect(a.hp).toBe(a.maxHp - 60);
    expect(a.damagePercent).toBeCloseTo(0.6, 5);
    expect(matB.color.getHex()).toBe(bBefore); // charring stays per construct
    manager.dispose();
    physics.dispose();
  });

  it('dies at 0 HP: onDeath once, 4-6 debris pieces settle, manager removes it', async () => {
    const physics = await makeWorld();
    const { manager, root } = makeManager(physics);
    const construct = manager.spawn(ANCHOR, 1, 30);

    let deaths = 0;
    let deathPos: THREE.Vector3 | null = null;
    manager.onDeath = (c, position) => {
      expect(c).toBe(construct);
      deaths++;
      deathPos = position.clone();
    };

    const hitPoint = new THREE.Vector3(ANCHOR.x, 1.4, ANCHOR.z + 0.26);
    construct.takeHit(30, new THREE.Vector3(0, 0, -8), hitPoint);

    expect(deaths).toBe(1);
    expect(construct.isAlive).toBe(false);
    expect(construct.hp).toBe(0);
    expect(deathPos).not.toBeNull();
    expect(construct.deathPosition).not.toBeNull();
    expect(construct.deathPosition?.z).toBeCloseTo(ANCHOR.z, 0);

    // Hitting a dead construct must not re-trigger death.
    construct.takeHit(50, new THREE.Vector3(0, 0, -8), hitPoint);
    expect(deaths).toBe(1);

    expect(construct.debris.length).toBeGreaterThanOrEqual(4);
    expect(construct.debris.length).toBeLessThanOrEqual(6);

    // Debris settles: positions stop changing.
    run(manager, 4.0);
    const before = construct.debris.map((piece) => piece.mesh.position.clone());
    run(manager, 0.5);
    construct.debris.forEach((piece, i) => {
      const prev = before[i];
      expect(prev).toBeDefined();
      if (!prev) return;
      expect(piece.mesh.position.distanceTo(prev)).toBeLessThan(0.02);
    });

    // Battle scars (Phase 5): settled debris RESTS in place instead of
    // fading; the construct stays alive in the manager list.
    run(manager, 3.0);
    expect(construct.isResting).toBe(true);
    expect(manager.constructs.length).toBe(1);
    expect(root.children).toContain(construct.group);
    expect(manager.activeConstruct).toBeNull();

    // An explicit beginFade (the manager's cap path) runs the old fade-out.
    construct.beginFade();
    run(manager, 2.5);
    expect(manager.constructs.length).toBe(0);
    expect(root.children).not.toContain(construct.group);
    expect(construct.isGone).toBe(true);
    manager.dispose();
    physics.dispose();
  });

  it('caps kept debris near DEBRIS_KEEP_CAP, fading the oldest kill first', async () => {
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    // Five tier 1 kills leave 5 debris pieces each = 25 > 24.
    const constructs = [];
    for (let i = 0; i < 5; i++) {
      const c = manager.spawn(new THREE.Vector3(i * 2 - 4, 1.1, -6), 1, 10);
      c.takeHit(10, new THREE.Vector3(0, 0, -6), new THREE.Vector3(i * 2 - 4, 1.4, -5.7));
      constructs.push(c);
    }
    // Let everything settle; the cap then fades exactly the OLDEST one.
    run(manager, 4.0);
    const first = constructs[0];
    expect(first).toBeDefined();
    run(manager, 2.5); // fade completes
    expect(first?.isGone).toBe(true);
    let pieces = 0;
    for (const c of manager.constructs) pieces += c.debris.length;
    expect(pieces).toBeLessThanOrEqual(DEBRIS_KEEP_CAP);
    // The younger four remain as resting battle scars.
    expect(manager.constructs.length).toBe(4);
    for (const c of manager.constructs) expect(c.isResting).toBe(true);
    manager.dispose();
    physics.dispose();
  }, 20000);

  it('activeConstruct returns the first live construct', async () => {
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    const first = manager.spawn(ANCHOR, 1, 10);
    const second = manager.spawn(new THREE.Vector3(0, 1.1, -12), 1);
    expect(manager.activeConstruct).toBe(first);
    first.takeHit(10, new THREE.Vector3(0, 0, -4), new THREE.Vector3(0, 1.4, -5.7));
    expect(manager.activeConstruct).toBe(second);
    manager.dispose();
    physics.dispose();
  });
});

describe('tier 2 lobbing', () => {
  it('spawns projectiles on the interval, arcs them to the target, fires onArrive', async () => {
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    const construct = manager.spawn(ANCHOR, 2);
    const target = new THREE.Vector3(0, 1.4, 0);

    const arrivals: THREE.Vector3[] = [];
    construct.onProjectileArrive = (landPos) => {
      arrivals.push(landPos.clone());
    };
    // Interval longer than the flight time so arrivals are easy to isolate.
    construct.startLobbing(target, 2.0);

    // No projectile before the first interval elapses.
    run(manager, 1.9);
    expect(construct.projectiles.length).toBe(0);

    run(manager, 0.15);
    expect(construct.projectiles.length).toBe(1);
    const projectile = construct.projectiles[0] as CoalProjectile;
    expect(projectile).toBeDefined();
    const startY = projectile.start.y;

    // Track the arc until arrival.
    let maxY = -Infinity;
    let guard = 0;
    while (arrivals.length === 0 && guard < 300) {
      manager.update(FIXED_TIMESTEP);
      const p = construct.projectiles[0];
      if (p) maxY = Math.max(maxY, p.position.y);
      guard++;
    }

    // Apex clears both endpoints: a lob, not a line drive.
    expect(maxY).toBeGreaterThan(startY + 0.2);
    expect(maxY).toBeGreaterThan(target.y + 0.2);

    // Arrived near the target, list cleaned up, callback fired once so far.
    expect(arrivals.length).toBe(1);
    const landing = arrivals[0];
    expect(landing).toBeDefined();
    if (landing) expect(landing.distanceTo(target)).toBeLessThan(0.25);
    expect(construct.projectiles.length).toBe(0);

    // Second projectile follows on the next interval (t = 4.0s).
    run(manager, 0.75);
    expect(construct.projectiles.length).toBeGreaterThanOrEqual(1);

    construct.stopLobbing();
    const count = construct.projectiles.length;
    run(manager, 2.5);
    // Existing projectiles finish, no new ones spawn after stopLobbing.
    expect(construct.projectiles.length).toBeLessThanOrEqual(count);
    expect(construct.projectiles.length).toBe(0);
    manager.dispose();
    physics.dispose();
  });

  it('death stops lobbing and clears in-flight projectiles', async () => {
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    const construct = manager.spawn(ANCHOR, 2, 20);
    construct.startLobbing(new THREE.Vector3(0, 1.4, 0), 0.3);
    run(manager, 0.7);
    expect(construct.projectiles.length).toBeGreaterThan(0);
    construct.takeHit(20, new THREE.Vector3(0, 0, -6), new THREE.Vector3(0, 1.4, -5.7));
    expect(construct.projectiles.length).toBe(0);
    run(manager, 1.0);
    expect(construct.projectiles.length).toBe(0);
    manager.dispose();
    physics.dispose();
  });
});

describe('damage staging', () => {
  it('burn level starts at 0, rises monotonically with damage, caps below 1', async () => {
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    const c = manager.spawn(ANCHOR, 1);
    expect(c.burnLevel).toBe(0);
    const hitPoint = new THREE.Vector3(ANCHOR.x, 1.4, ANCHOR.z + 0.26);
    const impulse = new THREE.Vector3(0, 0, -1);
    let previous = 0;
    for (let i = 0; i < 4; i++) {
      c.takeHit(20, impulse, hitPoint);
      expect(c.burnLevel).toBeGreaterThan(previous);
      previous = c.burnLevel;
    }
    // 80% damage: patches burned away but the silhouette survives (< 1).
    expect(c.burnLevel).toBeLessThan(0.7);
    manager.dispose();
    physics.dispose();
  });

  it('smoke stage engages only above the 50% damage threshold, off when dead', async () => {
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    const c = manager.spawn(ANCHOR, 1);
    const hitPoint = new THREE.Vector3(ANCHOR.x, 1.4, ANCHOR.z + 0.26);
    const impulse = new THREE.Vector3(0, 0, -1);
    const out = new THREE.Vector3();

    expect(SMOKE_THRESHOLD).toBeCloseTo(0.5, 5);
    expect(c.smokeIntensity).toBe(0);
    expect(c.smokeSource(out)).toBeNull();

    c.takeHit(40, impulse, hitPoint); // 40% < threshold
    expect(c.smokeIntensity).toBe(0);
    expect(c.smokeSource(out)).toBeNull();

    c.takeHit(30, impulse, hitPoint); // 70% > threshold
    expect(c.smokeIntensity).toBeGreaterThan(0);
    const src = c.smokeSource(out);
    expect(src).not.toBeNull();
    // Wound point sits on the torso, near the anchor.
    if (src) {
      expect(Math.hypot(src.x - ANCHOR.x, src.z - ANCHOR.z)).toBeLessThan(1);
      expect(src.y).toBeGreaterThan(0.5);
    }

    c.takeHit(30, impulse, hitPoint); // dead
    expect(c.isAlive).toBe(false);
    expect(c.smokeIntensity).toBe(0);
    expect(c.smokeSource(out)).toBeNull();
    manager.dispose();
    physics.dispose();
  });
});

describe('visual variants', () => {
  it('exposes six variants and plumbs the requested index through spawn', async () => {
    expect(CONSTRUCT_VARIANTS.length).toBe(6);
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    for (let i = 0; i < 6; i++) {
      const c = manager.spawn(new THREE.Vector3(i * 2 - 6, 1.1, -6), 1, undefined, undefined, i);
      expect(c.variantIndex).toBe(i);
    }
    // Wrapping: variant 7 -> 1.
    const wrapped = manager.spawn(new THREE.Vector3(8, 1.1, -6), 1, undefined, undefined, 7);
    expect(wrapped.variantIndex).toBe(1);
    manager.dispose();
    physics.dispose();
  });

  it('defaults cycle the variant table by spawn order', async () => {
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    const a = manager.spawn(ANCHOR, 1);
    const b = manager.spawn(new THREE.Vector3(2, 1.1, -6), 1);
    expect(a.variantIndex).toBe(0);
    expect(b.variantIndex).toBe(1);
    manager.dispose();
    physics.dispose();
  });

  it('variants differ visibly: distinct straw tones per station', () => {
    const tones = new Set(CONSTRUCT_VARIANTS.map((v) => v.straw));
    expect(tones.size).toBe(6);
    // At least two band-count tiers so silhouettes vary.
    const bandCounts = new Set(CONSTRUCT_VARIANTS.map((v) => v.bands));
    expect(bandCounts.size).toBeGreaterThanOrEqual(2);
  });
});

describe('budgets', () => {
  it('keeps the mesh node count small (<= 15 per construct, both tiers, all variants)', async () => {
    const physics = await makeWorld();
    const { manager } = makeManager(physics);
    for (let variant = 0; variant < CONSTRUCT_VARIANTS.length; variant++) {
      const t1 = manager.spawn(
        new THREE.Vector3(variant * 2 - 6, 1.1, -6),
        1,
        undefined,
        undefined,
        variant,
      );
      const t2 = manager.spawn(
        new THREE.Vector3(variant * 2 - 6, 1.1, -10),
        2,
        undefined,
        undefined,
        variant,
      );
      expect(countMeshes(t1.group)).toBeLessThanOrEqual(15);
      expect(countMeshes(t2.group)).toBeLessThanOrEqual(15);
      expect(countMeshes(t1.group)).toBeGreaterThanOrEqual(5);
    }
    manager.dispose();
    physics.dispose();
  });
});
