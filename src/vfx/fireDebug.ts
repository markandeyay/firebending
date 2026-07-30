// Standalone visual harness for the core fire system. Not part of the game
// flow; mount it from a scratch page to judge flame quality by eye:
//
//   import { mountFireDebug } from './vfx/fireDebug';
//   const unmount = mountFireDebug(document.body);
//
// Shows: one continuous brazier-style ambient flame, a burst fired along +z
// every 2 seconds, ambient drifting embers, and a HUD with fps plus live
// particle counts. Returns an unmount function.

import * as THREE from 'three';
import { configureRenderer } from '../game/renderer';
import { FireSystem } from './fire';

const CHARCOAL = 0x14100d;

export function mountFireDebug(container: HTMLElement): () => void {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth || 960, container.clientHeight || 540);
  configureRenderer(renderer);
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(CHARCOAL);

  const camera = new THREE.PerspectiveCamera(
    55,
    (container.clientWidth || 960) / (container.clientHeight || 540),
    0.1,
    60,
  );
  camera.position.set(0, 1.7, 4.4);
  camera.lookAt(0, 1.1, 0);

  // Dark ground plane so the pooled fire lights have something to tint.
  const planeGeo = new THREE.PlaneGeometry(30, 30);
  const planeMat = new THREE.MeshStandardMaterial({
    color: 0x211a14,
    roughness: 0.95,
    metalness: 0.0,
  });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI / 2;
  scene.add(plane);

  // A faint pedestal marks the brazier anchor.
  const pedGeo = new THREE.CylinderGeometry(0.32, 0.4, 0.9, 8);
  const pedMat = new THREE.MeshStandardMaterial({
    color: 0x3a322b,
    roughness: 0.9,
    flatShading: true,
  });
  const pedestal = new THREE.Mesh(pedGeo, pedMat);
  pedestal.position.set(0, 0.45, 0);
  scene.add(pedestal);

  const ambientLight = new THREE.AmbientLight(0x2a1a10, 0.7);
  scene.add(ambientLight);

  // Fire system with a brazier-like continuous flame at the pedestal top.
  const fire = new FireSystem(scene);
  const anchor = new THREE.Group();
  anchor.name = 'debug-brazier-anchor';
  anchor.position.set(0, 1.0, 0);
  scene.add(anchor);
  fire.attachAmbient(anchor, 1);

  // HUD
  const hud = document.createElement('div');
  hud.style.cssText = [
    'position:absolute',
    'top:8px',
    'left:8px',
    'padding:6px 10px',
    'font:12px/1.5 monospace',
    'color:#d8c8a8',
    'background:rgba(20,16,13,0.75)',
    'border:1px solid #6b1f15',
    'pointer-events:none',
    'white-space:pre',
  ].join(';');
  const prevPosition = container.style.position;
  if (!prevPosition || prevPosition === 'static') container.style.position = 'relative';
  container.appendChild(hud);

  const onResize = (): void => {
    const w = container.clientWidth || 960;
    const h = container.clientHeight || 540;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);

  const clock = new THREE.Clock();
  let raf = 0;
  let burstTimer = 0;
  let emberTimer = 0;
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;
  const burstPos = new THREE.Vector3();
  const burstDir = new THREE.Vector3(0, 0, 1);

  const frame = (): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.1);

    // A burst every 2 seconds fired along +z (toward the camera side).
    burstTimer += dt;
    if (burstTimer >= 2) {
      burstTimer = 0;
      burstPos.set(-1.4, 1.3, -1.5);
      fire.spawnBurst(burstPos, burstDir, {
        flameCount: 26,
        emberCount: 18,
        speed: 5,
        size: 0.5,
        lightIntensity: 5,
      });
    }

    // Sparse ember ambience drifting up around the whole stage.
    emberTimer += dt;
    if (emberTimer >= 0.25) {
      emberTimer = 0;
      burstPos.set((Math.random() - 0.5) * 6, 0.15, (Math.random() - 0.5) * 5);
      fire.embers.spawn({
        position: burstPos,
        velocity: new THREE.Vector3(0, 0.5, 0),
        lifetime: 3.5,
        count: 2,
        spread: 0.4,
      });
    }

    fire.update(dt);
    renderer.render(scene, camera);

    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum >= 0.5) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
      const s = fire.stats();
      hud.textContent =
        `fps      ${fps}\n` +
        `flames   ${s.flames} / ${s.capacity.flames}\n` +
        `embers   ${s.embers} / ${s.capacity.embers}\n` +
        `smoke    ${s.smoke} / ${s.capacity.smoke}\n` +
        `total    ${s.total} / 6000\n` +
        `lights   ${s.lightsActive} / ${fire.lights.size}`;
    }
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    fire.dispose();
    planeGeo.dispose();
    planeMat.dispose();
    pedGeo.dispose();
    pedMat.dispose();
    renderer.dispose();
    container.removeChild(renderer.domElement);
    container.removeChild(hud);
    container.style.position = prevPosition;
  };
}
