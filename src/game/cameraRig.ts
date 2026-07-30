// Camera rig (T031): home pose at the player's end of the lane, head-pose
// parallax per Section 8 (hard clamped to +/-4 degrees and +/-0.25 m, heavily
// smoothed on top of upstream filtering), authored kill-travel splines between
// arena anchors, decaying additive shake for combat juice, and a whisper of
// idle breathing sway.
//
// All motion is frame-rate independent. Exponential smoothing always uses
// alpha = 1 - exp(-dt / tau).
//
// The parallax delta is layered on top of whatever base pose the rig currently
// holds (home or mid-travel), so gameplay can query `basePosition` for the
// undeflected path (duck detection, aim assists) at any time.

import * as THREE from 'three';
import type { FaceFrame } from '../tracking/types';

// --- Section 8 hard limits --------------------------------------------------

/** Max parallax rotation away from the base orientation, radians (~4 deg). */
export const MAX_PARALLAX_RAD = THREE.MathUtils.degToRad(4);
/**
 * Sign applied to player-space head yaw before the Y-axis camera rotation.
 * Player space says positive yaw = the player looks to their own right, but a
 * positive Three.js rotation about +Y pans the camera LEFT (forward -Z swings
 * toward -X). That hidden flip previously inverted the parallax. -1 makes
 * head-left pan the camera left, window style, per Section 8. Runtime
 * togglable via CameraRig.parallaxYawSign (the P key in the arena).
 */
export const PARALLAX_YAW_SIGN = -1;
/** Max positional deflection away from the base path, meters. */
export const MAX_PARALLAX_OFFSET = 0.25;
/** Parallax smoothing time constant, seconds. */
const PARALLAX_TAU = 0.15;

// Gains from head pose to camera delta. Chosen so a normal head range
// saturates the clamps well before the raw signal maxes out.
const ROT_GAIN = 0.2; // head yaw/pitch rad -> camera rad
const POS_GAIN_X = 0.8; // normalized screen offset -> meters
const POS_GAIN_Y = 0.5;
const POS_GAIN_Z = 0.4; // lean toward camera -> gentle dolly-in

// Idle breathing sway: very small, slow, never enough to read as motion.
const BREATH_AMPLITUDE = 0.02; // meters
const BREATH_HZ = 0.25;

/** Total shake deflection cap, meters. Stacked shakes never exceed this. */
export const SHAKE_CAP = 0.35;

// Home pose: standing at the player position area, looking down the lane
// toward the first enemy anchor (arena.ts places it at (0, 1.1, -6)).
const HOME_POSITION = new THREE.Vector3(0, 1.5, 0.6);
const HOME_LOOK = new THREE.Vector3(0, 1.1, -6);

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const TWO_PI = Math.PI * 2;

export interface TravelOptions {
  /** Travel time in seconds, clamped to [2, 3]. Default 2.5. */
  durationSec?: number;
  /** How far in front of the target anchor the camera settles. Default 5.5. */
  viewDistance?: number;
  /** Camera eye height at arrival. Default 1.5. */
  eyeHeight?: number;
  /** Sideways bow of the spline midpoints, meters. Default 2. */
  lateralSwing?: number;
}

interface TravelState {
  curve: THREE.CatmullRomCurve3;
  endPos: THREE.Vector3;
  fromLook: THREE.Vector3;
  toLook: THREE.Vector3;
  duration: number;
  elapsed: number;
  resolve: () => void;
}

interface ShakeState {
  amp: number;
  duration: number;
  elapsed: number;
  /** Random-ish phases seeded when shake() is called. */
  phases: [number, number, number, number, number];
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Small deterministic PRNG for shake phases (same one arena.ts uses). */
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

export class CameraRig {
  private readonly camera: THREE.PerspectiveCamera;

  // Base pose: the authored path, before parallax / breathing / shake.
  private readonly basePos = HOME_POSITION.clone();
  private readonly baseLook = HOME_LOOK.clone();
  private readonly baseQuat = new THREE.Quaternion();

  // Smoothed parallax state (camera-local frame).
  private parallaxYaw = 0;
  private parallaxPitch = 0;
  private readonly parallaxPos = new THREE.Vector3();

  private travel: TravelState | null = null;
  private travelCount = 0;
  private yawSign: number = PARALLAX_YAW_SIGN;

  private shakes: ShakeState[] = [];
  private shakeSeed = 0x9e3779b9;

  private elapsed = 0;

  // Scratch objects, never handed out.
  private readonly tmpMat = new THREE.Matrix4();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.refreshBaseQuat();
    this.camera.position.copy(this.basePos);
    this.camera.quaternion.copy(this.baseQuat);
  }

  /** The undeflected base position (home or mid-travel). Cloned. */
  get basePosition(): THREE.Vector3 {
    return this.basePos.clone();
  }

  /** The undeflected base orientation. Cloned. */
  get baseQuaternion(): THREE.Quaternion {
    return this.baseQuat.clone();
  }

  get isTraveling(): boolean {
    return this.travel !== null;
  }

  /** Current yaw sign (+1 or -1); see PARALLAX_YAW_SIGN. */
  get parallaxYawSign(): number {
    return this.yawSign;
  }

  /** Runtime toggle target (the P key). Snaps to +1/-1; the smoothed state
   *  eases to the re-signed target over PARALLAX_TAU, so no camera snap. */
  set parallaxYawSign(sign: number) {
    this.yawSign = sign >= 0 ? 1 : -1;
  }

  /** Debug view of the smoothed parallax delta currently applied (Task 4 HUD). */
  get parallaxState(): {
    yaw: number;
    pitch: number;
    offset: { x: number; y: number; z: number };
  } {
    return {
      yaw: this.parallaxYaw,
      pitch: this.parallaxPitch,
      offset: {
        x: this.parallaxPos.x,
        y: this.parallaxPos.y,
        z: this.parallaxPos.z,
      },
    };
  }

  /**
   * Feed the latest (already upstream-filtered) head pose. Yaw/pitch/position
   * drive a small camera offset, hard clamped and heavily smoothed here on top
   * of any source filtering. Pass null when the face is lost: the delta eases
   * back to neutral instead of snapping.
   */
  applyHeadPose(face: FaceFrame | null, dt: number): void {
    let targetYaw = 0;
    let targetPitch = 0;
    const targetPos = this.tmpA.set(0, 0, 0);

    if (face !== null) {
      targetYaw = this.yawSign * face.yaw * ROT_GAIN;
      targetPitch = face.pitch * ROT_GAIN;
      // Clamp the combined rotation magnitude so yaw + pitch together can
      // never exceed the 4 degree budget.
      const mag = Math.hypot(targetYaw, targetPitch);
      if (mag > MAX_PARALLAX_RAD) {
        const s = MAX_PARALLAX_RAD / mag;
        targetYaw *= s;
        targetPitch *= s;
      }
      // Head position is normalized screen coords, center (0.5, 0.5), y down,
      // z negative toward the camera (leaning in dollies gently forward).
      targetPos.set(
        (face.position.x - 0.5) * POS_GAIN_X,
        (0.5 - face.position.y) * POS_GAIN_Y,
        face.position.z * POS_GAIN_Z,
      );
      if (targetPos.length() > MAX_PARALLAX_OFFSET) {
        targetPos.setLength(MAX_PARALLAX_OFFSET);
      }
    }

    const alpha = 1 - Math.exp(-Math.max(dt, 0) / PARALLAX_TAU);
    this.parallaxYaw += (targetYaw - this.parallaxYaw) * alpha;
    this.parallaxPitch += (targetPitch - this.parallaxPitch) * alpha;
    this.parallaxPos.lerp(targetPos, alpha);

    // Belt and suspenders: the smoothed state itself can never sit outside
    // the clamps, whatever upstream feeds us.
    const smoothedMag = Math.hypot(this.parallaxYaw, this.parallaxPitch);
    if (smoothedMag > MAX_PARALLAX_RAD) {
      const s = MAX_PARALLAX_RAD / smoothedMag;
      this.parallaxYaw *= s;
      this.parallaxPitch *= s;
    }
    if (this.parallaxPos.length() > MAX_PARALLAX_OFFSET) {
      this.parallaxPos.setLength(MAX_PARALLAX_OFFSET);
    }
  }

  /**
   * Travel along an authored CatmullRom spline from the current base pose to
   * a viewing pose in front of `targetAnchor`, sweeping sideways past the
   * columns and braziers. The look target interpolates smoothly from the
   * previous one. Resolves on arrival.
   *
   * Calling travelTo while a travel is in flight supersedes it: the old
   * promise resolves immediately (the rig can only be in one place) and the
   * new spline starts from wherever the base pose currently is.
   */
  travelTo(targetAnchor: THREE.Vector3, opts: TravelOptions = {}): Promise<void> {
    const duration = THREE.MathUtils.clamp(opts.durationSec ?? 2.5, 2, 3);
    const viewDistance = opts.viewDistance ?? 5.5;
    const eyeHeight = opts.eyeHeight ?? 1.5;
    const swing = opts.lateralSwing ?? 2;

    const prev = this.travel;
    if (prev !== null) {
      this.travel = null;
      prev.resolve();
    }

    const toLook = targetAnchor.clone();

    // Viewing position: viewDistance in front of the anchor, on the side we
    // approach from, at eye height.
    const approach = this.tmpA.copy(this.basePos).sub(targetAnchor);
    approach.y = 0;
    if (approach.lengthSq() < 1e-6) approach.set(0, 0, 1);
    approach.normalize();
    const endPos = targetAnchor.clone().addScaledVector(approach, viewDistance);
    endPos.y = eyeHeight;

    const start = this.basePos.clone();
    if (start.distanceTo(endPos) < 1e-3) {
      this.baseLook.copy(toLook);
      return Promise.resolve();
    }

    // Lateral swing alternates sides on successive travels so back-to-back
    // kills sweep past the flanking columns and braziers on both sides.
    // Swing of 2 m keeps the camera inside the column line at x = +/-3.4.
    const along = this.tmpB.copy(endPos).sub(start);
    along.y = 0;
    if (along.lengthSq() < 1e-6) along.set(0, 0, -1);
    along.normalize();
    const sideSign = this.travelCount % 2 === 0 ? 1 : -1;
    this.travelCount++;
    const side = this.tmpC.set(-along.z, 0, along.x).multiplyScalar(sideSign);

    const p1 = start
      .clone()
      .lerp(endPos, 1 / 3)
      .addScaledVector(side, swing);
    p1.y += 0.35;
    const p2 = start
      .clone()
      .lerp(endPos, 2 / 3)
      .addScaledVector(side, swing * 0.55);
    p2.y += 0.2;

    const curve = new THREE.CatmullRomCurve3([start, p1, p2, endPos], false, 'centripetal');

    return new Promise<void>((resolve) => {
      this.travel = {
        curve,
        endPos,
        fromLook: this.baseLook.clone(),
        toLook,
        duration,
        elapsed: 0,
        resolve,
      };
    });
  }

  /**
   * Additive decaying camera shake (layered sines with phases seeded per
   * call). Stacked shakes sum but the total deflection is capped at
   * SHAKE_CAP, so spamming Twin Cannon never launches the camera.
   * Hit-stop is combat's job, not the rig's.
   */
  shake(intensity: number, durationSec: number): void {
    if (intensity <= 0 || durationSec <= 0) return;
    this.shakeSeed = (Math.imul(this.shakeSeed, 1664525) + 1013904223) >>> 0;
    const rng = mulberry32(this.shakeSeed);
    this.shakes.push({
      amp: Math.min(intensity, SHAKE_CAP),
      duration: durationSec,
      elapsed: 0,
      phases: [rng() * TWO_PI, rng() * TWO_PI, rng() * TWO_PI, rng() * TWO_PI, rng() * TWO_PI],
    });
  }

  /**
   * Advance travel, compose base pose + parallax delta + breathing + shake
   * onto the camera. Call once per frame with the frame's dt in seconds.
   */
  update(dt: number): void {
    const step = Math.max(dt, 0);
    this.elapsed += step;

    const travel = this.travel;
    if (travel !== null) {
      travel.elapsed += step;
      const u = Math.min(travel.elapsed / travel.duration, 1);
      const e = easeInOutCubic(u);
      travel.curve.getPoint(e, this.basePos);
      this.baseLook.lerpVectors(travel.fromLook, travel.toLook, e);
      if (u >= 1) {
        this.basePos.copy(travel.endPos);
        this.baseLook.copy(travel.toLook);
        this.travel = null;
        travel.resolve();
      }
    }

    this.refreshBaseQuat();

    // Parallax offset expressed in the base frame, plus breathing sway,
    // jointly capped: the camera never strays more than MAX_PARALLAX_OFFSET
    // from the base path (shake has its own cap on top).
    const offset = this.tmpA.copy(this.parallaxPos).applyQuaternion(this.baseQuat);
    offset.y += Math.sin(this.elapsed * TWO_PI * BREATH_HZ) * BREATH_AMPLITUDE;
    offset.x += Math.sin(this.elapsed * TWO_PI * BREATH_HZ * 0.7 + 1.3) * BREATH_AMPLITUDE * 0.4;
    if (offset.length() > MAX_PARALLAX_OFFSET) offset.setLength(MAX_PARALLAX_OFFSET);

    const shakeOffset = this.computeShake(step);

    this.camera.position.copy(this.basePos).add(offset).add(shakeOffset);
    this.camera.quaternion
      .copy(this.baseQuat)
      .multiply(this.tmpQ.setFromAxisAngle(Y_AXIS, this.parallaxYaw))
      .multiply(this.tmpQ.setFromAxisAngle(X_AXIS, this.parallaxPitch));
  }

  private refreshBaseQuat(): void {
    this.tmpMat.lookAt(this.basePos, this.baseLook, WORLD_UP);
    this.baseQuat.setFromRotationMatrix(this.tmpMat);
  }

  private computeShake(dt: number): THREE.Vector3 {
    const out = this.tmpB.set(0, 0, 0);
    if (this.shakes.length === 0) return out;
    const alive: ShakeState[] = [];
    for (const s of this.shakes) {
      s.elapsed += dt;
      const u = s.elapsed / s.duration;
      if (u >= 1) continue;
      const decay = (1 - u) * (1 - u);
      const t = s.elapsed;
      const [p0, p1, p2, p3, p4] = s.phases;
      out.x +=
        s.amp * decay * 0.6 * (Math.sin(t * 31 + p0) + 0.5 * Math.sin(t * 67 + p1));
      out.y +=
        s.amp * decay * 0.6 * (Math.sin(t * 37 + p2) + 0.5 * Math.sin(t * 71 + p3));
      out.z += s.amp * decay * 0.25 * Math.sin(t * 23 + p4);
      alive.push(s);
    }
    this.shakes = alive;
    if (out.length() > SHAKE_CAP) out.setLength(SHAKE_CAP);
    return out;
  }
}
