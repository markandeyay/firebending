// Self-contained visual verification harness for the arena. Not wired into
// the game; the orchestrator can mount it behind a URL param, e.g.:
//   import { mountArenaDebug } from './game/arenaDebug';
//   if (new URLSearchParams(location.search).has('arena')) {
//     mountArenaDebug(document.body);
//   }

import * as THREE from 'three';
import { buildArena } from './arena';

/**
 * Mounts a standalone renderer showing the arena with a slow authored
 * auto-pan (no orbit controls) and a small FPS / draw-call HUD.
 * Returns an unmount function.
 */
export function mountArenaDebug(container: HTMLElement): () => void {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    58,
    (container.clientWidth || window.innerWidth) / (container.clientHeight || window.innerHeight),
    0.1,
    80,
  );

  const arena = buildArena(scene);

  // HUD
  const hud = document.createElement('div');
  hud.style.cssText = [
    'position:absolute',
    'top:8px',
    'left:8px',
    'padding:6px 10px',
    'font:12px/1.5 monospace',
    'color:#d8c8a8',
    'background:rgba(26,21,18,0.75)',
    'border:1px solid #6b1f15',
    'pointer-events:none',
    'white-space:pre',
    'z-index:10',
  ].join(';');
  hud.textContent = 'warming up';
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }
  container.appendChild(hud);

  const onResize = (): void => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  let raf = 0;
  let last = performance.now();
  let elapsed = 0;
  let fpsEma = 60;
  let hudTimer = 0;
  const lookTarget = new THREE.Vector3();

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    elapsed += dt;

    arena.update(dt, elapsed);

    // Slow authored pan: drift down the lane and back, gentle lateral sway.
    const glide = 0.5 + 0.5 * Math.sin(elapsed * 0.07);
    camera.position.set(
      Math.sin(elapsed * 0.12) * 2.6,
      2.1 + Math.sin(elapsed * 0.09) * 0.35,
      2.2 - glide * 9,
    );
    lookTarget.set(0, 1.6, camera.position.z - 9);
    camera.lookAt(lookTarget);

    renderer.render(scene, camera);

    if (dt > 0) fpsEma = fpsEma * 0.95 + (1 / dt) * 0.05;
    hudTimer += dt;
    if (hudTimer > 0.25) {
      hudTimer = 0;
      const info = renderer.info.render;
      hud.textContent =
        `fps   ${fpsEma.toFixed(1)}\n` +
        `calls ${info.calls}\n` +
        `tris  ${info.triangles}\n` +
        `frame ${info.frame}`;
    }
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    arena.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    hud.remove();
  };
}
