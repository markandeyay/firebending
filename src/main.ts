import * as THREE from 'three';
import { mountTrackingDebug } from './screens/trackingDebug';

/**
 * Boot and screen state machine. URL params are parsed once here; debug
 * screens take over the whole #app root. Otherwise the Phase 0 placeholder
 * scene boots (screens replace it in later phases).
 */

export type ScreenName = 'title' | 'calibration' | 'arena';

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app root');

const params = new URLSearchParams(window.location.search);

if (params.get('debug') === 'tracking') {
  void mountTrackingDebug(app, {
    fixture: params.get('fixture') ?? 'jab-right',
    live: params.has('live'),
  });
} else {
  bootPlaceholder(app);
}

/** Phase 0 placeholder: a lit spinning cube proving the render loop. */
function bootPlaceholder(root: HTMLElement): void {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  root.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1512);

  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  );
  camera.position.set(0, 1.5, 4);

  const key = new THREE.PointLight(0xff8a3c, 30, 20);
  key.position.set(2, 3, 2);
  scene.add(key);
  scene.add(new THREE.AmbientLight(0x2a1f18, 1.5));

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x8a2f1d, roughness: 0.7 }),
  );
  cube.position.y = 1.5;
  scene.add(cube);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    cube.rotation.y += dt * 0.8;
    key.intensity = 28 + Math.sin(clock.elapsedTime * 9) * 2 + Math.sin(clock.elapsedTime * 23) * 1.2;
    renderer.render(scene, camera);
  });
}
