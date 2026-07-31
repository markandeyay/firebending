/**
 * Glove rig math (Phase 2, Task 2b): pure-function tests for the in-world
 * glove system. No WebGL, no DOM: segment orientation, curl response,
 * presence easing, and shapeLandmarks' world-landmark preference.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FINGER_SEGMENTS,
  GLOVE_EASE_SEC,
  HAND_SIZE_M,
  PALM_ASPECT,
  PALM_WRIST_TAPER,
  SEGMENT_TAPER,
  followAlpha,
  handBasisQuaternion,
  jointRadius,
  makePalmGeometry,
  palmDimensions,
  presenceStep,
  segmentOrientation,
  segmentRadius,
  shapeLandmarks,
  thumbRadialSign,
} from '../src/vfx/gloves';
import type { HandFrame, Vec3 } from '../src/tracking/types';
import { HAND_LANDMARK_COUNT, LM } from '../src/tracking/types';

function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/** Synthetic 21-landmark hand: wrist at `wrist`, fingers fanned upward in
 * screen space (y DOWN toward the wrist, i.e. fingertips at smaller y). */
function syntheticHand(wrist: Vec3, span = 0.1): HandFrame {
  const landmarks: Vec3[] = [];
  for (let i = 0; i < HAND_LANDMARK_COUNT; i++) {
    // Rough tree: each finger chain climbs -y, spreads +-x by finger index.
    const finger = i === 0 ? 0 : Math.floor((i - 1) / 4);
    const along = i === 0 ? 0 : ((i - 1) % 4) + 1;
    landmarks.push(
      vec(
        wrist.x + (finger - 2) * 0.02,
        wrist.y - along * (span / 4),
        wrist.z - along * 0.005,
      ),
    );
  }
  return { landmarks, confidence: 1 };
}

describe('segmentOrientation', () => {
  it('is identity for a +Y segment (the mesh axis)', () => {
    const q = segmentOrientation(vec(0, 0, 0), vec(0, 1, 0));
    expect(q.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
  });

  it('aligns the Y axis onto the segment direction', () => {
    const q = segmentOrientation(vec(0.1, 0.2, 0.3), vec(0.4, 0.2, 0.3));
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(y.x).toBeCloseTo(1, 6);
    expect(y.y).toBeCloseTo(0, 6);
    expect(y.z).toBeCloseTo(0, 6);
  });

  it('yields identity for a degenerate (zero-length) segment', () => {
    const q = segmentOrientation(vec(0.5, 0.5, 0.5), vec(0.5, 0.5, 0.5));
    expect(q.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
  });
});

describe('curl response', () => {
  it('bends the knuckle: quaternion angle between proximal and middle segments grows when the fingertip curls', () => {
    const mcp = vec(0, 0, 0);
    const pip = vec(0, 0.03, 0);
    const dipStraight = vec(0, 0.06, 0);
    const dipCurled = vec(0, 0.05, 0.02);

    const proximal = segmentOrientation(mcp, pip);
    const straight = segmentOrientation(pip, dipStraight);
    const curled = segmentOrientation(pip, dipCurled);

    expect(proximal.angleTo(straight)).toBeCloseTo(0, 6);
    const bend = proximal.angleTo(curled);
    expect(bend).toBeGreaterThan(0.3); // a visible knuckle bend
    expect(bend).toBeCloseTo(Math.atan2(0.02, 0.02), 5);
  });
});

describe('presence easing', () => {
  it('eases out over GLOVE_EASE_SEC instead of popping', () => {
    let p = 1;
    p = presenceStep(p, false, GLOVE_EASE_SEC / 2);
    expect(p).toBeCloseTo(0.5, 6);
    p = presenceStep(p, false, GLOVE_EASE_SEC / 2);
    expect(p).toBeCloseTo(0, 6);
    // Clamped at zero, then eases back in when the hand returns.
    p = presenceStep(p, false, GLOVE_EASE_SEC);
    expect(p).toBe(0);
    p = presenceStep(p, true, GLOVE_EASE_SEC / 3);
    expect(p).toBeGreaterThan(0.3);
    expect(p).toBeLessThan(0.4);
    p = presenceStep(p, true, GLOVE_EASE_SEC);
    expect(p).toBe(1);
  });
});

describe('shapeLandmarks', () => {
  it('prefers world landmarks (already metric) and re-bases on the wrist', () => {
    const hand = syntheticHand(vec(0.5, 0.5, 0));
    hand.world = Array.from({ length: HAND_LANDMARK_COUNT }, (_, i) =>
      vec(0.01 * i, -0.005 * i, 0.002 * i),
    );
    // Give the wrist a non-zero origin so re-basing is observable.
    hand.world[LM.WRIST] = vec(0.1, 0.2, 0.05);
    const shape = shapeLandmarks(hand);
    const mid = shape[LM.MIDDLE_MCP];
    const w = hand.world[LM.MIDDLE_MCP];
    expect(mid).toBeDefined();
    expect(w).toBeDefined();
    if (!mid || !w) return;
    // Wrist-origin, y and z flipped into render space, NO extra scaling.
    expect(shape[LM.WRIST]).toEqual({ x: 0, y: -0, z: -0 });
    expect(mid.x).toBeCloseTo(w.x - 0.1, 9);
    expect(mid.y).toBeCloseTo(-(w.y - 0.2), 9);
    expect(mid.z).toBeCloseTo(-(w.z - 0.05), 9);
  });

  it('falls back to screen landmarks normalized to a real hand size', () => {
    const hand = syntheticHand(vec(0.5, 0.5, 0));
    const shape = shapeLandmarks(hand);
    const mid = shape[LM.MIDDLE_MCP];
    expect(mid).toBeDefined();
    if (!mid) return;
    // Wrist-to-middle-MCP must come out at exactly HAND_SIZE_M.
    const len = Math.sqrt(mid.x * mid.x + mid.y * mid.y + mid.z * mid.z);
    expect(len).toBeCloseTo(HAND_SIZE_M, 9);
    // Screen y grows DOWN; fingers point up-screen, so render y is positive.
    expect(mid.y).toBeGreaterThan(0);
  });

  it('writes into a provided out array without allocating', () => {
    const hand = syntheticHand(vec(0.4, 0.6, 0));
    const out: Vec3[] = Array.from({ length: HAND_LANDMARK_COUNT }, () =>
      vec(9, 9, 9),
    );
    const result = shapeLandmarks(hand, out);
    expect(result).toBe(out);
    expect(out[LM.WRIST]).toEqual({ x: 0, y: -0, z: -0 });
  });
});

describe('handBasisQuaternion', () => {
  it('points local +Y along wrist->middleMCP', () => {
    const hand = syntheticHand(vec(0.5, 0.5, 0));
    const shape = shapeLandmarks(hand);
    const q = handBasisQuaternion(shape);
    const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const mid = shape[LM.MIDDLE_MCP];
    if (!mid) throw new Error('missing middle MCP');
    const dir = new THREE.Vector3(mid.x, mid.y, mid.z).normalize();
    expect(yAxis.dot(dir)).toBeCloseTo(1, 5);
  });

  it('is identity on degenerate input', () => {
    const collapsed: Vec3[] = Array.from(
      { length: HAND_LANDMARK_COUNT },
      () => vec(0, 0, 0),
    );
    const q = handBasisQuaternion(collapsed);
    expect(q.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
  });
});

describe('rig plumbing constants', () => {
  it('has exactly 15 finger segments over consecutive landmark pairs', () => {
    expect(FINGER_SEGMENTS.length).toBe(15);
    for (const [a, b] of FINGER_SEGMENTS) {
      expect(b).toBe(a + 1); // MediaPipe chains are index-consecutive
    }
  });

  it('followAlpha is 0 at dt=0 and approaches 1 for large dt', () => {
    expect(followAlpha(0)).toBe(0);
    expect(followAlpha(0.008)).toBeGreaterThan(0);
    expect(followAlpha(0.008)).toBeLessThan(followAlpha(0.016));
    expect(followAlpha(5)).toBeCloseTo(1, 6);
  });
});

describe('finger taper', () => {
  it('tapers finger radii proximal 1.0 / middle 0.82 / distal 0.66', () => {
    // Index finger is segments 3, 4, 5; every finger shares the ratios.
    for (const base of [3, 6, 9, 12]) {
      expect(segmentRadius(base + 1) / segmentRadius(base)).toBeCloseTo(0.82, 9);
      expect(segmentRadius(base + 2) / segmentRadius(base)).toBeCloseTo(0.66, 9);
    }
  });

  it('makes the thumb thicker than the fingers and merges its metacarpal into the palm as the thickest wedge', () => {
    expect(segmentRadius(1)).toBeGreaterThan(segmentRadius(3)); // thumb proximal > finger proximal
    expect(segmentRadius(2)).toBeGreaterThan(segmentRadius(5)); // thumb distal > finger distal
    expect(segmentRadius(2)).toBeLessThan(segmentRadius(1)); // thumb still tapers
    for (let k = 1; k < FINGER_SEGMENTS.length; k++) {
      expect(segmentRadius(0)).toBeGreaterThan(segmentRadius(k)); // thenar wedge
    }
  });
});

describe('joint-size rule', () => {
  it('sizes every joint to the SMALLER adjoining segment radius at that joint', () => {
    // A segment presents its proximal radius at pair[0] and its tapered
    // SEGMENT_TAPER radius at pair[1]; the joint takes the minimum.
    for (let lm = 1; lm < HAND_LANDMARK_COUNT; lm++) {
      const presented: number[] = [];
      FINGER_SEGMENTS.forEach(([a, b], k) => {
        if (a === lm) presented.push(segmentRadius(k));
        if (b === lm) presented.push(segmentRadius(k) * SEGMENT_TAPER);
      });
      expect(jointRadius(lm)).toBeCloseTo(Math.min(...presented), 12);
    }
  });

  it('matches the knuckle row to finger thickness (MCP joint = proximal radius, no bulging)', () => {
    expect(jointRadius(LM.INDEX_MCP)).toBeCloseTo(segmentRadius(3), 12);
    expect(jointRadius(LM.PINKY_MCP)).toBeCloseTo(segmentRadius(12), 12);
  });

  it('caps fingertips at the narrowed tip radius of the distal frustum', () => {
    expect(jointRadius(LM.INDEX_TIP)).toBeCloseTo(segmentRadius(5) * SEGMENT_TAPER, 12);
  });

  it('gives the wrist (no adjoining segment) a zero radius', () => {
    expect(jointRadius(LM.WRIST)).toBe(0);
  });
});

describe('palmDimensions', () => {
  it('locks the slab to ~3:1 width to thickness and spans wrist to the MCP row', () => {
    const shape = shapeLandmarks(syntheticHand(vec(0.5, 0.5, 0)));
    const dims = palmDimensions(shape);
    expect(dims).not.toBeNull();
    if (!dims) return;
    expect(dims.width / dims.thickness).toBeCloseTo(PALM_ASPECT, 9);
    expect(dims.width).toBeGreaterThan(dims.thickness);
    const mid = shape[LM.MIDDLE_MCP];
    if (!mid) throw new Error('missing middle MCP');
    const up = Math.hypot(mid.x, mid.y, mid.z);
    expect(dims.height).toBeCloseTo(up * 1.08, 9);
    // Center: halfway between the wrist origin and the MCP row midpoint.
    const idx = shape[LM.INDEX_MCP];
    const pnk = shape[LM.PINKY_MCP];
    if (!idx || !pnk) throw new Error('missing MCPs');
    expect(dims.center.x).toBeCloseTo((idx.x + pnk.x) * 0.25, 9);
    expect(dims.center.y).toBeCloseTo((idx.y + pnk.y) * 0.25, 9);
    expect(dims.center.z).toBeCloseTo((idx.z + pnk.z) * 0.25, 9);
  });

  it('returns null on a degenerate (collapsed) hand', () => {
    const collapsed: Vec3[] = Array.from(
      { length: HAND_LANDMARK_COUNT },
      () => vec(0, 0, 0),
    );
    expect(palmDimensions(collapsed)).toBeNull();
  });
});

describe('thumb offset side', () => {
  it('puts the thumb off the radial (index) side of the knuckle axis', () => {
    // The crude synthetic fan puts the wrist in the thumb's column, so
    // push the thumb chain out past the index side like a real hand.
    const hand = syntheticHand(vec(0.5, 0.5, 0));
    for (let i = LM.THUMB_CMC; i <= LM.THUMB_TIP; i++) {
      const lm = hand.landmarks[i];
      if (lm) lm.x -= 0.03;
    }
    expect(thumbRadialSign(shapeLandmarks(hand))).toBe(-1);
  });

  it('flips to +1 when the thumb sits past the pinky side (mis-tracked hand)', () => {
    const hand = syntheticHand(vec(0.5, 0.5, 0));
    for (let i = LM.THUMB_CMC; i <= LM.THUMB_TIP; i++) {
      const lm = hand.landmarks[i];
      if (lm) lm.x += 0.2;
    }
    expect(thumbRadialSign(shapeLandmarks(hand))).toBe(1);
  });

  it('is 0 on degenerate input', () => {
    const collapsed: Vec3[] = Array.from(
      { length: HAND_LANDMARK_COUNT },
      () => vec(0, 0, 0),
    );
    expect(thumbRadialSign(collapsed)).toBe(0);
  });
});

describe('makePalmGeometry', () => {
  it('is a unit-normalized slab, wider at the knuckle end than the wrist end', () => {
    const geo = makePalmGeometry();
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    expect(bb).not.toBeNull();
    if (!bb) return;
    expect(bb.max.x - bb.min.x).toBeCloseTo(1, 5);
    expect(bb.max.y - bb.min.y).toBeCloseTo(1, 5);
    expect(bb.max.z - bb.min.z).toBeCloseTo(1, 5);
    // Taper: silhouette half-width near the knuckle edge (y > 0.35) beats
    // the half-width near the wrist edge (y < -0.35).
    const pos = geo.getAttribute('position');
    let topW = 0;
    let botW = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = Math.abs(pos.getX(i));
      const y = pos.getY(i);
      if (y > 0.35) topW = Math.max(topW, x);
      else if (y < -0.35) botW = Math.max(botW, x);
    }
    expect(botW).toBeLessThan(topW);
    // The wrist end lands near PALM_WRIST_TAPER of the knuckle width
    // (bevel rounding shifts it slightly).
    expect(botW / topW).toBeGreaterThan(PALM_WRIST_TAPER - 0.12);
    expect(botW / topW).toBeLessThan(PALM_WRIST_TAPER + 0.22);
    geo.dispose();
  });
});
