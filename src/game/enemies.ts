// Training constructs and physics (T050, Section 11): straw-and-wood sparring
// dummies on weighted iron bases. They wobble on a Rapier joint when hit, char
// progressively with damage, and on death break into loose debris that settles
// and fades. Tier 2 constructs lob arcing coal projectiles (kinematic parabola,
// no rapier body). Scope per Section 3: wobble + knockback only, no ragdolls.
//
// Rapier is imported dynamically inside createPhysicsWorld() so this module
// stays cheap to load and tests control WASM init explicitly.

import * as THREE from 'three';
import type * as RapierNS from '@dimforge/rapier3d-compat';

type RapierModule = typeof import('@dimforge/rapier3d-compat');

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

export const FIXED_TIMESTEP = 1 / 60;
const GRAVITY_Y = -9.81;
/** Largest frame delta the accumulator will absorb (avoids spiral of death). */
const MAX_FRAME_DT = 0.25;

/** Default hit points by tier. Director ramps beyond this later. */
export const DEFAULT_HP: Record<ConstructTier, number> = { 1: 100, 2: 160 };

// Torso body: one dynamic capsule pinned to the base by a spherical joint.
const TORSO_CENTER_Y = 1.25;
const PIVOT_Y = 0.32;
const TORSO_CAPSULE_HALF_HEIGHT = 0.55;
const TORSO_CAPSULE_RADIUS = 0.28;
const TORSO_DENSITY = 30; // mass ~10.9 for the capsule above
/** Spring-back torque toward upright, N*m per sin(tilt). */
const SPRING_K = 250;
/** Rapier angular damping on the torso (weighted-base wobble decay). */
const TORSO_ANGULAR_DAMPING = 3.5;
const TORSO_LINEAR_DAMPING = 1.0;

// Death and debris.
const DEBRIS_DENSITY = 2;
const DEBRIS_LINEAR_DAMPING = 2.0;
const DEBRIS_ANGULAR_DAMPING = 3.0;
const DEBRIS_POP_UP = 2.4; // m/s upward pop when the construct breaks
const DEBRIS_POP_OUT = 1.3; // m/s radial scatter
const DEBRIS_SETTLE_LINVEL2 = 0.01; // |v|^2 below this counts as settled
const DEBRIS_SETTLE_ANGVEL2 = 0.05;
const DEBRIS_MAX_SETTLE_SEC = 3.5; // force settle after this long
const FADE_SEC = 2.0;

// Charring: straw and wood lerp toward charcoal with damage percent.
const CHAR_TARGET = new THREE.Color(0x171310);
const CHAR_MAX_MIX = 0.85; // never fully black, keeps silhouette readable

// Palette (Section 9 adjacent: dummy materials, fire stays the only saturation)
const STRAW_TAN = 0xc2a468;
const POST_WOOD = 0x6e4a28;
const DARK_IRON = 0x2c2a2b;
const COAL_BODY = 0x1c0f08;
const COAL_EMBER = 0xe8551c;

// Coal projectiles.
const LOB_ORIGIN_HEIGHT = 1.75;
const LOB_SPEED_HORIZONTAL = 4.5; // m/s used to derive flight time
const LOB_MIN_FLIGHT = 0.9;
const LOB_MAX_FLIGHT = 1.8;
export const COAL_RADIUS = 0.09;

// ---------------------------------------------------------------------------
// Deterministic pseudo-random (debris scatter stays test-stable)
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

// ---------------------------------------------------------------------------
// PhysicsWorld: rapier wrapper with a fixed-timestep accumulator
// ---------------------------------------------------------------------------

export interface PhysicsWorld {
  readonly rapier: RapierModule;
  readonly world: RapierNS.World;
  /**
   * Advance simulation by dt seconds using a fixed 60 Hz accumulator.
   * `beforeStep` runs before each fixed step (per-step forces live there).
   * Returns the number of fixed steps taken.
   */
  step(dt: number, beforeStep?: (stepDt: number) => void): number;
  dispose(): void;
}

export async function createPhysicsWorld(): Promise<PhysicsWorld> {
  const rapier: RapierModule = await import('@dimforge/rapier3d-compat');
  await rapier.init();

  const world = new rapier.World({ x: 0, y: GRAVITY_Y, z: 0 });
  world.timestep = FIXED_TIMESTEP;

  // Static ground plane at y = 0 so debris has something to settle on.
  world.createCollider(
    rapier.ColliderDesc.cuboid(60, 0.5, 60).setTranslation(0, -0.5, 0).setFriction(0.9),
  );

  let accumulator = 0;
  let disposed = false;

  return {
    rapier,
    world,
    step(dt: number, beforeStep?: (stepDt: number) => void): number {
      if (disposed) return 0;
      accumulator += Math.min(Math.max(dt, 0), MAX_FRAME_DT);
      let steps = 0;
      // Epsilon keeps 0.05s frames producing exactly 3 steps despite float drift.
      while (accumulator + 1e-9 >= FIXED_TIMESTEP) {
        if (beforeStep) beforeStep(FIXED_TIMESTEP);
        world.step();
        accumulator -= FIXED_TIMESTEP;
        steps++;
      }
      return steps;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      world.free();
    },
  };
}

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

export type ConstructTier = 1 | 2;

export interface ConstructOptions {
  tier?: ConstructTier;
  hp?: number;
  /** Fired exactly once, with the torso world position at the moment of death. */
  onDeath?: (position: THREE.Vector3) => void;
  /** Seed for debris scatter; defaults to a fixed value for determinism. */
  seed?: number;
}

export interface CoalProjectile {
  readonly mesh: THREE.Mesh;
  /** Live world-space position, updated every frame. */
  readonly position: THREE.Vector3;
  readonly start: THREE.Vector3;
  readonly target: THREE.Vector3;
  readonly radius: number;
  readonly flightTime: number;
  age: number;
}

interface DebrisPiece {
  mesh: THREE.Object3D;
  body: RapierNS.RigidBody;
}

type ConstructState = 'alive' | 'dying' | 'fading' | 'gone';

// Shared scratch objects (single threaded).
const _q = new THREE.Quaternion();
const _bodyUp = new THREE.Vector3();
const _torque = new THREE.Vector3();
const _v = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class Construct {
  readonly group: THREE.Group;
  readonly tier: ConstructTier;
  readonly maxHp: number;
  hp: number;
  /** Fired when a lobbed coal reaches its target. Combat wires block/duck here. */
  onProjectileArrive: ((landPos: THREE.Vector3) => void) | null = null;
  readonly projectiles: CoalProjectile[] = [];

  private readonly physics: PhysicsWorld;
  private readonly parent: THREE.Object3D;
  private state: ConstructState = 'alive';
  private deathPos: THREE.Vector3 | null = null;
  private readonly onDeathCb: ((position: THREE.Vector3) => void) | null;
  private readonly rng: () => number;

  // Physics
  private baseBody: RapierNS.RigidBody;
  private torsoBody: RapierNS.RigidBody | null;
  private joint: RapierNS.ImpulseJoint | null;
  private readonly debrisPieces: DebrisPiece[] = [];
  private deathAge = 0;
  private fadeAge = 0;
  private settled = false;

  // Visuals
  private readonly torsoGroup: THREE.Group;
  private readonly strawMat: THREE.MeshStandardMaterial;
  private readonly woodMat: THREE.MeshStandardMaterial;
  private readonly ironMat: THREE.MeshStandardMaterial;
  private readonly coalMat: THREE.MeshStandardMaterial;
  private readonly strawBase = new THREE.Color(STRAW_TAN);
  private readonly woodBase = new THREE.Color(POST_WOOD);
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly headMesh: THREE.Mesh;
  private readonly debrisCandidates: THREE.Object3D[] = [];
  private readonly coalGeometry: THREE.BufferGeometry;

  // Lobbing
  private lobTarget: THREE.Vector3 | null = null;
  private lobInterval = 0;
  private lobTimer = 0;

  constructor(
    physics: PhysicsWorld,
    parent: THREE.Object3D,
    anchorPos: THREE.Vector3,
    options: ConstructOptions = {},
  ) {
    this.physics = physics;
    this.parent = parent;
    this.tier = options.tier ?? 1;
    this.maxHp = options.hp ?? DEFAULT_HP[this.tier];
    this.hp = this.maxHp;
    this.onDeathCb = options.onDeath ?? null;
    this.rng = mulberry32(options.seed ?? 0xd0117);

    const { rapier, world } = physics;

    this.group = new THREE.Group();
    this.group.name = 'construct';
    this.group.position.set(anchorPos.x, 0, anchorPos.z);
    parent.add(this.group);

    // --- Materials (cloned per construct so charring stays local) ----------
    this.strawMat = new THREE.MeshStandardMaterial({
      color: STRAW_TAN,
      roughness: 1.0,
      metalness: 0.0,
      flatShading: true,
    });
    this.woodMat = new THREE.MeshStandardMaterial({
      color: POST_WOOD,
      roughness: 0.9,
      metalness: 0.0,
      flatShading: true,
    });
    this.ironMat = new THREE.MeshStandardMaterial({
      color: DARK_IRON,
      roughness: 0.6,
      metalness: 0.7,
      flatShading: true,
    });
    this.coalMat = new THREE.MeshStandardMaterial({
      color: COAL_BODY,
      emissive: COAL_EMBER,
      emissiveIntensity: 1.2,
      roughness: 0.8,
      flatShading: true,
    });

    const geo = <T extends THREE.BufferGeometry>(g: T): T => {
      this.geometries.push(g);
      return g;
    };

    // --- Base: weighted dark-iron hemisphere on the floor ------------------
    const baseMesh = new THREE.Mesh(
      geo(new THREE.SphereGeometry(0.45, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)),
      this.ironMat,
    );
    baseMesh.name = 'construct-base';
    baseMesh.castShadow = true;
    this.group.add(baseMesh);

    // --- Torso assembly: everything above the pivot syncs from one body ----
    // Children are positioned relative to the torso body center (world y 1.25).
    this.torsoGroup = new THREE.Group();
    this.torsoGroup.name = 'construct-torso';
    this.torsoGroup.position.set(0, TORSO_CENTER_Y, 0);
    this.group.add(this.torsoGroup);

    const post = new THREE.Mesh(
      geo(new THREE.CylinderGeometry(0.055, 0.07, 1.6, 8)),
      this.woodMat,
    );
    post.name = 'construct-post';
    post.position.set(0, -0.15, 0);

    const torsoMesh = new THREE.Mesh(
      geo(new THREE.CylinderGeometry(0.26, 0.24, 0.8, 9)),
      this.strawMat,
    );
    torsoMesh.name = 'construct-straw-torso';
    torsoMesh.position.set(0, 0.05, 0);
    torsoMesh.castShadow = true;

    const head = new THREE.Mesh(geo(new THREE.SphereGeometry(0.18, 8, 6)), this.strawMat);
    head.name = 'construct-straw-head';
    head.position.set(0, 0.63, 0);
    head.castShadow = true;
    this.headMesh = head;

    const arms = new THREE.Mesh(geo(new THREE.BoxGeometry(1.1, 0.085, 0.085)), this.woodMat);
    arms.name = 'construct-arms';
    arms.position.set(0, 0.3, 0);
    arms.castShadow = true;

    // Dark iron bands around the straw torso. Band 1 is a loose debris piece;
    // the rest ride the torso mesh so they fly off with it on death.
    const bandGeo = geo(new THREE.CylinderGeometry(0.275, 0.275, 0.06, 9));
    const band1 = new THREE.Mesh(bandGeo, this.ironMat);
    band1.name = 'construct-band-1';
    band1.position.set(0, -0.25, 0);
    const band2 = new THREE.Mesh(bandGeo, this.ironMat);
    band2.name = 'construct-band-2';
    band2.position.set(0, 0.25, 0); // local to torsoMesh
    torsoMesh.add(band2);

    this.torsoGroup.add(post, torsoMesh, head, arms, band1);
    this.debrisCandidates.push(torsoMesh, head, arms, post, band1);

    if (this.tier === 2) {
      const band3 = new THREE.Mesh(bandGeo, this.ironMat);
      band3.name = 'construct-band-3';
      band3.position.set(0, -0.05, 0);
      torsoMesh.add(band3);

      // Skeletal-armor silhouette: two flat dark plates on the chest.
      // Original abstract shapes, nothing figurative.
      const plateGeo = geo(new THREE.BoxGeometry(0.34, 0.28, 0.03));
      const plate1 = new THREE.Mesh(plateGeo, this.ironMat);
      plate1.name = 'construct-plate-1';
      plate1.position.set(0, 0.17, 0.28);
      this.torsoGroup.add(plate1);
      const plate2 = new THREE.Mesh(geo(new THREE.BoxGeometry(0.26, 0.2, 0.03)), this.ironMat);
      plate2.name = 'construct-plate-2';
      plate2.position.set(0, -0.09, 0.28);
      this.torsoGroup.add(plate2);
      this.debrisCandidates.push(plate1);
    }

    this.coalGeometry = geo(new THREE.DodecahedronGeometry(COAL_RADIUS, 0));

    // --- Physics -----------------------------------------------------------
    // Base: fixed body, no collider needed (visual dome + joint anchor only).
    this.baseBody = world.createRigidBody(
      rapier.RigidBodyDesc.fixed().setTranslation(anchorPos.x, 0, anchorPos.z),
    );

    // Torso: ONE dynamic body. Gravity is disabled on it: the weighted-base
    // fiction means the assembly is bottom-heavy and self-righting, so the
    // spring below is the only restoring force and upright is a stable
    // equilibrium (no inverted-pendulum fighting).
    const torsoBody = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(anchorPos.x, TORSO_CENTER_Y, anchorPos.z)
        .setLinearDamping(TORSO_LINEAR_DAMPING)
        .setAngularDamping(TORSO_ANGULAR_DAMPING)
        .setGravityScale(0),
    );
    world.createCollider(
      rapier.ColliderDesc.capsule(TORSO_CAPSULE_HALF_HEIGHT, TORSO_CAPSULE_RADIUS).setDensity(
        TORSO_DENSITY,
      ),
      torsoBody,
    );
    this.torsoBody = torsoBody;

    // Spherical joint at the base pivot: wobble in any direction, no sliding.
    this.joint = world.createImpulseJoint(
      rapier.JointData.spherical(
        { x: 0, y: PIVOT_Y, z: 0 },
        { x: 0, y: PIVOT_Y - TORSO_CENTER_Y, z: 0 },
      ),
      this.baseBody,
      torsoBody,
      true,
    );
  }

  // --- State getters -------------------------------------------------------

  get isAlive(): boolean {
    return this.state === 'alive';
  }

  get isGone(): boolean {
    return this.state === 'gone';
  }

  get damagePercent(): number {
    return THREE.MathUtils.clamp(1 - this.hp / this.maxHp, 0, 1);
  }

  /** Torso world position at the moment of death (ember burst spawn point). */
  get deathPosition(): THREE.Vector3 | null {
    return this.deathPos;
  }

  /** Angle in radians between the torso up axis and world up. 0 = upright. */
  get tiltAngle(): number {
    if (!this.torsoBody) return 0;
    const rot = this.torsoBody.rotation();
    _q.set(rot.x, rot.y, rot.z, rot.w);
    _bodyUp.set(0, 1, 0).applyQuaternion(_q);
    return _bodyUp.angleTo(WORLD_UP);
  }

  get debris(): readonly DebrisPiece[] {
    return this.debrisPieces;
  }

  // --- Damage --------------------------------------------------------------

  /**
   * Apply a hit: impulse (N*s, world space) at hitPoint (world space) wobbles
   * the torso; damage accumulates and chars the straw and wood.
   */
  takeHit(damage: number, impulse: THREE.Vector3, hitPoint: THREE.Vector3): void {
    if (this.state !== 'alive' || !this.torsoBody) return;
    this.torsoBody.applyImpulseAtPoint(
      { x: impulse.x, y: impulse.y, z: impulse.z },
      { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z },
      true,
    );
    this.hp = Math.max(0, this.hp - damage);
    this.applyCharring();
    if (this.hp <= 0) this.die();
  }

  private applyCharring(): void {
    const mix = this.damagePercent * CHAR_MAX_MIX;
    this.strawMat.color.lerpColors(this.strawBase, CHAR_TARGET, mix);
    this.woodMat.color.lerpColors(this.woodBase, CHAR_TARGET, mix);
  }

  /**
   * Break the construct: release the joint, detach 4 to 6 debris pieces onto
   * individual small dynamic bodies with an upward pop, fire onDeath once.
   */
  die(): void {
    if (this.state !== 'alive' || !this.torsoBody) return;
    const { rapier, world } = this.physics;

    const t = this.torsoBody.translation();
    this.deathPos = new THREE.Vector3(t.x, t.y, t.z);

    this.stopLobbing();
    this.clearProjectiles();

    if (this.joint) {
      world.removeImpulseJoint(this.joint, true);
      this.joint = null;
    }
    world.removeRigidBody(this.torsoBody);
    this.torsoBody = null;

    // Detach debris meshes, preserving world transforms, and give each a body.
    const radii: Record<string, number> = {
      'construct-straw-torso': 0.28,
      'construct-straw-head': 0.18,
      'construct-arms': 0.12,
      'construct-post': 0.1,
      'construct-band-1': 0.14,
      'construct-plate-1': 0.12,
    };
    for (const mesh of this.debrisCandidates) {
      this.group.attach(mesh);
      mesh.getWorldPosition(_v);
      mesh.getWorldQuaternion(_q);
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(_v.x, _v.y, _v.z)
          .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
          .setLinearDamping(DEBRIS_LINEAR_DAMPING)
          .setAngularDamping(DEBRIS_ANGULAR_DAMPING),
      );
      world.createCollider(
        rapier.ColliderDesc.ball(radii[mesh.name] ?? 0.12)
          .setDensity(DEBRIS_DENSITY)
          .setFriction(0.9)
          .setRestitution(0.15),
        body,
      );
      const angle = this.rng() * Math.PI * 2;
      const out = DEBRIS_POP_OUT * (0.5 + this.rng());
      body.setLinvel(
        {
          x: Math.cos(angle) * out,
          y: DEBRIS_POP_UP * (0.7 + this.rng() * 0.6),
          z: Math.sin(angle) * out,
        },
        true,
      );
      body.setAngvel(
        { x: (this.rng() - 0.5) * 6, y: (this.rng() - 0.5) * 6, z: (this.rng() - 0.5) * 6 },
        true,
      );
      this.debrisPieces.push({ mesh, body });
    }

    // Prepare the whole construct for the post-settle fade.
    for (const mat of [this.strawMat, this.woodMat, this.ironMat, this.coalMat]) {
      mat.transparent = true;
    }

    this.state = 'dying';
    this.deathAge = 0;
    this.onDeathCb?.(this.deathPos.clone());
  }

  // --- Tier 2 lobbing ------------------------------------------------------

  /** Begin lobbing coal projectiles at targetPos every intervalSec seconds. */
  startLobbing(targetPos: THREE.Vector3, intervalSec: number): void {
    if (this.state !== 'alive') return;
    this.lobTarget = targetPos.clone();
    this.lobInterval = Math.max(0.1, intervalSec);
    this.lobTimer = 0;
  }

  stopLobbing(): void {
    this.lobTarget = null;
  }

  private lob(target: THREE.Vector3): void {
    this.headMesh.getWorldPosition(_v);
    const start = new THREE.Vector3(_v.x, this.group.position.y + LOB_ORIGIN_HEIGHT, _v.z);
    const dx = target.x - start.x;
    const dz = target.z - start.z;
    const horizontal = Math.hypot(dx, dz);
    const flightTime = THREE.MathUtils.clamp(
      horizontal / LOB_SPEED_HORIZONTAL,
      LOB_MIN_FLIGHT,
      LOB_MAX_FLIGHT,
    );
    const mesh = new THREE.Mesh(this.coalGeometry, this.coalMat);
    mesh.name = 'coal-projectile';
    this.group.add(mesh);
    const projectile: CoalProjectile = {
      mesh,
      position: start.clone(),
      start: start.clone(),
      target: target.clone(),
      radius: COAL_RADIUS,
      flightTime,
      age: 0,
    };
    this.placeProjectile(projectile);
    this.projectiles.push(projectile);
  }

  /** Ballistic arc: p(t) = start + v0 t + 0.5 g t^2, v0 solved to land on target. */
  private placeProjectile(p: CoalProjectile): void {
    const t = p.age;
    const T = p.flightTime;
    const v0x = (p.target.x - p.start.x) / T;
    const v0z = (p.target.z - p.start.z) / T;
    const v0y = (p.target.y - p.start.y) / T - 0.5 * GRAVITY_Y * T;
    p.position.set(
      p.start.x + v0x * t,
      p.start.y + v0y * t + 0.5 * GRAVITY_Y * t * t,
      p.start.z + v0z * t,
    );
    // Group carries only a translation, so local = world - group position.
    p.mesh.position.copy(p.position).sub(this.group.position);
  }

  private clearProjectiles(): void {
    for (const p of this.projectiles) {
      this.group.remove(p.mesh);
    }
    this.projectiles.length = 0;
  }

  // --- Per-frame hooks (driven by ConstructManager) ------------------------

  /** Runs before every fixed physics step: spring-back torque toward upright. */
  beforePhysicsStep(stepDt: number): void {
    if (this.state !== 'alive' || !this.torsoBody) return;
    const rot = this.torsoBody.rotation();
    _q.set(rot.x, rot.y, rot.z, rot.w);
    _bodyUp.set(0, 1, 0).applyQuaternion(_q);
    // torque axis = bodyUp x worldUp rotates the torso back to upright;
    // magnitude ~ SPRING_K * sin(tilt).
    _torque.crossVectors(_bodyUp, WORLD_UP).multiplyScalar(SPRING_K * stepDt);
    this.torsoBody.applyTorqueImpulse({ x: _torque.x, y: _torque.y, z: _torque.z }, true);
  }

  /** Copies rapier transforms onto the three meshes. Call after physics steps. */
  syncFromPhysics(): void {
    if (this.torsoBody) {
      const t = this.torsoBody.translation();
      const r = this.torsoBody.rotation();
      this.torsoGroup.position.set(
        t.x - this.group.position.x,
        t.y,
        t.z - this.group.position.z,
      );
      this.torsoGroup.quaternion.set(r.x, r.y, r.z, r.w);
    }
    for (const piece of this.debrisPieces) {
      const t = piece.body.translation();
      const r = piece.body.rotation();
      piece.mesh.position.set(
        t.x - this.group.position.x,
        t.y,
        t.z - this.group.position.z,
      );
      piece.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Advances lobbing, projectiles, debris settle detection and the fade. */
  update(dt: number): void {
    // Lobbing.
    if (this.state === 'alive' && this.lobTarget) {
      this.lobTimer += dt;
      while (this.lobTimer >= this.lobInterval) {
        this.lobTimer -= this.lobInterval;
        this.lob(this.lobTarget);
      }
    }

    // Projectiles (kinematic, integrated here, no rapier bodies).
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (!p) continue;
      p.age += dt;
      if (p.age >= p.flightTime) {
        p.age = p.flightTime;
        this.placeProjectile(p);
        const landPos = p.position.clone();
        this.group.remove(p.mesh);
        this.projectiles.splice(i, 1);
        this.onProjectileArrive?.(landPos);
      } else {
        this.placeProjectile(p);
      }
    }

    // Death sequence: wait for debris to settle, then fade out.
    if (this.state === 'dying') {
      this.deathAge += dt;
      if (!this.settled) {
        let allSlow = true;
        for (const piece of this.debrisPieces) {
          const lv = piece.body.linvel();
          const av = piece.body.angvel();
          if (
            lv.x * lv.x + lv.y * lv.y + lv.z * lv.z > DEBRIS_SETTLE_LINVEL2 ||
            av.x * av.x + av.y * av.y + av.z * av.z > DEBRIS_SETTLE_ANGVEL2
          ) {
            allSlow = false;
            break;
          }
        }
        if (allSlow || this.deathAge >= DEBRIS_MAX_SETTLE_SEC) {
          this.settled = true;
          this.state = 'fading';
          this.fadeAge = 0;
        }
      }
    } else if (this.state === 'fading') {
      this.fadeAge += dt;
      const opacity = Math.max(0, 1 - this.fadeAge / FADE_SEC);
      this.strawMat.opacity = opacity;
      this.woodMat.opacity = opacity;
      this.ironMat.opacity = opacity;
      this.coalMat.opacity = opacity;
      if (this.fadeAge >= FADE_SEC) {
        this.dispose();
      }
    }
  }

  /** Full cleanup: physics bodies, meshes, geometries, materials. Idempotent. */
  dispose(): void {
    if (this.state === 'gone') return;
    const { world } = this.physics;
    if (this.joint) {
      world.removeImpulseJoint(this.joint, true);
      this.joint = null;
    }
    if (this.torsoBody) {
      world.removeRigidBody(this.torsoBody);
      this.torsoBody = null;
    }
    for (const piece of this.debrisPieces) {
      world.removeRigidBody(piece.body);
    }
    this.debrisPieces.length = 0;
    world.removeRigidBody(this.baseBody);
    this.clearProjectiles();
    this.parent.remove(this.group);
    this.group.clear();
    for (const g of this.geometries) g.dispose();
    this.strawMat.dispose();
    this.woodMat.dispose();
    this.ironMat.dispose();
    this.coalMat.dispose();
    this.state = 'gone';
  }
}

// ---------------------------------------------------------------------------
// ConstructManager
// ---------------------------------------------------------------------------

export class ConstructManager {
  /** Director hook: fired for every construct death with its world position. */
  onDeath: ((construct: Construct, position: THREE.Vector3) => void) | null = null;

  private readonly physics: PhysicsWorld;
  private readonly parent: THREE.Object3D;
  private list: Construct[] = [];
  private spawnCount = 0;

  constructor(physics: PhysicsWorld, parent: THREE.Object3D) {
    this.physics = physics;
    this.parent = parent;
  }

  spawn(anchorPos: THREE.Vector3, tier: ConstructTier = 1, hp?: number): Construct {
    const construct: Construct = new Construct(this.physics, this.parent, anchorPos, {
      tier,
      ...(hp !== undefined ? { hp } : {}),
      seed: 0xd0117 + this.spawnCount * 7919,
      onDeath: (position) => {
        this.onDeath?.(construct, position);
      },
    });
    this.spawnCount++;
    this.list.push(construct);
    return construct;
  }

  /** All tracked constructs, including ones mid-death. */
  get constructs(): readonly Construct[] {
    return this.list;
  }

  /** The construct the player is currently fighting (first live one). */
  get activeConstruct(): Construct | null {
    for (const c of this.list) {
      if (c.isAlive) return c;
    }
    return null;
  }

  /**
   * Steps the physics world (fixed 60 Hz accumulator), applies per-step spring
   * torques, syncs three transforms from rapier, advances charring, debris and
   * projectiles, and drops constructs whose debris has faded out.
   */
  update(dt: number): void {
    this.physics.step(dt, (stepDt) => {
      for (const c of this.list) c.beforePhysicsStep(stepDt);
    });
    for (const c of this.list) {
      c.syncFromPhysics();
      c.update(dt);
    }
    if (this.list.some((c) => c.isGone)) {
      this.list = this.list.filter((c) => !c.isGone);
    }
  }

  /** Disposes every construct. Does not dispose the shared physics world. */
  dispose(): void {
    for (const c of this.list) c.dispose();
    this.list = [];
  }
}
