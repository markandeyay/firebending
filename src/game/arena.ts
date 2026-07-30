// Arena environment: the ember hall. A long lacquered training lane flanked by
// oxblood columns, cloth banners, braziers and paper lanterns, closed off by a
// low glowing coal wall behind the enemy end. All geometry is procedural.
// Palette (Section 9): charcoal #1a1512, oxblood #6b1f15, vermilion #8a2f1d,
// muted gold #a8853c, parchment #d8c8a8, tatami #b09a6a. Fire is the only
// saturation. No blue anywhere.

import * as THREE from 'three';

export interface ArenaLights {
  /** Warm key light shining from the coal wall toward the player. */
  key: THREE.DirectionalLight;
  /** Deep warm ambient floor level. */
  ambient: THREE.AmbientLight;
  /** Flickering brazier point lights. */
  braziers: THREE.PointLight[];
}

export interface Arena {
  group: THREE.Group;
  /** Where the player stands (one end of the lane). */
  playerPosition: THREE.Vector3;
  /** Where the first construct waits, ~6m down the lane. */
  enemyAnchor: THREE.Vector3;
  /** Reserved for the camera rig agent; not populated here. */
  travelSpline?: THREE.CatmullRomCurve3;
  lights: ArenaLights;
  /** Empty groups named "brazier-anchor-N", one per brazier bowl, for flame VFX. */
  brazierAnchors: THREE.Group[];
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const CHARCOAL = 0x1a1512;
const OXBLOOD = 0x6b1f15;
const VERMILION = 0x8a2f1d;
const GOLD = 0xa8853c;
const PARCHMENT = 0xd8c8a8;
const TATAMI = 0xb09a6a;
const STONE = 0x3a322b;
const FOG_TONE = 0x211510;
const EMBER_ORANGE = 0xe8551c;
const FIRELIGHT = 0xff8a3c;

// Lane geometry. Player stands near z = 0, the lane runs toward negative z.
const LANE_LENGTH = 20;
const COLUMN_X = 3.4;
const COLUMNS_PER_SIDE = 9;
const COLUMN_HEIGHT = 4.6;

// ---------------------------------------------------------------------------
// Deterministic pseudo-random (keeps tests and layout stable)
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
// Canvas texture helpers (return null in headless node, callers fall back to
// flat colors so the module stays testable without a DOM)
// ---------------------------------------------------------------------------

function make2d(size: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas.getContext('2d');
}

/** Subtle woven tatami pattern: tan base, faint darker seams and weave lines. */
function makeTatamiTexture(): THREE.Texture | null {
  const ctx = make2d(256);
  if (!ctx) return null;
  ctx.fillStyle = '#b09a6a';
  ctx.fillRect(0, 0, 256, 256);
  // Faint weave: alternating horizontal / vertical hatch blocks.
  const block = 64;
  for (let by = 0; by < 4; by++) {
    for (let bx = 0; bx < 4; bx++) {
      const horizontal = (bx + by) % 2 === 0;
      ctx.strokeStyle = 'rgba(90, 74, 46, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 4; i < block; i += 6) {
        if (horizontal) {
          ctx.moveTo(bx * block, by * block + i);
          ctx.lineTo(bx * block + block, by * block + i);
        } else {
          ctx.moveTo(bx * block + i, by * block);
          ctx.lineTo(bx * block + i, by * block + block);
        }
      }
      ctx.stroke();
    }
  }
  // Mat seams.
  ctx.strokeStyle = 'rgba(58, 44, 24, 0.4)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 256; i += block) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(7, 9);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft warm radial gradient used for the layered haze planes. */
function makeHazeTexture(): THREE.Texture | null {
  const ctx = make2d(128);
  if (!ctx) return null;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(255, 150, 70, 0.55)');
  g.addColorStop(0.5, 'rgba(200, 100, 40, 0.22)');
  g.addColorStop(1, 'rgba(120, 60, 20, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Banner material: deep red cloth with one abstract gold band, vertex sway.
// ---------------------------------------------------------------------------

interface BannerMaterialBundle {
  material: THREE.ShaderMaterial;
  uTime: THREE.IUniform<number>;
}

function makeBannerMaterial(): BannerMaterialBundle {
  const uTime: THREE.IUniform<number> = { value: 0 };
  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib['fog']),
    uTime,
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec3 p = position;
        // Top edge (uv.y = 1) is pinned, the free hem sways the most.
        float weight = 1.0 - uv.y;
        float phase = modelMatrix[3][0] * 1.7 + modelMatrix[3][2] * 0.9;
        p.x += sin(uTime * 1.4 + phase + uv.y * 2.4) * 0.085 * weight;
        p.z += cos(uTime * 1.1 + phase * 1.3 + uv.y * 1.9) * 0.05 * weight;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      #include <fog_pars_fragment>
      void main() {
        // Deep banner red, slightly darker toward the hem.
        vec3 col = vec3(0.337, 0.086, 0.063);
        // Single abstract geometric gold band near the hem. No lettering.
        float band = step(0.14, vUv.y) - step(0.26, vUv.y);
        col = mix(col, vec3(0.659, 0.522, 0.235), clamp(band, 0.0, 1.0));
        col *= 0.72 + 0.28 * vUv.y;
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }
    `,
  });
  return { material, uTime };
}

// ---------------------------------------------------------------------------
// buildArena
// ---------------------------------------------------------------------------

export function buildArena(scene: THREE.Scene): Arena {
  const rng = mulberry32(0x51ee7);
  const group = new THREE.Group();
  group.name = 'arena';

  const previousFog = scene.fog;
  const previousBackground = scene.background;
  scene.fog = new THREE.FogExp2(FOG_TONE, 0.042);
  scene.background = new THREE.Color(CHARCOAL);

  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };
  const dummy = new THREE.Object3D();

  // --- Floor: tatami lane over a charcoal void -----------------------------
  const tatamiTex = makeTatamiTexture();
  if (tatamiTex) track(tatamiTex);
  const floorMat = track(
    new THREE.MeshStandardMaterial({
      color: TATAMI,
      map: tatamiTex ?? null,
      roughness: 1.0,
      metalness: 0.0,
    }),
  );
  const floorGeo = track(new THREE.PlaneGeometry(24, 32));
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.name = 'tatami-floor';
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -(LANE_LENGTH / 2) + 2);
  floor.receiveShadow = true;
  group.add(floor);

  // --- Shared wood / gold / stone materials --------------------------------
  const woodMat = track(
    new THREE.MeshStandardMaterial({
      color: OXBLOOD,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true,
    }),
  );
  const trimMat = track(
    new THREE.MeshStandardMaterial({
      color: GOLD,
      roughness: 0.5,
      metalness: 0.55,
      flatShading: true,
    }),
  );
  const stoneMat = track(
    new THREE.MeshStandardMaterial({
      color: STONE,
      roughness: 0.95,
      metalness: 0.0,
      flatShading: true,
    }),
  );

  // --- Columns (instanced): oxblood shafts, gold caps, stone bases ---------
  const columnCount = COLUMNS_PER_SIDE * 2;
  const shaftGeo = track(new THREE.CylinderGeometry(0.26, 0.32, COLUMN_HEIGHT, 10));
  const capGeo = track(new THREE.BoxGeometry(0.88, 0.22, 0.88));
  const baseGeo = track(new THREE.BoxGeometry(0.94, 0.3, 0.94));

  const shafts = new THREE.InstancedMesh(shaftGeo, woodMat, columnCount);
  shafts.name = 'columns';
  const caps = new THREE.InstancedMesh(capGeo, trimMat, columnCount);
  caps.name = 'column-caps';
  const bases = new THREE.InstancedMesh(baseGeo, stoneMat, columnCount);
  bases.name = 'column-bases';
  shafts.castShadow = true;
  shafts.receiveShadow = true;
  caps.castShadow = true;

  const columnZs: number[] = [];
  for (let i = 0; i < COLUMNS_PER_SIDE; i++) {
    columnZs.push(0.8 - i * (LANE_LENGTH + 1.6) / (COLUMNS_PER_SIDE - 1));
  }
  let ci = 0;
  for (const z of columnZs) {
    for (const side of [-1, 1]) {
      const x = side * COLUMN_X;
      dummy.position.set(x, COLUMN_HEIGHT / 2, z);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      shafts.setMatrixAt(ci, dummy.matrix);
      dummy.position.set(x, COLUMN_HEIGHT + 0.11, z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      caps.setMatrixAt(ci, dummy.matrix);
      dummy.position.set(x, 0.15, z);
      dummy.updateMatrix();
      bases.setMatrixAt(ci, dummy.matrix);
      ci++;
    }
  }
  group.add(shafts, caps, bases);

  // Long vermilion lintel beams running along each column row.
  const lintelMat = track(
    new THREE.MeshStandardMaterial({
      color: VERMILION,
      roughness: 0.8,
      metalness: 0.05,
      flatShading: true,
    }),
  );
  const firstZ = columnZs[0] ?? 0.8;
  const lastZ = columnZs[columnZs.length - 1] ?? -20.8;
  const lintelGeo = track(new THREE.BoxGeometry(0.4, 0.3, Math.abs(lastZ - firstZ) + 1.2));
  for (const side of [-1, 1]) {
    const lintel = new THREE.Mesh(lintelGeo, lintelMat);
    lintel.name = `lintel-${side < 0 ? 'l' : 'r'}`;
    lintel.position.set(side * COLUMN_X, COLUMN_HEIGHT + 0.37, (firstZ + lastZ) / 2);
    group.add(lintel);
  }

  // --- Banners between some columns (vertex sway ShaderMaterial) -----------
  const bannerBundle = makeBannerMaterial();
  track(bannerBundle.material);
  const bannerGeo = track(new THREE.PlaneGeometry(1.5, 2.3, 6, 12));
  bannerGeo.translate(0, -1.15, 0); // pin the top edge at the mesh origin
  const bannerSlots: Array<[number, number]> = [
    [-1, 1], // [side, gap index between column i and i+1]
    [1, 2],
    [-1, 4],
    [1, 5],
    [-1, 7],
  ];
  for (const [side, gap] of bannerSlots) {
    const za = columnZs[gap];
    const zb = columnZs[gap + 1];
    if (za === undefined || zb === undefined) continue;
    const banner = new THREE.Mesh(bannerGeo, bannerBundle.material);
    banner.name = `banner-${side < 0 ? 'l' : 'r'}-${gap}`;
    banner.position.set(side * (COLUMN_X - 0.1), 4.15, (za + zb) / 2);
    banner.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    group.add(banner);
  }

  // --- Braziers with flickering point lights -------------------------------
  const brazierSpots: Array<[number, number]> = [
    [-2.6, -2.8],
    [2.6, -6.8],
    [-2.6, -10.8],
    [2.6, -14.8],
  ];
  const pedestalGeo = track(new THREE.CylinderGeometry(0.3, 0.42, 1.0, 8));
  const bowlGeo = track(new THREE.CylinderGeometry(0.55, 0.3, 0.36, 8));
  const pedestals = new THREE.InstancedMesh(pedestalGeo, stoneMat, brazierSpots.length);
  pedestals.name = 'brazier-pedestals';
  const bowls = new THREE.InstancedMesh(bowlGeo, stoneMat, brazierSpots.length);
  bowls.name = 'brazier-bowls';
  pedestals.castShadow = true;

  const brazierLights: THREE.PointLight[] = [];
  const brazierAnchors: THREE.Group[] = [];
  const brazierPhases: number[] = [];
  brazierSpots.forEach(([x, z], i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(1);
    dummy.position.set(x, 0.5, z);
    dummy.updateMatrix();
    pedestals.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x, 1.18, z);
    dummy.updateMatrix();
    bowls.setMatrixAt(i, dummy.matrix);

    const light = new THREE.PointLight(FIRELIGHT, 2.4, 7.5, 2);
    light.name = `brazier-light-${i}`;
    light.position.set(x, 1.75, z);
    group.add(light);
    brazierLights.push(light);
    brazierPhases.push(rng() * Math.PI * 2);

    // Empty anchor for the vfx agent's flames.
    const anchor = new THREE.Group();
    anchor.name = `brazier-anchor-${i}`;
    anchor.position.set(x, 1.4, z);
    group.add(anchor);
    brazierAnchors.push(anchor);
  });
  group.add(pedestals, bowls);

  // --- Paper lanterns (instanced, unlit warm emissive) ---------------------
  const lanternCount = 10;
  const lanternGeo = track(new THREE.SphereGeometry(0.21, 8, 6));
  const lanternMat = track(
    new THREE.MeshStandardMaterial({
      color: PARCHMENT,
      emissive: 0xd8863a,
      emissiveIntensity: 0.85,
      roughness: 0.9,
      flatShading: true,
    }),
  );
  const lanterns = new THREE.InstancedMesh(lanternGeo, lanternMat, lanternCount);
  lanterns.name = 'lanterns';
  for (let i = 0; i < lanternCount; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * (1.9 + rng() * 1.1);
    const z = 0.4 - (i / lanternCount) * (LANE_LENGTH + 1);
    const y = 2.5 + rng() * 1.4;
    dummy.position.set(x, y, z + (rng() - 0.5) * 0.8);
    dummy.rotation.set(0, rng() * Math.PI, 0);
    const s = 0.85 + rng() * 0.4;
    dummy.scale.set(s, s * 1.3, s);
    dummy.updateMatrix();
    lanterns.setMatrixAt(i, dummy.matrix);
  }
  group.add(lanterns);

  // --- Coal wall behind the enemy end (emissive, the key light source) -----
  const coalCount = 48;
  const coalGeo = track(new THREE.DodecahedronGeometry(0.3, 0));
  const coalMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x241109,
      emissive: EMBER_ORANGE,
      emissiveIntensity: 1.5,
      roughness: 0.8,
      flatShading: true,
    }),
  );
  const coals = new THREE.InstancedMesh(coalGeo, coalMat, coalCount);
  coals.name = 'coal-wall';
  const coalRows = 3;
  const coalCols = coalCount / coalRows;
  for (let i = 0; i < coalCount; i++) {
    const row = Math.floor(i / coalCols);
    const col = i % coalCols;
    const x = -4.2 + (col / (coalCols - 1)) * 8.4 + (rng() - 0.5) * 0.3;
    const y = 0.25 + row * 0.38 + (rng() - 0.5) * 0.12;
    const z = -21.6 + (rng() - 0.5) * 0.6;
    dummy.position.set(x, y, z);
    dummy.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    const s = 0.7 + rng() * 0.7;
    dummy.scale.set(s, s * (0.8 + rng() * 0.4), s);
    dummy.updateMatrix();
    coals.setMatrixAt(i, dummy.matrix);
  }
  group.add(coals);

  // --- Layered haze planes (cheap warm fog volume feel) --------------------
  const hazeTex = makeHazeTexture();
  if (hazeTex) track(hazeTex);
  const hazeGeo = track(new THREE.PlaneGeometry(15, 8));
  const hazeMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xb06a30,
      map: hazeTex ?? null,
      transparent: true,
      opacity: hazeTex ? 0.09 : 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  const hazePlanes: THREE.Mesh[] = [];
  for (const z of [-5, -11, -17]) {
    const haze = new THREE.Mesh(hazeGeo, hazeMat);
    haze.name = `haze-${-z}`;
    haze.position.set(0, 2.6, z);
    haze.renderOrder = 10;
    group.add(haze);
    hazePlanes.push(haze);
  }

  // --- Lighting ------------------------------------------------------------
  // One warm key from the coal wall direction, the single shadow caster.
  const key = new THREE.DirectionalLight(FIRELIGHT, 1.6);
  key.name = 'coal-wall-key';
  key.position.set(0, 4.5, -22.5);
  key.target.position.set(0, 1.0, -2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 34;
  key.shadow.camera.left = -7;
  key.shadow.camera.right = 7;
  key.shadow.camera.top = 7;
  key.shadow.camera.bottom = -3;
  key.shadow.radius = 4;
  key.shadow.bias = -0.0015;
  group.add(key, key.target);

  const ambient = new THREE.AmbientLight(0x3a2418, 0.55);
  ambient.name = 'ember-ambient';
  group.add(ambient);

  scene.add(group);

  // --- Runtime -------------------------------------------------------------
  let bannerTime = 0;
  const keyBase = key.intensity;

  const update = (dt: number, elapsed: number): void => {
    bannerTime += dt;
    bannerBundle.uTime.value = bannerTime;

    // Layered sine flicker per brazier: subtle, always positive.
    for (let i = 0; i < brazierLights.length; i++) {
      const light = brazierLights[i];
      const phase = brazierPhases[i];
      if (light === undefined || phase === undefined) continue;
      const n =
        0.82 +
        0.13 * Math.sin(elapsed * 9.7 + phase) +
        0.08 * Math.sin(elapsed * 23.3 + phase * 1.7) +
        0.05 * Math.sin(elapsed * 41.1 + phase * 0.6);
      light.intensity = 2.4 * n;
    }

    // The coal wall breathes very slowly.
    key.intensity = keyBase * (1 + 0.05 * Math.sin(elapsed * 1.7));

    // Haze drifts almost imperceptibly.
    for (let i = 0; i < hazePlanes.length; i++) {
      const haze = hazePlanes[i];
      if (haze === undefined) continue;
      haze.position.x = Math.sin(elapsed * 0.11 + i * 2.1) * 0.35;
    }
  };

  const dispose = (): void => {
    scene.remove(group);
    for (const d of disposables) d.dispose();
    key.shadow.dispose();
    group.clear();
    if (scene.fog instanceof THREE.FogExp2 && scene.fog.color.getHex() === FOG_TONE) {
      scene.fog = previousFog;
    }
    if (
      scene.background instanceof THREE.Color &&
      scene.background.getHex() === CHARCOAL
    ) {
      scene.background = previousBackground;
    }
  };

  return {
    group,
    playerPosition: new THREE.Vector3(0, 1.5, 0),
    enemyAnchor: new THREE.Vector3(0, 1.1, -6),
    lights: { key, ambient, braziers: brazierLights },
    brazierAnchors,
    update,
    dispose,
  };
}
