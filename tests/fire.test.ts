// Headless fire system checks: no WebGL, no DOM. Pool behavior, budgets,
// O(1) update contract and shader source sanity only. Shader COMPILATION is
// not testable headless (no GL context); visual quality and compile are a
// HUMAN item via mountFireDebug in a browser.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  EmberEmitter,
  FireLightPool,
  FireSystem,
  FlameEmitter,
  SmokeEmitter,
} from '../src/vfx/fire';

const ORIGIN = new THREE.Vector3(0, 1, 0);

/** Snapshot the version counters of every instanced attribute. */
function attrVersions(geo: THREE.InstancedBufferGeometry): number[] {
  const names = ['aSpawn', 'aLifetime', 'aStart', 'aVelocity', 'aSize', 'aSeed'];
  return names.map((n) => {
    const attr = geo.getAttribute(n);
    return attr instanceof THREE.InstancedBufferAttribute ? attr.version : -1;
  });
}

describe('FlameEmitter', () => {
  it('respects the pool cap: spawning 10000 leaves live <= cap', () => {
    const e = new FlameEmitter(128);
    e.spawn({ position: ORIGIN, count: 10000, lifetime: 5 });
    expect(e.liveCount()).toBeLessThanOrEqual(128);
    expect(e.liveCount()).toBe(128);
    e.dispose();
  });

  it('reuses instances: expire everything, spawn again, no growth', () => {
    const e = new FlameEmitter(64);
    const geoBefore = e.geometry;
    const bufBefore = e.geometry.getAttribute('aStart');
    e.spawn({ position: ORIGIN, count: 40, lifetime: 0.5 });
    expect(e.liveCount()).toBe(40);
    e.update(1000); // far past every lifetime
    expect(e.liveCount()).toBe(0);
    e.spawn({ position: ORIGIN, count: 40, lifetime: 0.5 });
    expect(e.liveCount()).toBe(40);
    // Same geometry, same buffer object, same length: the pool never grows.
    expect(e.geometry).toBe(geoBefore);
    expect(e.geometry.getAttribute('aStart')).toBe(bufBefore);
    e.dispose();
  });

  it('update(dt) is O(1): quiet frames never touch attribute buffers', () => {
    // The O(1) contract is pinned via THREE's attribute version counters:
    // version only increments when needsUpdate is set, which only happens in
    // spawn(). If update() ever wrote per-instance data, versions would move.
    const e = new FlameEmitter(256);
    e.spawn({ position: ORIGIN, count: 100 });
    const before = attrVersions(e.geometry);
    for (let i = 0; i < 500; i++) e.update(1 / 60);
    expect(attrVersions(e.geometry)).toEqual(before);
    // And spawning DOES bump versions (the counter is a real signal).
    e.spawn({ position: ORIGIN, count: 1 });
    expect(attrVersions(e.geometry)).not.toEqual(before);
    e.dispose();
  });

  it('sizes attribute buffers to cap exactly', () => {
    const e = new FlameEmitter(3000);
    expect(e.capacity).toBe(3000);
    const expectSize = (name: string, itemSize: number): void => {
      const attr = e.geometry.getAttribute(name);
      expect(attr).toBeInstanceOf(THREE.InstancedBufferAttribute);
      expect(attr.array.length).toBe(3000 * itemSize);
      expect(attr.itemSize).toBe(itemSize);
    };
    expectSize('aSpawn', 1);
    expectSize('aLifetime', 1);
    expectSize('aStart', 3);
    expectSize('aVelocity', 3);
    expectSize('aSize', 1);
    expectSize('aSeed', 1);
    expect(e.geometry.instanceCount).toBe(3000);
    e.dispose();
  });

  it('particles expire on schedule (clock drives liveness)', () => {
    const e = new FlameEmitter(32);
    e.spawn({ position: ORIGIN, count: 10, lifetime: 1.0 });
    e.update(0.3);
    expect(e.liveCount()).toBe(10);
    e.update(2.0); // lifetimes jitter 0.75x..1.25x, 2.3s clears all of them
    expect(e.liveCount()).toBe(0);
    e.dispose();
  });
});

describe('EmberEmitter and SmokeEmitter', () => {
  it('EmberEmitter respects its cap and reuses instances', () => {
    const e = new EmberEmitter(96);
    e.spawn({ position: ORIGIN, count: 9999, lifetime: 10 });
    expect(e.liveCount()).toBe(96);
    e.update(1000);
    expect(e.liveCount()).toBe(0);
    e.spawn({ position: ORIGIN, count: 10 });
    expect(e.liveCount()).toBe(10);
    e.dispose();
  });

  it('SmokeEmitter respects its cap and reuses instances', () => {
    const e = new SmokeEmitter(48);
    e.spawn({ position: ORIGIN, count: 9999, lifetime: 10 });
    expect(e.liveCount()).toBe(48);
    e.update(1000);
    expect(e.liveCount()).toBe(0);
    e.spawn({ position: ORIGIN, count: 5 });
    expect(e.liveCount()).toBe(5);
    e.dispose();
  });

  it('emitters keep O(1) quiet updates too', () => {
    for (const e of [new EmberEmitter(64), new SmokeEmitter(32)]) {
      e.spawn({ position: ORIGIN, count: 20 });
      const before = attrVersions(e.geometry);
      for (let i = 0; i < 200; i++) e.update(1 / 60);
      expect(attrVersions(e.geometry)).toEqual(before);
      e.dispose();
    }
  });
});

describe('FireLightPool', () => {
  it('acquire N works, N+1th recycles the oldest handle (marks it dead)', () => {
    const parent = new THREE.Group();
    const pool = new FireLightPool(parent, 3);
    const h1 = pool.acquire(ORIGIN, 2, 5);
    const h2 = pool.acquire(ORIGIN, 2, 5);
    const h3 = pool.acquire(ORIGIN, 2, 5);
    expect(pool.activeCount()).toBe(3);
    expect(h1.alive && h2.alive && h3.alive).toBe(true);
    const h4 = pool.acquire(ORIGIN, 2, 5);
    expect(h1.alive).toBe(false); // oldest got recycled
    expect(h2.alive && h3.alive && h4.alive).toBe(true);
    expect(pool.activeCount()).toBe(3); // still only 3 lights
    pool.dispose();
  });

  it('release returns a light to the pool', () => {
    const parent = new THREE.Group();
    const pool = new FireLightPool(parent, 2);
    const h1 = pool.acquire(ORIGIN);
    const h2 = pool.acquire(ORIGIN);
    h1.release();
    expect(h1.alive).toBe(false);
    expect(pool.activeCount()).toBe(1);
    const h3 = pool.acquire(ORIGIN);
    expect(h3.alive).toBe(true);
    expect(h2.alive).toBe(true); // was not recycled, a free slot existed
    expect(pool.activeCount()).toBe(2);
    // Double release is a no-op.
    h1.release();
    expect(pool.activeCount()).toBe(2);
    pool.dispose();
  });

  it('all lights are warm-colored (r > g > b) point lights', () => {
    const parent = new THREE.Group();
    const pool = new FireLightPool(parent, 4);
    const lights: THREE.PointLight[] = [];
    parent.traverse((o) => {
      if (o instanceof THREE.PointLight) lights.push(o);
    });
    expect(lights.length).toBe(4);
    for (const l of lights) {
      expect(l.color.r).toBeGreaterThan(l.color.g);
      expect(l.color.g).toBeGreaterThan(l.color.b);
    }
    pool.dispose();
  });

  it('flicker keeps intensity positive and near base', () => {
    const parent = new THREE.Group();
    const pool = new FireLightPool(parent, 1);
    const h = pool.acquire(ORIGIN, 4, 6);
    let light: THREE.PointLight | null = null;
    parent.traverse((o) => {
      if (o instanceof THREE.PointLight) light = o;
    });
    expect(light).not.toBeNull();
    for (let i = 0; i < 120; i++) {
      h.flicker(1 / 60);
      const intensity = (light as unknown as THREE.PointLight).intensity;
      expect(intensity).toBeGreaterThan(0);
      expect(intensity).toBeLessThan(4 * 1.2);
    }
    pool.dispose();
  });
});

describe('FireSystem', () => {
  it('stats() total stays <= 6000 even under burst spam', () => {
    const parent = new THREE.Group();
    const fire = new FireSystem(parent);
    expect(fire.stats().capacity.total).toBeLessThanOrEqual(6000);
    const dir = new THREE.Vector3(0, 0, -1);
    for (let i = 0; i < 300; i++) {
      fire.spawnBurst(ORIGIN, dir, {
        flameCount: 500,
        emberCount: 500,
        smokeCount: 50,
        lifetime: 30,
      });
      const s = fire.stats();
      expect(s.total).toBeLessThanOrEqual(6000);
      expect(s.flames).toBeLessThanOrEqual(3000);
      expect(s.embers).toBeLessThanOrEqual(1500);
      expect(s.smoke).toBeLessThanOrEqual(200);
      fire.update(1 / 60);
    }
    fire.dispose();
  });

  it('attachAmbient registers and 300 update frames advance without throwing', () => {
    const parent = new THREE.Group();
    const fire = new FireSystem(parent);
    const anchor = new THREE.Object3D();
    anchor.position.set(1.5, 1.4, -3);
    parent.add(anchor);
    const handle = fire.attachAmbient(anchor, 1);
    expect(handle.anchor).toBe(anchor);
    for (let i = 0; i < 300; i++) fire.update(1 / 60);
    // Continuous spawning means live flames exist mid-run.
    const s = fire.stats();
    expect(s.flames).toBeGreaterThan(0);
    expect(s.embers).toBeGreaterThan(0);
    expect(s.total).toBeLessThanOrEqual(6000);
    // Detach stops new spawns; everything drains after lifetimes pass.
    handle.detach();
    fire.update(100);
    expect(fire.stats().total).toBe(0);
    fire.dispose();
  });

  it('burst lights auto-release after their duration', () => {
    const parent = new THREE.Group();
    const fire = new FireSystem(parent, { lightPoolSize: 2 });
    fire.spawnBurst(ORIGIN, new THREE.Vector3(0, 0, 1), { lightDuration: 0.2 });
    expect(fire.stats().lightsActive).toBe(1);
    for (let i = 0; i < 30; i++) fire.update(1 / 60); // 0.5s
    expect(fire.stats().lightsActive).toBe(0);
    fire.dispose();
  });

  it('dispose cleans up: geometries disposed, group emptied and detached', () => {
    const parent = new THREE.Group();
    const fire = new FireSystem(parent);
    let disposed = 0;
    const onDispose = (): void => {
      disposed++;
    };
    fire.flames.geometry.addEventListener('dispose', onDispose);
    fire.embers.geometry.addEventListener('dispose', onDispose);
    fire.smoke.geometry.addEventListener('dispose', onDispose);
    const group = fire.group;
    expect(parent.children).toContain(group);
    fire.dispose();
    expect(disposed).toBe(3);
    expect(group.children.length).toBe(0);
    expect(parent.children).not.toContain(group);
    fire.dispose(); // idempotent
  });

  it('default pool size is 2 to respect the 8-dynamic-light budget with the arena', () => {
    const parent = new THREE.Group();
    const fire = new FireSystem(parent);
    expect(fire.lights.size).toBe(2);
    fire.dispose();
  });
});

describe('shader source sanity (compile needs a browser, HUMAN item)', () => {
  it('flame shader: clock, spawn attributes, blackbody ramp, curl advection', () => {
    const e = new FlameEmitter(4);
    const vs = e.material.vertexShader;
    const fs = e.material.fragmentShader;
    for (const name of ['uTime', 'uBuoyancy', 'aSpawn', 'aLifetime', 'aStart', 'aVelocity', 'aSize', 'aSeed', 'aTemp']) {
      expect(vs).toContain(name);
    }
    expect(fs).toContain('uTime');
    expect(fs).toContain('fireValueNoise'); // 2-octave value noise
    // Physically-based color: blackbody ramp in the fragment, temperature
    // decay + temperature-proportional buoyancy + curl advection in the vertex.
    expect(fs).toContain('fbBlackbody');
    expect(vs).toContain('fbCurlOffset');
    expect(vs).toContain('uBuoyancy * aTemp');
    expect(vs).toContain('uCool');
    // Additive accumulation via custom premultiplied blending (ONE, ONE) so
    // the half-res fire target's alpha channel stays smoke-only.
    expect(e.material.blending).toBe(THREE.CustomBlending);
    expect(e.material.blendSrc).toBe(THREE.OneFactor);
    expect(e.material.blendDst).toBe(THREE.OneFactor);
    expect(e.material.depthWrite).toBe(false);
    expect(e.material.transparent).toBe(true);
    e.dispose();
  });

  it('ember shader: curl turbulence, temperature buoyancy, floor landing', () => {
    const e = new EmberEmitter(4);
    const vs = e.material.vertexShader;
    expect(vs).toContain('uCurl');
    expect(vs).toContain('uBuoyancy');
    expect(vs).toContain('fbCurlOffset');
    // Closed-form floor landing: quadratic root for the touch-down time.
    expect(vs).toContain('uFloorY');
    expect(vs).toContain('sqrt(disc)');
    expect(e.material.fragmentShader).toContain('fbBlackbody');
    expect(e.material.blending).toBe(THREE.CustomBlending);
    expect(e.material.blendSrc).toBe(THREE.OneFactor);
    expect(e.material.blendDst).toBe(THREE.OneFactor);
    expect(e.material.depthWrite).toBe(false);
    e.dispose();
  });

  it('smoke shader: premultiplied alpha, low opacity, headless-safe, fire tint', () => {
    const e = new SmokeEmitter(4);
    // Premultiplied normal blending (ONE, ONE_MINUS_SRC_ALPHA): required by
    // the off-screen fire target composite, identical on-screen result.
    expect(e.material.blending).toBe(THREE.CustomBlending);
    expect(e.material.blendSrc).toBe(THREE.OneFactor);
    expect(e.material.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    expect(e.material.depthWrite).toBe(false);
    const uOpacity = e.material.uniforms['uOpacity'];
    expect(uOpacity?.value).toBeCloseTo(0.12);
    // Headless node has no document: the canvas texture path must fall back.
    const uUseMap = e.material.uniforms['uUseMap'];
    expect(uUseMap?.value).toBe(0);
    expect(e.material.fragmentShader).toContain('uUseMap');
    // Fire-light tint (aTemp reused as tint) and turbulent dissipation.
    expect(e.material.fragmentShader).toContain('vTemp');
    expect(e.material.fragmentShader).toContain('erode');
    e.dispose();
  });

  it('all emitters carry soft-particle uniforms, disabled by default', () => {
    const parent = new THREE.Group();
    const fire = new FireSystem(parent);
    for (const emitter of [fire.flames, fire.embers, fire.smoke]) {
      const u = emitter.material.uniforms;
      expect(u['uSoftEnabled']?.value).toBe(0);
      expect(u['uSceneDepth']?.value).toBeNull();
      expect(emitter.material.fragmentShader).toContain('fbSoftFade');
    }
    fire.dispose();
  });
});

describe('temperature attribute (blackbody physics)', () => {
  it('spawn writes clamped normalized temperatures into aTemp', () => {
    const e = new FlameEmitter(32);
    e.spawn({ position: ORIGIN, count: 16, temperature: 0.9 });
    const arr = e.geometry.getAttribute('aTemp').array as Float32Array;
    for (let i = 0; i < 16; i++) {
      const t = arr[i]!;
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(1);
      // Emitter jitter is 0.22 wide around the requested 0.9.
      expect(t).toBeGreaterThanOrEqual(0.9 - 0.12);
    }
    // Out-of-range requests clamp instead of leaking bad values to the ramp.
    e.spawn({ position: ORIGIN, count: 4, temperature: 99 });
    e.spawn({ position: ORIGIN, count: 4, temperature: -5 });
    for (let i = 16; i < 24; i++) {
      expect(arr[i]).toBeGreaterThan(0);
      expect(arr[i]).toBeLessThanOrEqual(1);
    }
    e.dispose();
  });

  it('ember temperatures vary widely (population: risers and sinkers)', () => {
    const e = new EmberEmitter(256);
    e.spawn({ position: ORIGIN, count: 256 });
    const arr = e.geometry.getAttribute('aTemp').array as Float32Array;
    let below = 0;
    let above = 0;
    for (let i = 0; i < 256; i++) {
      // 0.5 is the buoyancy-neutral point in the ember vertex shader.
      if (arr[i]! < 0.5) below++;
      else above++;
    }
    expect(below).toBeGreaterThan(20); // some embers sink and can land
    expect(above).toBeGreaterThan(20); // most still rise
    e.dispose();
  });
});

describe('sub-frame segment emission', () => {
  it('positionEnd distributes spawn positions along the segment', () => {
    const e = new FlameEmitter(64);
    const a = new THREE.Vector3(0, 1, 0);
    const b = new THREE.Vector3(10, 1, 0);
    e.spawn({ position: a, positionEnd: b, count: 20, spread: 0 });
    const arr = e.geometry.getAttribute('aStart').array as Float32Array;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 20; i++) {
      const x = arr[i * 3]!;
      min = Math.min(min, x);
      max = Math.max(max, x);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(10);
    }
    // The ribbon spans the segment, not a bead at either end.
    expect(min).toBeLessThan(1);
    expect(max).toBeGreaterThan(9);
    e.dispose();
  });

  it('timeSpread back-dates spawns across the segment (never future)', () => {
    const e = new FlameEmitter(64);
    e.update(2); // clock = 2
    e.spawn({
      position: new THREE.Vector3(0, 1, 0),
      positionEnd: new THREE.Vector3(1, 1, 0),
      timeSpread: 0.05,
      count: 10,
    });
    const spawn = e.geometry.getAttribute('aSpawn').array as Float32Array;
    for (let i = 0; i < 10; i++) {
      expect(spawn[i]).toBeLessThanOrEqual(2);
      expect(spawn[i]).toBeGreaterThanOrEqual(2 - 0.05 - 1e-6);
    }
    e.dispose();
  });
});

describe('spawn activity EMA (smoke tint + light coupling source)', () => {
  it('rises on spawn frames, decays over quiet frames, O(1) to read', () => {
    const e = new FlameEmitter(128);
    expect(e.activity).toBe(0);
    e.spawn({ position: ORIGIN, count: 30 });
    e.update(1 / 60);
    const active = e.activity;
    expect(active).toBeGreaterThan(20);
    for (let i = 0; i < 240; i++) e.update(1 / 60); // 4 s quiet
    expect(e.activity).toBeLessThan(active * 0.01);
    e.dispose();
  });
});

describe('light flicker from live particle count (not sine)', () => {
  it('pool.update(dt, flameLive) drives intensity from density, stays positive', () => {
    const parent = new THREE.Group();
    const pool = new FireLightPool(parent, 1);
    const h = pool.acquire(ORIGIN, 4, 6);
    let light: THREE.PointLight | null = null;
    parent.traverse((o) => {
      if (o instanceof THREE.PointLight) light = o;
    });
    expect(light).not.toBeNull();
    const l = light as unknown as THREE.PointLight;
    // Dense fire: intensity settles near base with count-hash jitter.
    for (let i = 0; i < 120; i++) pool.update(1 / 60, 600 + (i % 7));
    const dense = l.intensity;
    expect(dense).toBeGreaterThan(4 * 0.5);
    expect(dense).toBeLessThan(4 * 1.3);
    // Starved fire: the light dims toward the floor, never negative.
    for (let i = 0; i < 120; i++) pool.update(1 / 60, 0);
    const starved = l.intensity;
    expect(starved).toBeGreaterThan(0);
    expect(starved).toBeLessThan(dense);
    expect(h.alive).toBe(true);
    pool.dispose();
  });

  it('FireSystem.update feeds the live count through (integration)', () => {
    const parent = new THREE.Group();
    const fire = new FireSystem(parent, { lightPoolSize: 2 });
    const handle = fire.lights.acquire(ORIGIN, 4, 6);
    fire.flames.spawn({ position: ORIGIN, count: 400, lifetime: 5 });
    for (let i = 0; i < 60; i++) fire.update(1 / 60);
    let intensity = 0;
    fire.group.traverse((o) => {
      if (o instanceof THREE.PointLight && o.visible) intensity = o.intensity;
    });
    expect(intensity).toBeGreaterThan(0);
    handle.release();
    fire.dispose();
  });
});

describe('post-pipeline hooks (soft particles + half-res fire pass)', () => {
  it('configureFirePass binds and unbinds depth uniforms on all emitters', () => {
    const parent = new THREE.Group();
    const fire = new FireSystem(parent);
    const depth = new THREE.DepthTexture(64, 64);
    fire.configureFirePass(depth, 0.1, 100, 640, 360);
    for (const emitter of [fire.flames, fire.embers, fire.smoke]) {
      const u = emitter.material.uniforms;
      expect(u['uSoftEnabled']?.value).toBe(1);
      expect(u['uSceneDepth']?.value).toBe(depth);
      expect((u['uFireRes']?.value as THREE.Vector2).x).toBe(640);
    }
    fire.configureFirePass(null, 0.1, 100, 1, 1);
    for (const emitter of [fire.flames, fire.embers, fire.smoke]) {
      expect(emitter.material.uniforms['uSoftEnabled']?.value).toBe(0);
    }
    depth.dispose();
    fire.dispose();
  });

  it('setFireLayer moves particle meshes onto the pass layer and back', () => {
    const parent = new THREE.Group();
    const fire = new FireSystem(parent);
    const defaultMask = fire.flames.mesh.layers.mask;
    fire.setFireLayer(1);
    for (const emitter of [fire.flames, fire.embers, fire.smoke]) {
      expect(emitter.mesh.layers.mask).toBe(1 << 1);
    }
    fire.setFireLayer(null);
    expect(fire.flames.mesh.layers.mask).toBe(defaultMask);
    fire.dispose();
  });
});
