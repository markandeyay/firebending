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
  followAlpha,
  handBasisQuaternion,
  presenceStep,
  segmentOrientation,
  segmentRadius,
  shapeLandmarks,
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

  it('tapers finger radius from proximal to distal and thickens the thumb', () => {
    expect(segmentRadius(0)).toBeGreaterThan(segmentRadius(3));
    expect(segmentRadius(3)).toBeGreaterThan(segmentRadius(4));
    expect(segmentRadius(4)).toBeGreaterThan(segmentRadius(5));
  });

  it('followAlpha is 0 at dt=0 and approaches 1 for large dt', () => {
    expect(followAlpha(0)).toBe(0);
    expect(followAlpha(0.008)).toBeGreaterThan(0);
    expect(followAlpha(0.008)).toBeLessThan(followAlpha(0.016));
    expect(followAlpha(5)).toBeCloseTo(1, 6);
  });
});
