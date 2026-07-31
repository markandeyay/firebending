// Headless arena checks: no WebGL, no DOM. Structure, budgets and runtime
// behavior only. Visual quality is a HUMAN item via mountArenaDebug.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildArena, STATION_LIGHT_SLOTS } from '../src/game/arena';
import { STATION_COUNT } from '../src/game/killTravel';

function countDynamicLights(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((obj) => {
    if (
      obj instanceof THREE.PointLight ||
      obj instanceof THREE.SpotLight ||
      obj instanceof THREE.DirectionalLight ||
      obj instanceof THREE.RectAreaLight
    ) {
      n++;
    }
  });
  return n;
}

function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) meshes.push(obj);
  });
  return meshes;
}

describe('arena', () => {
  it('builds a populated group into the scene', () => {
    const scene = new THREE.Scene();
    const arena = buildArena(scene);
    expect(scene.children).toContain(arena.group);
    expect(arena.group.children.length).toBeGreaterThan(0);
    expect(collectMeshes(arena.group).length).toBeGreaterThan(5);
    arena.dispose();
  });

  it('stays within the dynamic light budget (key + 4 station lights <= 8)', () => {
    const scene = new THREE.Scene();
    const arena = buildArena(scene);
    expect(countDynamicLights(arena.group)).toBeLessThanOrEqual(8);
    // Light policy: exactly four RELOCATABLE station point lights; braziers
    // themselves are emissive-only (no light parented under a brazier).
    expect(arena.lights.braziers.length).toBe(4);
    arena.group.traverse((obj) => {
      if (obj.name.startsWith('brazier-')) {
        obj.traverse((child) => {
          expect(child instanceof THREE.PointLight).toBe(false);
        });
      }
    });
    arena.dispose();
  });

  it('keeps the draw-call proxy low: unique Mesh/InstancedMesh nodes <= 110', () => {
    const scene = new THREE.Scene();
    const arena = buildArena(scene);
    expect(collectMeshes(arena.group).length).toBeLessThanOrEqual(110);
    arena.dispose();
  });

  it('builds the courtyard set pieces (gate, colonnade, terrace, steps, bridge, channel)', () => {
    const scene = new THREE.Scene();
    const arena = buildArena(scene);
    const names = new Set<string>();
    arena.group.traverse((obj) => names.add(obj.name));
    for (const required of [
      'great-gate',
      'colonnade',
      'terrace',
      'steps',
      'bridge',
      'coal-channel',
      'coal-wall',
      'canopy-rods',
    ]) {
      expect(names.has(required)).toBe(true);
    }
    arena.dispose();
  });

  it('relocates the four station lights per station (setActiveStation)', () => {
    const scene = new THREE.Scene();
    const arena = buildArena(scene);
    expect(STATION_LIGHT_SLOTS.length).toBe(STATION_COUNT);
    const posAt = (station: number): THREE.Vector3[] => {
      arena.setActiveStation(station);
      return arena.lights.braziers.map((l) => l.position.clone());
    };
    const at0 = posAt(0);
    // Boot state matches station 0.
    STATION_LIGHT_SLOTS[0]?.forEach((slot, i) => {
      expect(at0[i]?.x).toBeCloseTo(slot[0]);
      expect(at0[i]?.y).toBeCloseTo(slot[1]);
      expect(at0[i]?.z).toBeCloseTo(slot[2]);
    });
    for (let s = 1; s < STATION_COUNT; s++) {
      const here = posAt(s);
      STATION_LIGHT_SLOTS[s]?.forEach((slot, i) => {
        expect(here[i]?.x).toBeCloseTo(slot[0]);
        expect(here[i]?.z).toBeCloseTo(slot[2]);
      });
      // Genuinely moved relative to station 0.
      expect(here.some((p, i) => p.distanceTo(at0[i] ?? p) > 1)).toBe(true);
    }
    // Indices wrap like the station cycle.
    arena.setActiveStation(STATION_COUNT);
    const wrapped = arena.lights.braziers.map((l) => l.position.clone());
    STATION_LIGHT_SLOTS[0]?.forEach((slot, i) => {
      expect(wrapped[i]?.x).toBeCloseTo(slot[0]);
      expect(wrapped[i]?.z).toBeCloseTo(slot[2]);
    });
    arena.dispose();
  });

  it('uses instancing for repeated elements (columns et al.)', () => {
    const scene = new THREE.Scene();
    const arena = buildArena(scene);
    const instanced = collectMeshes(arena.group).filter(
      (m) => m instanceof THREE.InstancedMesh,
    );
    expect(instanced.length).toBeGreaterThanOrEqual(1);
    expect(instanced.some((m) => m.name === 'columns')).toBe(true);
    arena.dispose();
  });

  it('places every mesh at a finite world position', () => {
    const scene = new THREE.Scene();
    const arena = buildArena(scene);
    scene.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    for (const mesh of collectMeshes(arena.group)) {
      pos.setFromMatrixPosition(mesh.matrixWorld);
      expect(Number.isFinite(pos.x)).toBe(true);
      expect(Number.isFinite(pos.y)).toBe(true);
      expect(Number.isFinite(pos.z)).toBe(true);
    }
    arena.dispose();
  });

  it('exposes player position, enemy anchor and brazier anchors', () => {
    const scene = new THREE.Scene();
    const arena = buildArena(scene);
    expect(arena.playerPosition.z).toBeCloseTo(0, 1);
    expect(arena.enemyAnchor.z).toBeLessThan(arena.playerPosition.z);
    expect(Math.abs(arena.enemyAnchor.z - arena.playerPosition.z)).toBeCloseTo(6, 0);
    // Every brazier composition point carries a flame anchor (emissive-only
    // braziers still burn their VFX flame); more braziers than lights now.
    expect(arena.brazierAnchors.length).toBeGreaterThanOrEqual(6);
    for (const anchor of arena.brazierAnchors) {
      expect(anchor.children.length).toBe(0);
      expect(anchor.name).toMatch(/^brazier-anchor-\d+$/);
    }
    arena.dispose();
  });

  it('update() runs 120 frames; brazier intensities stay sane and vary', () => {
    const scene = new THREE.Scene();
    const arena = buildArena(scene);
    const samples: number[][] = arena.lights.braziers.map(() => []);
    let t = 0;
    for (let i = 0; i < 120; i++) {
      t += 0.016;
      expect(() => arena.update(0.016, t)).not.toThrow();
      arena.lights.braziers.forEach((light, li) => {
        expect(light.intensity).toBeGreaterThan(0);
        expect(light.intensity).toBeLessThan(60);
        samples[li]?.push(light.intensity);
      });
    }
    for (const series of samples) {
      const unique = new Set(series.map((v) => v.toFixed(5)));
      expect(unique.size).toBeGreaterThan(10);
    }
    arena.dispose();
  });

  it('dispose() empties the group and detaches from the scene without throwing', () => {
    const scene = new THREE.Scene();
    const arena = buildArena(scene);
    expect(() => arena.dispose()).not.toThrow();
    expect(arena.group.children.length).toBe(0);
    expect(scene.children).not.toContain(arena.group);
    // Disposing twice must not throw either.
    expect(() => arena.dispose()).not.toThrow();
  });
});
