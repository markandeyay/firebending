// Impact layer (T041, Section 10 layer 6): spark burst, scorch decal fading
// over 10 s, and a brief warm light pulse. The combat layer calls burst() on
// every projectile hit (typically right after ProjectileEffect.onImpact).
//
// No bloom here: the restrained bloom pulse is a renderer-level pass added
// later. Decals are pooled (MAX_DECALS quads, oldest recycled) and oriented
// by the impact normal, so hits on the ground lie flat and hits on a
// construct plaster onto its surface. Everything is headless-safe: no canvas
// textures, no WebGL calls.

import * as THREE from 'three';
import type { FireLightHandle, FireSystem } from './fire';

/** Scorch decal pool size; the 13th burst recycles the oldest decal. */
export const MAX_DECALS = 12;
/** Seconds for a scorch decal to fade to nothing. */
export const DECAL_FADE_SEC = 10;
/** Peak decal opacity at strength 1. */
const DECAL_BASE_OPACITY = 0.55;
/** Lift along the normal to avoid z-fighting with the surface. */
const DECAL_LIFT = 0.02;
/** Seconds the impact light pulse lasts. */
const LIGHT_PULSE_SEC = 0.25;

/** Read-only view of one decal slot, for combat/tests. */
export interface DecalState {
  active: boolean;
  /** Current opacity 0..1 (0 when inactive). */
  opacity: number;
  /** Monotonic acquisition sequence; lower = older. -1 = never used. */
  seq: number;
  position: THREE.Vector3;
}

interface DecalSlot {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  active: boolean;
  seq: number;
  baseOpacity: number;
}

interface LightPulse {
  handle: FireLightHandle;
  ttl: number;
}

const _z = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class ImpactSystem {
  readonly group: THREE.Group;

  private readonly fire: FireSystem;
  private readonly decals: DecalSlot[] = [];
  private readonly pulses: LightPulse[] = [];
  private readonly circle: THREE.CircleGeometry;
  private seq = 0;

  constructor(scene: THREE.Object3D, fire: FireSystem) {
    this.fire = fire;
    this.group = new THREE.Group();
    this.group.name = 'impact-system';
    // Shared unit circle; per-decal size comes from mesh.scale.
    this.circle = new THREE.CircleGeometry(0.5, 20);
    for (let i = 0; i < MAX_DECALS; i++) {
      // Charred wood, not pure black: stays inside the warm charcoal palette.
      const material = new THREE.MeshBasicMaterial({
        color: 0x140d08,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });
      const mesh = new THREE.Mesh(this.circle, material);
      mesh.name = `scorch-decal-${i}`;
      mesh.visible = false;
      mesh.renderOrder = 5; // above the floor, below the fire layers
      this.group.add(mesh);
      this.decals.push({ mesh, material, age: 0, active: false, seq: -1, baseOpacity: 0 });
    }
    scene.add(this.group);
  }

  /**
   * One impact: spark burst (fast short-lived embers), a small flame flash,
   * a scorch decal oriented by `normal`, and a warm light pulse. `strength`
   * scales everything; jabs land around 1, the twin cannon around 2.
   */
  burst(position: THREE.Vector3, normal: THREE.Vector3, strength = 1): void {
    const s = Math.max(0.25, strength);
    const n = _n.copy(normal);
    if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
    n.normalize();

    // Sparks: embers thrown off the surface, high speed, short life.
    const sparkVel = n.clone().multiplyScalar(2.5 + 2.5 * s);
    sparkVel.y += 0.8;
    this.fire.embers.spawn({
      position,
      velocity: sparkVel,
      size: 0.05,
      lifetime: 0.35,
      count: Math.min(40, Math.round(10 + 12 * s)),
      spread: 0.35,
    });

    // Brief flame flash hugging the surface.
    this.fire.flames.spawn({
      position,
      velocity: n.clone().multiplyScalar(1.2),
      size: 0.28 + 0.22 * s,
      lifetime: 0.22,
      count: Math.min(18, Math.round(4 + 5 * s)),
      spread: 0.12 * s,
    });

    // Light pulse.
    const handle = this.fire.lights.acquire(
      _tmp.copy(position).addScaledVector(n, 0.2),
      2.5 + 2.5 * s,
      5 + 2 * s,
    );
    this.pulses.push({ handle, ttl: LIGHT_PULSE_SEC });

    // Scorch decal: free slot first, else recycle the oldest.
    let slot: DecalSlot | undefined;
    for (const d of this.decals) {
      if (!d.active) {
        slot = d;
        break;
      }
    }
    if (!slot) {
      for (const d of this.decals) {
        if (!slot || d.seq < slot.seq) slot = d;
      }
    }
    if (!slot) return; // pool empty only after dispose()
    slot.active = true;
    slot.age = 0;
    slot.seq = this.seq++;
    slot.baseOpacity = Math.min(0.8, DECAL_BASE_OPACITY * (0.7 + 0.3 * s));
    slot.material.opacity = slot.baseOpacity;
    slot.mesh.visible = true;
    slot.mesh.position.copy(position).addScaledVector(n, DECAL_LIFT);
    slot.mesh.quaternion.setFromUnitVectors(_z, n);
    const size = 0.35 + 0.4 * s;
    slot.mesh.scale.setScalar(size);
  }

  /** Fade decals and expire light pulses. Call once per frame. */
  update(dt: number): void {
    for (const d of this.decals) {
      if (!d.active) continue;
      d.age += dt;
      const k = 1 - d.age / DECAL_FADE_SEC;
      if (k <= 0) {
        d.active = false;
        d.material.opacity = 0;
        d.mesh.visible = false;
      } else {
        d.material.opacity = d.baseOpacity * k;
      }
    }
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      if (!p) continue;
      p.ttl -= dt;
      if (p.ttl <= 0 || !p.handle.alive) {
        p.handle.release();
        this.pulses.splice(i, 1);
      }
    }
  }

  /** Read-only decal pool state (combat/tests; order is pool order). */
  decalStates(): DecalState[] {
    return this.decals.map((d) => ({
      active: d.active,
      opacity: d.active ? d.material.opacity : 0,
      seq: d.seq,
      position: d.mesh.position,
    }));
  }

  activeDecalCount(): number {
    let n = 0;
    for (const d of this.decals) if (d.active) n++;
    return n;
  }

  dispose(): void {
    for (const p of this.pulses) p.handle.release();
    this.pulses.length = 0;
    for (const d of this.decals) d.material.dispose();
    this.decals.length = 0;
    this.circle.dispose();
    this.group.parent?.remove(this.group);
    this.group.clear();
  }
}
