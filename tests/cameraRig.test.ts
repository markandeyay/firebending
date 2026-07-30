// Headless camera rig checks: node only, no WebGL, no DOM. Three's math
// classes (Vector3, Quaternion, CatmullRomCurve3) work fine without a canvas.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CameraRig,
  MAX_PARALLAX_OFFSET,
  MAX_PARALLAX_RAD,
  SHAKE_CAP,
} from '../src/game/cameraRig';
import { nextArenaAnchor } from '../src/game/killTravel';
import type { FaceFrame } from '../src/tracking/types';

const DT = 1 / 60;

function makeRig(): { camera: THREE.PerspectiveCamera; rig: CameraRig } {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  const rig = new CameraRig(camera);
  return { camera, rig };
}

function face(yaw: number, pitch: number, x: number, y: number, z = 0): FaceFrame {
  return { yaw, pitch, position: { x, y, z }, confidence: 1 };
}

/** Angle in radians between the camera orientation and the rig's base pose. */
function rotationDelta(camera: THREE.PerspectiveCamera, rig: CameraRig): number {
  return camera.quaternion.angleTo(rig.baseQuaternion);
}

function positionDelta(camera: THREE.PerspectiveCamera, rig: CameraRig): number {
  return camera.position.distanceTo(rig.basePosition);
}

describe('CameraRig home pose', () => {
  it('starts at the player end looking down the lane', () => {
    const { camera } = makeRig();
    expect(camera.position.x).toBeCloseTo(0, 5);
    expect(camera.position.y).toBeCloseTo(1.5, 5);
    expect(camera.position.z).toBeCloseTo(0.6, 5);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    // Facing the enemy anchor at (0, 1.1, -6): mostly -z.
    expect(forward.z).toBeLessThan(-0.95);
  });
});

describe('CameraRig parallax yaw sign (Section 8, window style)', () => {
  // Player space: positive yaw = the player looks to their own right.
  // Window style: looking right must pan the camera right. At the home pose
  // (forward -z, up +y) camera-right is world +x, so the settled forward
  // vector must tilt toward +x for positive yaw and -x for negative.
  it('head right pans the camera right, head left pans left', () => {
    const settle = (yaw: number): number => {
      const { camera, rig } = makeRig();
      const f = face(yaw, 0, 0.5, 0.5);
      for (let i = 0; i < 300; i++) {
        rig.applyHeadPose(f, DT);
        rig.update(DT);
      }
      return camera.getWorldDirection(new THREE.Vector3()).x;
    };
    expect(settle(0.2)).toBeGreaterThan(0.005); // looks right -> pans right
    expect(settle(-0.2)).toBeLessThan(-0.005); // looks left -> pans left
  });

  it('the runtime sign toggle flips the settled direction', () => {
    const { camera, rig } = makeRig();
    rig.parallaxYawSign = -rig.parallaxYawSign;
    const f = face(0.2, 0, 0.5, 0.5);
    for (let i = 0; i < 300; i++) {
      rig.applyHeadPose(f, DT);
      rig.update(DT);
    }
    expect(camera.getWorldDirection(new THREE.Vector3()).x).toBeLessThan(-0.005);
  });
});

describe('CameraRig parallax clamps', () => {
  it('never exceeds 4 degrees rotation or 0.25 m offset under extreme input', () => {
    const { camera, rig } = makeRig();
    // Extreme head pose: yaw 1 rad, pitch 1 rad, head at the screen corner
    // (0.5 normalized offset), leaning hard toward the camera.
    const extreme = face(1, 1, 1.0, 0.0, -0.5);
    for (let i = 0; i < 400; i++) {
      rig.applyHeadPose(extreme, DT);
      rig.update(DT);
      expect(rotationDelta(camera, rig)).toBeLessThanOrEqual(MAX_PARALLAX_RAD + 1e-3);
      expect(positionDelta(camera, rig)).toBeLessThanOrEqual(MAX_PARALLAX_OFFSET + 1e-6);
    }
    // After settling it should actually be pushing against the clamps.
    expect(rotationDelta(camera, rig)).toBeGreaterThan(MAX_PARALLAX_RAD * 0.9);
    expect(positionDelta(camera, rig)).toBeGreaterThan(MAX_PARALLAX_OFFSET * 0.9);
  });
});

describe('CameraRig parallax smoothing', () => {
  it('takes multiple frames to reach 90% of a step change (no snapping)', () => {
    const { camera, rig } = makeRig();
    // Small yaw so the target sits inside the clamp (0.2 rad * gain < 4 deg).
    const stepFace = face(0.2, 0, 0.5, 0.5);

    rig.applyHeadPose(stepFace, DT);
    rig.update(DT);
    const afterOne = rotationDelta(camera, rig);

    // Find the settled target by running long.
    for (let i = 0; i < 600; i++) {
      rig.applyHeadPose(stepFace, DT);
      rig.update(DT);
    }
    const settled = rotationDelta(camera, rig);
    expect(settled).toBeGreaterThan(0.005);
    expect(afterOne).toBeLessThan(settled * 0.5);

    // Fresh rig: count frames to 90% of the settled value.
    const fresh = makeRig();
    let frames = 0;
    while (frames < 300) {
      fresh.rig.applyHeadPose(stepFace, DT);
      fresh.rig.update(DT);
      frames++;
      if (rotationDelta(fresh.camera, fresh.rig) >= settled * 0.9) break;
    }
    expect(frames).toBeGreaterThan(5);
    expect(frames).toBeLessThan(300);
  });

  it('eases back to neutral when the face is lost', () => {
    const { camera, rig } = makeRig();
    const stepFace = face(0.2, 0.1, 0.7, 0.3);
    for (let i = 0; i < 300; i++) {
      rig.applyHeadPose(stepFace, DT);
      rig.update(DT);
    }
    const peakRot = rotationDelta(camera, rig);
    const peakPos = positionDelta(camera, rig);
    expect(peakRot).toBeGreaterThan(0.005);

    // One frame of null must not snap to zero.
    rig.applyHeadPose(null, DT);
    rig.update(DT);
    expect(rotationDelta(camera, rig)).toBeGreaterThan(peakRot * 0.5);

    // Sustained loss decays toward neutral.
    for (let i = 0; i < 300; i++) {
      rig.applyHeadPose(null, DT);
      rig.update(DT);
    }
    expect(rotationDelta(camera, rig)).toBeLessThan(peakRot * 0.05);
    expect(positionDelta(camera, rig)).toBeLessThan(Math.max(peakPos * 0.05, 0.03));
  });
});

describe('CameraRig travel', () => {
  it('resolves in 2 to 3 seconds at the expected viewing pose, facing the target', async () => {
    const { camera, rig } = makeRig();
    const target = new THREE.Vector3(0, 1.1, -11);
    let done = false;
    void rig.travelTo(target).then(() => {
      done = true;
    });

    const positions: THREE.Vector3[] = [camera.position.clone()];
    let simTime = 0;
    while (!done && simTime < 5) {
      rig.update(DT);
      simTime += DT;
      positions.push(camera.position.clone());
      await Promise.resolve();
    }

    expect(done).toBe(true);
    expect(simTime).toBeGreaterThanOrEqual(2);
    expect(simTime).toBeLessThanOrEqual(3.05);

    // Viewing pose: 5.5 m in front of the anchor along the approach, eye 1.5.
    const expected = new THREE.Vector3(0, 1.5, -5.5);
    expect(rig.basePosition.distanceTo(expected)).toBeLessThan(0.01);
    expect(camera.position.distanceTo(expected)).toBeLessThan(0.1);

    // Forward vector points at the target within ~5 degrees.
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const toTarget = target.clone().sub(camera.position).normalize();
    expect(forward.angleTo(toTarget)).toBeLessThan(THREE.MathUtils.degToRad(5));

    // C0 smooth: bounded per-frame movement, no teleports mid-travel.
    let maxStep = 0;
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];
      if (prev === undefined || curr === undefined) continue;
      maxStep = Math.max(maxStep, curr.distanceTo(prev));
    }
    expect(maxStep).toBeLessThan(0.25);
  });

  it('sweeps laterally through the spline instead of flying a straight line', async () => {
    const { camera, rig } = makeRig();
    let done = false;
    void rig.travelTo(new THREE.Vector3(0, 1.1, -11)).then(() => {
      done = true;
    });
    let maxLateral = 0;
    let simTime = 0;
    while (!done && simTime < 5) {
      rig.update(DT);
      simTime += DT;
      maxLateral = Math.max(maxLateral, Math.abs(camera.position.x));
      await Promise.resolve();
    }
    // Start and end are both on x = 0; the swing should bow well off-axis
    // but stay inside the column line at x = +/-3.4.
    expect(maxLateral).toBeGreaterThan(0.8);
    expect(maxLateral).toBeLessThan(3.0);
  });

  it('keeps parallax within the clamps relative to the moving travel base', async () => {
    const { camera, rig } = makeRig();
    const extreme = face(1, -1, 0.0, 1.0, -0.5);
    let done = false;
    void rig.travelTo(new THREE.Vector3(1.2, 1.1, -11)).then(() => {
      done = true;
    });
    let simTime = 0;
    while (!done && simTime < 5) {
      rig.applyHeadPose(extreme, DT);
      rig.update(DT);
      simTime += DT;
      expect(positionDelta(camera, rig)).toBeLessThanOrEqual(MAX_PARALLAX_OFFSET + 1e-6);
      expect(rotationDelta(camera, rig)).toBeLessThanOrEqual(MAX_PARALLAX_RAD + 1e-3);
      await Promise.resolve();
    }
    expect(done).toBe(true);
  });
});

describe('CameraRig shake', () => {
  it('shakes, decays back to rest, and never exceeds the cap even when stacked', () => {
    const { camera, rig } = makeRig();
    // Stack absurd shakes; the cap must hold.
    rig.shake(10, 0.5);
    rig.shake(10, 0.5);
    rig.shake(3, 0.4);

    let maxOffset = 0;
    for (let i = 0; i < 30; i++) {
      rig.update(DT);
      const offset = positionDelta(camera, rig);
      maxOffset = Math.max(maxOffset, offset);
      // Shake cap plus the parallax/breathing budget.
      expect(offset).toBeLessThanOrEqual(SHAKE_CAP + MAX_PARALLAX_OFFSET + 1e-6);
    }
    expect(maxOffset).toBeGreaterThan(0.05); // it visibly shook

    // Run past the longest duration: back to breathing-only levels.
    for (let i = 0; i < 120; i++) rig.update(DT);
    expect(positionDelta(camera, rig)).toBeLessThan(0.03);
  });

  it('is a no-op for zero or negative parameters', () => {
    const { camera, rig } = makeRig();
    rig.shake(0, 1);
    rig.shake(-1, 1);
    rig.shake(1, 0);
    rig.update(DT);
    // Only breathing sway remains.
    expect(positionDelta(camera, rig)).toBeLessThan(0.03);
  });
});

describe('nextArenaAnchor', () => {
  it('is deterministic', () => {
    for (let i = 0; i < 12; i++) {
      const a = nextArenaAnchor(i);
      const b = nextArenaAnchor(i);
      expect(a.position.equals(b.position)).toBe(true);
      expect(a.facing.equals(b.facing)).toBe(true);
    }
  });

  it('starts at the arena enemy anchor and marches monotonically down -z', () => {
    const first = nextArenaAnchor(0);
    expect(first.position.x).toBeCloseTo(0, 5);
    expect(first.position.y).toBeCloseTo(1.1, 5);
    expect(first.position.z).toBeCloseTo(-6, 5);

    let prevZ = Infinity;
    for (let i = 0; i < 20; i++) {
      const anchor = nextArenaAnchor(i);
      expect(anchor.position.z).toBeLessThan(prevZ);
      prevZ = anchor.position.z;
      expect(anchor.position.y).toBeCloseTo(1.1, 5);
    }
    // Advances ~5 m per kill, continuing past the built arena depth
    // (director handles the environment illusion there).
    expect(nextArenaAnchor(5).position.z).toBeCloseTo(-31, 5);
  });

  it('alternates laterally +1.2 / -1.2 after the first anchor', () => {
    expect(nextArenaAnchor(1).position.x).toBeCloseTo(1.2, 5);
    expect(nextArenaAnchor(2).position.x).toBeCloseTo(-1.2, 5);
    expect(nextArenaAnchor(3).position.x).toBeCloseTo(1.2, 5);
    expect(nextArenaAnchor(4).position.x).toBeCloseTo(-1.2, 5);
  });

  it('faces back up the lane with unit length', () => {
    for (let i = 0; i < 8; i++) {
      const anchor = nextArenaAnchor(i);
      expect(anchor.facing.length()).toBeCloseTo(1, 5);
      expect(anchor.facing.z).toBeGreaterThan(0.5); // toward the player side
      expect(anchor.facing.y).toBeCloseTo(0, 5);
    }
  });
});
