/**
 * In-world gloves (Phase 2, Task 2b): the player's hands rendered inside the
 * arena as articulated first-person boxing-style gloves. This is the game's
 * only in-world hand representation.
 *
 * STYLE: Wii Sports Boxing first-person gloves translated into this world's
 * aesthetic law (spec Section 2): deep red lacquered wrapped fists (oxblood
 * clearcoat), near-black leather binding straps across the palm, a muted
 * gold trim ring at the wrist cuff. No arms, no body; the gloves float and
 * end at the cuff. All light on them is scene firelight.
 *
 * GEOMETRY: primitives only, shared across both hands. Per hand: a palm
 * block (unit box, non-uniformly scaled each frame from the MCP row) with a
 * squashed-sphere mitt bulge and two strap boxes as children, a gold cuff
 * cylinder at the wrist, and 5 fingers x 3 segments as unit cylinders with
 * sphere knuckle caps at every joint. Each finger segment is positioned and
 * oriented from its two endpoint landmarks (mcp-pip, pip-dip, dip-tip;
 * thumb cmc-mcp, mcp-ip, ip-tip) via setFromUnitVectors, so knuckles
 * visibly bend when a finger curls.
 *
 * DATA: shapeLandmarks() produces 21 metric, wrist-origin points in
 * render-local axes (x player-right, y UP, z toward the camera). It PREFERS
 * HandFrame.world (MediaPipe world landmarks, meters); replay fixtures lack
 * that field, so the fallback scale-normalizes the screen landmarks by the
 * wrist-to-middle-MCP distance and multiplies by a real hand size
 * (HAND_SIZE_M). One code path feeds both live and replay.
 *
 * PLACEMENT: the wrist anchors on the same reach-plane mapping the fire
 * uses (moveEffects.screenToWorld), so the gloves sit exactly where flames
 * spawn from. The glove GROUP is oriented camera-facing (local axes map to
 * camera right/up/forward) and shape offsets add onto the anchor; the palm
 * block itself is oriented by a hand basis built from wrist->middleMCP and
 * indexMCP->pinkyMCP, so palm rotation reads.
 *
 * WEIGHT: the group follows its anchor through a critically-damped
 * exponential spring (GLOVE_FOLLOW_TAU) with a small velocity-proportional
 * lead (GLOVE_OVERSHOOT) for follow-through. Fingers pose directly, so curl
 * response stays crisp. A hand absent from the frame eases its glove out
 * (scale to 0 over GLOVE_EASE_SEC) instead of popping.
 *
 * LIGHT BUDGET: no standing lights. While a Breath Charge is exposed
 * (fx.chargeActive), ONE pooled FireSystem light hovers between the fists
 * and is released the moment the charge lapses.
 *
 * All math helpers are exported pure functions so headless tests never need
 * WebGL; the mesh assembly is plain three.js object construction (DOM-free).
 */

import * as THREE from 'three';
import type { HandFrame, LandmarkFrame, Vec3 } from '../tracking/types';
import { HAND_LANDMARK_COUNT, LM } from '../tracking/types';
import { screenToWorld } from './moveEffects';
import type { FireLightHandle, FireSystem } from './fire';

// ---------------------------------------------------------------------------
// Tunables (the orchestrator iterates on these)
// ---------------------------------------------------------------------------

/** Anchor-follow spring time constant, seconds (~70-90 ms feels weighty). */
export const GLOVE_FOLLOW_TAU = 0.08;
/** Velocity-proportional overshoot lead, seconds of anchor velocity. */
export const GLOVE_OVERSHOOT = 0.055;
/** Ease-out (and ease-in) time for glove presence, seconds. */
export const GLOVE_EASE_SEC = 0.15;
/** Real-ish hand size: wrist to middle MCP, meters (screen fallback scale). */
export const HAND_SIZE_M = 0.085;
/** Overall chunkiness multiplier on glove volumes (1 = anatomical). */
export const GLOVE_SIZE_SCALE = 1.55;
/**
 * Constant down-screen bias (normalized screen units, y grows down) added to
 * the wrist anchor before unprojection, so resting hands settle toward the
 * bottom of the frame like first-person boxing games instead of hovering at
 * mid-screen.
 */
export const GLOVE_REST_DROP = 0.09;
/** Base finger segment radius, meters, before GLOVE_SIZE_SCALE. */
export const GLOVE_FINGER_RADIUS_M = 0.011;
/** Charge light between the fists: intensity / radius. */
export const GLOVE_CHARGE_LIGHT_INTENSITY = 2.4;
export const GLOVE_CHARGE_LIGHT_RADIUS = 3.5;
/** Constant first-person fill so the camera-side faces are never black. */
export const GLOVE_FILL_COLOR = 0xff9a55;
export const GLOVE_FILL_INTENSITY = 0.5;

/** Deep red lacquered glove body (oxblood-to-vermilion). */
export const GLOVE_BASE_COLOR = 0x7a1a10;
/** Near-black brown leather binding straps. */
export const GLOVE_STRAP_COLOR = 0x241611;
/** Muted gold wrist cuff trim. */
export const GLOVE_CUFF_COLOR = 0x8a6a2f;

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/**
 * The 15 finger segments as consecutive landmark pairs:
 * thumb cmc-mcp, mcp-ip, ip-tip; each finger mcp-pip, pip-dip, dip-tip.
 */
export const FINGER_SEGMENTS: ReadonlyArray<readonly [number, number]> = [
  [LM.THUMB_CMC, LM.THUMB_MCP],
  [LM.THUMB_MCP, LM.THUMB_IP],
  [LM.THUMB_IP, LM.THUMB_TIP],
  [LM.INDEX_MCP, LM.INDEX_PIP],
  [LM.INDEX_PIP, LM.INDEX_DIP],
  [LM.INDEX_DIP, LM.INDEX_TIP],
  [LM.MIDDLE_MCP, LM.MIDDLE_PIP],
  [LM.MIDDLE_PIP, LM.MIDDLE_DIP],
  [LM.MIDDLE_DIP, LM.MIDDLE_TIP],
  [LM.RING_MCP, LM.RING_PIP],
  [LM.RING_PIP, LM.RING_DIP],
  [LM.RING_DIP, LM.RING_TIP],
  [LM.PINKY_MCP, LM.PINKY_PIP],
  [LM.PINKY_PIP, LM.PINKY_DIP],
  [LM.PINKY_DIP, LM.PINKY_TIP],
];

/** Landmark index -> adjoining (thicker) segment index, for joint radii. */
const JOINT_SEGMENT_INDEX: number[] = (() => {
  const map: number[] = new Array(21).fill(3);
  for (let k = FINGER_SEGMENTS.length - 1; k >= 0; k--) {
    const pair = FINGER_SEGMENTS[k];
    if (!pair) continue;
    map[pair[0]] = k;
    map[pair[1]] = k;
  }
  return map;
})();

/** Segment radius in meters: thumb thicker, distal segments tapered. */
export function segmentRadius(segmentIndex: number): number {
  const base = GLOVE_FINGER_RADIUS_M * GLOVE_SIZE_SCALE;
  if (segmentIndex < 3) return base * 1.25; // thumb
  const within = segmentIndex % 3; // 0 proximal, 1 middle, 2 distal
  return base * (within === 0 ? 1.05 : within === 1 ? 0.95 : 0.85);
}

// ---------------------------------------------------------------------------
// Pure math helpers (unit-tested headless)
// ---------------------------------------------------------------------------

function dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 21 metric shape landmarks for a hand: wrist at the origin, x to the
 * player's right, y UP, z positive toward the camera (render-local axes;
 * the source spaces have y down and z negative toward the camera, so both
 * are negated). PREFERS HandFrame.world (already meters); falls back to
 * screen landmarks normalized by the wrist-to-middle-MCP distance and
 * scaled to HAND_SIZE_M. Writes into `out` when given (no allocation in
 * the hot path); otherwise returns fresh objects.
 */
export function shapeLandmarks(hand: HandFrame, out?: Vec3[]): Vec3[] {
  const result = out ?? Array.from({ length: HAND_LANDMARK_COUNT }, () => ({ x: 0, y: 0, z: 0 }));
  const world = hand.world;
  const src = world && world.length >= HAND_LANDMARK_COUNT ? world : hand.landmarks;
  const wrist = src[LM.WRIST];
  const middleMcp = src[LM.MIDDLE_MCP];
  if (!wrist || !middleMcp) return result;
  // World landmarks are metric already; screen landmarks get normalized by
  // hand scale, then sized to a real hand.
  let scale = 1;
  if (src === hand.landmarks) {
    const span = dist(wrist, middleMcp);
    scale = span > 1e-6 ? HAND_SIZE_M / span : 0;
  }
  for (let i = 0; i < HAND_LANDMARK_COUNT; i++) {
    const lm = src[i];
    const o = result[i];
    if (!lm || !o) continue;
    o.x = (lm.x - wrist.x) * scale;
    o.y = -(lm.y - wrist.y) * scale;
    o.z = -(lm.z - wrist.z) * scale;
  }
  return result;
}

const _dir = new THREE.Vector3();
const Y_UP = new THREE.Vector3(0, 1, 0);

/**
 * Quaternion aligning the +Y axis onto the a->b direction (a segment mesh
 * is a Y-aligned unit cylinder). Degenerate segments yield identity.
 */
export function segmentOrientation(
  a: Vec3,
  b: Vec3,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  _dir.set(b.x - a.x, b.y - a.y, b.z - a.z);
  if (_dir.lengthSq() < 1e-12) return out.identity();
  _dir.normalize();
  return out.setFromUnitVectors(Y_UP, _dir);
}

const _bUp = new THREE.Vector3();
const _bAcross = new THREE.Vector3();
const _bNormal = new THREE.Vector3();
const _bMat = new THREE.Matrix4();

/**
 * Palm-orientation basis from shape landmarks (wrist-origin): local +Y along
 * wrist->middleMCP ("up" the hand), +X along the orthonormalized
 * indexMCP->pinkyMCP knuckle line, +Z the palm normal (their cross).
 * Degenerate input yields identity.
 */
export function handBasisQuaternion(
  shape: readonly Vec3[],
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  const mid = shape[LM.MIDDLE_MCP];
  const idx = shape[LM.INDEX_MCP];
  const pnk = shape[LM.PINKY_MCP];
  if (!mid || !idx || !pnk) return out.identity();
  _bUp.set(mid.x, mid.y, mid.z);
  _bAcross.set(pnk.x - idx.x, pnk.y - idx.y, pnk.z - idx.z);
  if (_bUp.lengthSq() < 1e-12 || _bAcross.lengthSq() < 1e-12) return out.identity();
  _bUp.normalize();
  _bNormal.crossVectors(_bAcross, _bUp);
  if (_bNormal.lengthSq() < 1e-12) return out.identity();
  _bNormal.normalize();
  _bAcross.crossVectors(_bUp, _bNormal).normalize();
  _bMat.makeBasis(_bAcross, _bUp, _bNormal);
  return out.setFromRotationMatrix(_bMat);
}

/**
 * Presence easing step: ramps 0..1 over GLOVE_EASE_SEC toward 1 when the
 * hand is present, toward 0 when absent. Pure; clamped.
 */
export function presenceStep(value: number, present: boolean, dt: number): number {
  const rate = GLOVE_EASE_SEC > 0 ? dt / GLOVE_EASE_SEC : 1;
  const next = value + (present ? rate : -rate);
  return next < 0 ? 0 : next > 1 ? 1 : next;
}

/** Critically-damped exponential follow factor for a frame of dt seconds. */
export function followAlpha(dt: number, tau: number = GLOVE_FOLLOW_TAU): number {
  return 1 - Math.exp(-dt / Math.max(tau, 1e-4));
}

// ---------------------------------------------------------------------------
// Shared assets
// ---------------------------------------------------------------------------

interface GloveAssets {
  segment: THREE.CylinderGeometry;
  joint: THREE.SphereGeometry;
  box: THREE.BoxGeometry;
  mitt: THREE.SphereGeometry;
  cuff: THREE.CylinderGeometry;
  glove: THREE.MeshPhysicalMaterial;
  strap: THREE.MeshStandardMaterial;
  gold: THREE.MeshStandardMaterial;
}

function makeAssets(): GloveAssets {
  return {
    segment: new THREE.CylinderGeometry(1, 1, 1, 10, 1),
    joint: new THREE.SphereGeometry(1, 10, 8),
    box: new THREE.BoxGeometry(1, 1, 1),
    mitt: new THREE.SphereGeometry(1, 14, 10),
    cuff: new THREE.CylinderGeometry(1, 1.08, 1, 14, 1),
    // Deep red lacquer: oxblood base under a RESTRAINED clearcoat. The
    // first pass (clearcoat 0.9 / ccRoughness 0.25) read as a candy-apple
    // billiard ball under the FP fill; worn lacquer wants a broad soft
    // sheen, not a mirror hotspot.
    glove: new THREE.MeshPhysicalMaterial({
      color: GLOVE_BASE_COLOR,
      roughness: 0.68,
      metalness: 0.0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.5,
    }),
    strap: new THREE.MeshStandardMaterial({
      color: GLOVE_STRAP_COLOR,
      roughness: 0.9,
      metalness: 0.0,
    }),
    gold: new THREE.MeshStandardMaterial({
      color: GLOVE_CUFF_COLOR,
      metalness: 0.6,
      roughness: 0.45,
    }),
  };
}

// ---------------------------------------------------------------------------
// Per-hand rig
// ---------------------------------------------------------------------------

const ZERO_AIM: Vec3 = { x: 0, y: 0, z: 0 };
/** Scratch wrist point with the rest-drop bias applied (no allocation). */
const _wristDropped: Vec3 = { x: 0, y: 0, z: 0 };
const _camQuat = new THREE.Quaternion();
const _target = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _fillOffset = new THREE.Vector3();

class GloveRig {
  readonly group = new THREE.Group();
  /** 0..1 eased visibility. */
  presence = 0;

  private readonly shape: Vec3[];
  private readonly segments: THREE.Mesh[] = [];
  private readonly joints: THREE.Mesh[] = [];
  private readonly palm: THREE.Mesh;
  private readonly cuff: THREE.Mesh;
  private posed = false;
  private readonly prevTarget = new THREE.Vector3();
  private hasPrev = false;

  constructor(name: string, assets: GloveAssets) {
    this.group.name = name;
    this.group.visible = false;
    this.shape = Array.from({ length: HAND_LANDMARK_COUNT }, () => ({ x: 0, y: 0, z: 0 }));

    for (let k = 0; k < FINGER_SEGMENTS.length; k++) {
      const m = new THREE.Mesh(assets.segment, assets.glove);
      m.castShadow = false;
      m.receiveShadow = false;
      this.segments.push(m);
      this.group.add(m);
    }
    // Knuckle caps at every non-wrist landmark; radius follows the thicker
    // adjoining segment so bends stay filled.
    for (let lm = 1; lm < HAND_LANDMARK_COUNT; lm++) {
      const m = new THREE.Mesh(assets.joint, assets.glove);
      m.castShadow = false;
      m.receiveShadow = false;
      this.joints.push(m);
      this.group.add(m);
    }

    // Palm block with mitt bulge and two binding straps as children (they
    // inherit the palm's per-frame scale and basis orientation).
    this.palm = new THREE.Mesh(assets.box, assets.glove);
    this.palm.castShadow = false;
    const mitt = new THREE.Mesh(assets.mitt, assets.glove);
    mitt.castShadow = false;
    // Teardrop, not a ball: wider than tall, longest along the fingers so
    // it swallows the MCP knuckle row and tapers toward the wrist. The
    // mitt silhouette, not the knuckle spheres, defines the glove; the
    // straps and palm box must stay INSIDE it (anything poking below the
    // dome reads as a plate the glove sits on in the POV shots).
    // Local y is exaggerated (0.92) against the palm's squeezed y scale so
    // the mitt keeps its absolute height while the palm BOX shrinks fully
    // inside the dome; poking box corners read as a plate under the glove.
    mitt.scale.set(0.72, 0.92, 1.3);
    mitt.position.set(0, 0.17, 0);
    this.palm.add(mitt);
    const strapA = new THREE.Mesh(assets.box, assets.strap);
    strapA.castShadow = false;
    strapA.scale.set(0.9, 0.16, 1.2);
    strapA.position.set(0, 0.16, 0);
    this.palm.add(strapA);
    const strapB = new THREE.Mesh(assets.box, assets.strap);
    strapB.castShadow = false;
    strapB.scale.set(0.82, 0.12, 1.05);
    strapB.position.set(0, -0.14, 0);
    strapB.rotation.z = 0.06;
    this.palm.add(strapB);
    this.group.add(this.palm);

    this.cuff = new THREE.Mesh(assets.cuff, assets.gold);
    this.cuff.castShadow = false;
    this.group.add(this.cuff);
  }

  update(hand: HandFrame | null, dt: number, camera: THREE.PerspectiveCamera): void {
    const appearing = this.presence <= 0 && hand !== null;
    this.presence = presenceStep(this.presence, hand !== null, dt);
    this.group.visible = this.posed && this.presence > 0.001;
    const s = Math.max(this.presence, 1e-4);
    this.group.scale.setScalar(s);

    if (!hand) return;
    const wristScreen = hand.landmarks[LM.WRIST];
    if (!wristScreen) return;

    // --- Anchor on the reach plane (same mapping as the fire origin) ------
    // Biased slightly down-screen (GLOVE_REST_DROP) so resting hands sit
    // near the frame bottom; the fire keeps spawning from the true wrist.
    _wristDropped.x = wristScreen.x;
    _wristDropped.y = wristScreen.y + GLOVE_REST_DROP;
    _wristDropped.z = wristScreen.z;
    const mapped = screenToWorld(_wristDropped, ZERO_AIM, camera);
    _target.copy(mapped.origin);
    camera.getWorldQuaternion(_camQuat);

    if (appearing || !this.hasPrev) {
      this.group.position.copy(_target);
      this.group.quaternion.copy(_camQuat);
      this.prevTarget.copy(_target);
      this.hasPrev = true;
    } else {
      // Velocity-proportional lead (follow-through), then critically-damped
      // exponential follow toward the led target.
      if (dt > 0) {
        _vel.subVectors(_target, this.prevTarget).divideScalar(dt);
        this.prevTarget.copy(_target);
        _target.addScaledVector(_vel, GLOVE_OVERSHOOT);
      }
      const alpha = followAlpha(dt);
      this.group.position.lerp(_target, alpha);
      this.group.quaternion.slerp(_camQuat, alpha);
    }

    // --- Direct finger/palm pose from shape landmarks ---------------------
    const shape = shapeLandmarks(hand, this.shape);
    for (let k = 0; k < FINGER_SEGMENTS.length; k++) {
      const pair = FINGER_SEGMENTS[k];
      const mesh = this.segments[k];
      if (!pair || !mesh) continue;
      const a = shape[pair[0]];
      const b = shape[pair[1]];
      if (!a || !b) continue;
      mesh.position.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
      segmentOrientation(a, b, mesh.quaternion);
      const r = segmentRadius(k);
      mesh.scale.set(r, Math.max(dist(a, b), 1e-3), r);
    }
    for (let lm = 1; lm < HAND_LANDMARK_COUNT; lm++) {
      const mesh = this.joints[lm - 1];
      const p = shape[lm];
      if (!mesh || !p) continue;
      mesh.position.set(p.x, p.y, p.z);
      // Joint sphere just fills the bend gap; anything fatter than the
      // segment pokes through the mitt and reads as a blackberry cluster
      // in the POV shots.
      mesh.scale.setScalar(segmentRadius(JOINT_SEGMENT_INDEX[lm] ?? 3) * 0.92);
    }

    const idx = shape[LM.INDEX_MCP];
    const pnk = shape[LM.PINKY_MCP];
    const mid = shape[LM.MIDDLE_MCP];
    if (idx && pnk && mid) {
      const width = Math.max(dist(idx, pnk) * 1.5, 0.05) * GLOVE_SIZE_SCALE;
      const height = Math.max(Math.sqrt(mid.x * mid.x + mid.y * mid.y + mid.z * mid.z), 0.05);
      const depth = 0.042 * GLOVE_SIZE_SCALE;
      this.palm.position.set(
        (idx.x + pnk.x) * 0.5 * 0.55,
        (idx.y + pnk.y) * 0.5 * 0.55,
        (idx.z + pnk.z) * 0.5 * 0.55,
      );
      // The box hides inside the mitt (its bottom corners must not poke
      // out below the dome).
      this.palm.scale.set(width * 0.7, height * 0.5, depth);
      handBasisQuaternion(shape, this.palm.quaternion);

      // Gold cuff: a SHORT trim ring tucked up against the mitt base, a
      // little above the wrist along the hand's "up" axis. Anything wider,
      // taller or lower reads as a pedestal the glove sits on (the arena
      // shots made them look like pots on stands).
      this.cuff.position.set(mid.x * 0.12, mid.y * 0.12, mid.z * 0.12);
      this.cuff.quaternion.copy(this.palm.quaternion);
      // Narrower than the mitt and squat: the cuff is trim, not a stand.
      this.cuff.scale.set(width * 0.22, 0.022, width * 0.22);
    }

    this.posed = true;
    this.group.visible = this.presence > 0.001;
  }
}

// ---------------------------------------------------------------------------
// GloveSystem
// ---------------------------------------------------------------------------

export class GloveSystem {
  readonly group = new THREE.Group();
  private readonly leftRig: GloveRig;
  private readonly rightRig: GloveRig;
  private readonly assets: GloveAssets;
  private chargeLight: FireLightHandle | null = null;
  private readonly fill: THREE.PointLight;
  private readonly tmp = new THREE.Vector3();

  constructor(
    parent: THREE.Object3D,
    private readonly fire: FireSystem,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.assets = makeAssets();
    this.group.name = 'gloves';
    this.leftRig = new GloveRig('glove-left', this.assets);
    this.rightRig = new GloveRig('glove-right', this.assets);
    this.group.add(this.leftRig.group, this.rightRig.group);

    // First-person fill: the arena key rakes from the coal wall AHEAD, so
    // the camera-facing side of the gloves is the unlit side and they read
    // as silhouettes without help. A small warm fill floating just behind
    // and above the gloves (world-consistent: the nearest braziers flank
    // the player) models the knuckles and lets the lacquer read. This is
    // the 8th and final dynamic light in the Section 14 budget (key 1 +
    // braziers 4 + fire pool 2 + this).
    this.fill = new THREE.PointLight(GLOVE_FILL_COLOR, GLOVE_FILL_INTENSITY, 2.4, 2);
    this.fill.name = 'glove-fill';
    this.fill.visible = false;
    this.group.add(this.fill);
    parent.add(this.group);
  }

  /**
   * Advance both gloves for one frame of world time. `frame` is the latest
   * processed LandmarkFrame (null when none has arrived yet);
   * `chargeActive` mirrors fx.chargeActive for the between-fists light.
   */
  update(dt: number, frame: LandmarkFrame | null, chargeActive: boolean): void {
    this.leftRig.update(frame?.left ?? null, dt, this.camera);
    this.rightRig.update(frame?.right ?? null, dt, this.camera);

    // Keep the fill hovering above the midpoint of whatever gloves are
    // present, nudged toward the camera so the near faces get the light.
    const lOn = this.leftRig.presence > 0.05;
    const rOn = this.rightRig.presence > 0.05;
    this.fill.visible = lOn || rOn;
    if (this.fill.visible) {
      if (lOn && rOn) {
        this.tmp
          .copy(this.leftRig.group.position)
          .add(this.rightRig.group.position)
          .multiplyScalar(0.5);
      } else {
        this.tmp.copy(lOn ? this.leftRig.group.position : this.rightRig.group.position);
      }
      _fillOffset.set(0, 0.22, 0.3).applyQuaternion(this.camera.quaternion);
      this.fill.position.copy(this.tmp).add(_fillOffset);
    }

    // ONE pooled light between the fists while a charge is exposed. The
    // pool recycles under pressure, so a dead handle is simply re-acquired.
    const leftOn = this.leftRig.presence > 0.5;
    const rightOn = this.rightRig.presence > 0.5;
    if (chargeActive && (leftOn || rightOn)) {
      if (leftOn && rightOn) {
        this.tmp
          .copy(this.leftRig.group.position)
          .add(this.rightRig.group.position)
          .multiplyScalar(0.5);
      } else {
        this.tmp.copy(leftOn ? this.leftRig.group.position : this.rightRig.group.position);
      }
      if (!this.chargeLight || !this.chargeLight.alive) {
        this.chargeLight = this.fire.lights.acquire(
          this.tmp,
          GLOVE_CHARGE_LIGHT_INTENSITY,
          GLOVE_CHARGE_LIGHT_RADIUS,
        );
      }
      this.chargeLight.move(this.tmp);
    } else if (this.chargeLight) {
      this.chargeLight.release();
      this.chargeLight = null;
    }
  }

  dispose(): void {
    this.chargeLight?.release();
    this.chargeLight = null;
    this.group.parent?.remove(this.group);
    this.assets.segment.dispose();
    this.assets.joint.dispose();
    this.assets.box.dispose();
    this.assets.mitt.dispose();
    this.assets.cuff.dispose();
    this.assets.glove.dispose();
    this.assets.strap.dispose();
    this.assets.gold.dispose();
  }
}
