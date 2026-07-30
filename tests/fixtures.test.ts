/**
 * T002 + T004: fixture generator validity, pose plausibility, and the
 * end-to-end replay harness (generated JSON loaded from disk via node fs and
 * driven through ReplaySource). No camera anywhere near this file.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ReplaySource } from '../src/tracking/replaySource';
import { HAND_LANDMARK_COUNT, LM } from '../src/tracking/types';
import type { HandFrame, LandmarkFrame, LandmarkRecording, Vec3 } from '../src/tracking/types';
import { POSES, dist, generateRecording, placePose, vec } from '../fixtures/lib';
import { FIXTURE_SPECS, buildAllRecordings } from '../fixtures/specs';

const SYNTHETIC_DIR = new URL('../fixtures/synthetic/', import.meta.url);

const EXPECTED_LABELS = [
  'jab-left',
  'jab-right',
  'fire-stream',
  'cross-combo',
  'palm-wave',
  'flame-fan',
  'twin-cannon',
  'rising-flame',
  'fire-whip',
  'breath-charge',
  'idle-rest',
  'talking-hands',
  'slow-reach',
  'hand-enter-leave',
  'fidget',
];

let recordings: LandmarkRecording[] = [];

function byLabel(label: string): LandmarkRecording {
  const rec = recordings.find((r) => r.label === label);
  if (!rec) throw new Error(`missing fixture ${label}`);
  return rec;
}

function frameNear(rec: LandmarkRecording, tMs: number): LandmarkFrame {
  const frame = rec.frames.find((f) => Math.abs(f.t - tMs) < 17);
  if (!frame) throw new Error(`${rec.label}: no frame near t=${tMs}`);
  return frame;
}

function mustHand(hand: HandFrame | null, what: string): HandFrame {
  if (!hand) throw new Error(`expected ${what} to be present`);
  return hand;
}

function landmark(hand: HandFrame, index: number): Vec3 {
  const lm = hand.landmarks[index];
  if (!lm) throw new Error(`missing landmark ${index}`);
  return lm;
}

/** Frame-to-frame wrist speeds in normalized units per second. */
function wristSpeeds(rec: LandmarkRecording, side: 'left' | 'right'): number[] {
  const speeds: number[] = [];
  for (let i = 1; i < rec.frames.length; i++) {
    const prev = rec.frames[i - 1];
    const cur = rec.frames[i];
    if (!prev || !cur) continue;
    const a = side === 'left' ? prev.left : prev.right;
    const b = side === 'left' ? cur.left : cur.right;
    if (!a || !b) continue;
    const dt = (cur.t - prev.t) / 1000;
    if (dt <= 0) continue;
    speeds.push(dist(landmark(a, LM.WRIST), landmark(b, LM.WRIST)) / dt);
  }
  return speeds;
}

/** Longest run of consecutive frames satisfying pred, in milliseconds. */
function longestRunMs(rec: LandmarkRecording, pred: (f: LandmarkFrame) => boolean): number {
  const frameDur = 1000 / rec.fps;
  let best = 0;
  let run = 0;
  for (const f of rec.frames) {
    run = pred(f) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best * frameDur;
}

beforeAll(() => {
  recordings = buildAllRecordings();
  // Write to disk so the harness tests below always load fresh files. This is
  // exactly what `npx tsx fixtures/generate.ts` writes (generation is seeded).
  mkdirSync(SYNTHETIC_DIR, { recursive: true });
  for (const rec of recordings) {
    writeFileSync(new URL(`${rec.label}.json`, SYNTHETIC_DIR), JSON.stringify(rec));
  }
});

describe('fixture generator output', () => {
  it('covers all 9 moves plus the 5 negative cases', () => {
    expect(recordings.map((r) => r.label).sort()).toEqual([...EXPECTED_LABELS].sort());
  });

  it('produces structurally valid recordings', () => {
    for (const rec of recordings) {
      expect(rec.version).toBe(1);
      expect(rec.fps).toBe(30);
      expect(rec.frames.length).toBeGreaterThan(30);
      let prevT = -1;
      for (const frame of rec.frames) {
        expect(Number.isFinite(frame.t)).toBe(true);
        if (prevT >= 0) {
          const dt = frame.t - prevT;
          expect(dt).toBeGreaterThan(30);
          expect(dt).toBeLessThan(37);
        }
        prevT = frame.t;
        for (const hand of [frame.left, frame.right]) {
          if (!hand) continue;
          expect(hand.landmarks).toHaveLength(HAND_LANDMARK_COUNT);
          expect(hand.confidence).toBeGreaterThan(0);
          expect(hand.confidence).toBeLessThanOrEqual(1);
          for (const lm of hand.landmarks) {
            expect(Number.isFinite(lm.x)).toBe(true);
            expect(Number.isFinite(lm.y)).toBe(true);
            expect(Number.isFinite(lm.z)).toBe(true);
            expect(lm.x).toBeGreaterThan(-0.3);
            expect(lm.x).toBeLessThan(1.3);
            expect(lm.y).toBeGreaterThan(-0.3);
            expect(lm.y).toBeLessThan(1.3);
          }
        }
      }
    }
  });

  it('includes a plausible neutral face frame on every frame', () => {
    for (const rec of recordings) {
      for (const frame of rec.frames) {
        expect(frame.face).not.toBeNull();
        if (!frame.face) continue;
        expect(Math.abs(frame.face.yaw)).toBeLessThan(0.15);
        expect(Math.abs(frame.face.pitch)).toBeLessThan(0.15);
        expect(frame.face.position.x).toBeGreaterThan(0.4);
        expect(frame.face.position.x).toBeLessThan(0.6);
        expect(frame.face.position.y).toBeGreaterThan(0.2);
        expect(frame.face.position.y).toBeLessThan(0.4);
        expect(frame.face.confidence).toBeGreaterThan(0.7);
        expect(frame.face.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic: regenerating a spec yields identical frames', () => {
    for (const spec of FIXTURE_SPECS) {
      expect(generateRecording(spec)).toEqual(generateRecording(spec));
    }
  });
});

describe('pose keyframe plausibility', () => {
  const wrist = vec(0, 0, 0);
  const fingers = [
    { mcp: LM.INDEX_MCP, tip: LM.INDEX_TIP },
    { mcp: LM.MIDDLE_MCP, tip: LM.MIDDLE_TIP },
    { mcp: LM.RING_MCP, tip: LM.RING_TIP },
    { mcp: LM.PINKY_MCP, tip: LM.PINKY_TIP },
  ];

  function local(pose: 'rest' | 'fist' | 'palm' | 'grip', index: number): Vec3 {
    const lm = POSES[pose][index];
    if (!lm) throw new Error(`pose ${pose} missing landmark ${index}`);
    return lm;
  }

  it('fist: every fingertip is curled in closer to the wrist than its knuckle', () => {
    for (const f of fingers) {
      const tip = dist(local('fist', f.tip), wrist);
      const mcp = dist(local('fist', f.mcp), wrist);
      expect(tip).toBeLessThan(mcp);
    }
  });

  it('palm: fingertips are far from the wrist, well past their knuckles', () => {
    for (const f of fingers) {
      const tip = dist(local('palm', f.tip), wrist);
      const mcp = dist(local('palm', f.mcp), wrist);
      expect(tip).toBeGreaterThan(mcp * 1.4);
    }
  });

  it('grip: fingers curled around a handle, thumb wrapped over them', () => {
    for (const f of fingers) {
      const tip = dist(local('grip', f.tip), wrist);
      const mcp = dist(local('grip', f.mcp), wrist);
      expect(tip).toBeLessThan(mcp);
    }
    // Thumb tip hugs the index PIP when wrapped; on an open palm it is far.
    const gripThumb = dist(local('grip', LM.THUMB_TIP), local('grip', LM.INDEX_PIP));
    const palmThumb = dist(local('palm', LM.THUMB_TIP), local('palm', LM.INDEX_PIP));
    expect(gripThumb).toBeLessThan(0.3);
    expect(palmThumb).toBeGreaterThan(0.3);
  });

  it('rest sits between fist and palm in fingertip extension', () => {
    for (const f of fingers) {
      const restTip = dist(local('rest', f.tip), wrist);
      expect(restTip).toBeGreaterThan(dist(local('fist', f.tip), wrist));
      expect(restTip).toBeLessThan(dist(local('palm', f.tip), wrist));
    }
  });

  it('placePose mirrors the thumb toward body center for the left hand', () => {
    const right = placePose('palm', vec(0.6, 0.6, -0.05), 'right');
    const left = placePose('palm', vec(0.4, 0.6, -0.05), 'left');
    const rThumb = right[LM.THUMB_TIP];
    const rWrist = right[LM.WRIST];
    const lThumb = left[LM.THUMB_TIP];
    const lWrist = left[LM.WRIST];
    if (!rThumb || !rWrist || !lThumb || !lWrist) throw new Error('missing landmarks');
    expect(rThumb.x).toBeLessThan(rWrist.x); // right thumb points toward center
    expect(lThumb.x).toBeGreaterThan(lWrist.x); // left thumb mirrored
  });

  it('generated frames keep the pose plausible despite noise', () => {
    // jab-right at full extension is a fist.
    const jabHand = mustHand(frameNear(byLabel('jab-right'), 680).right, 'jab-right fist');
    const jabWrist = landmark(jabHand, LM.WRIST);
    for (const f of fingers) {
      expect(dist(landmark(jabHand, f.tip), jabWrist)).toBeLessThan(
        dist(landmark(jabHand, f.mcp), jabWrist),
      );
    }
    // palm-wave at full extension is an open palm.
    const palmHand = mustHand(frameNear(byLabel('palm-wave'), 730).right, 'palm-wave palm');
    const palmWrist = landmark(palmHand, LM.WRIST);
    for (const f of fingers) {
      expect(dist(landmark(palmHand, f.tip), palmWrist)).toBeGreaterThan(
        dist(landmark(palmHand, f.mcp), palmWrist) * 1.2,
      );
    }
    // fire-whip during the raised hold is a grip.
    const gripHand = mustHand(frameNear(byLabel('fire-whip'), 600).right, 'fire-whip grip');
    const gripWrist = landmark(gripHand, LM.WRIST);
    for (const f of fingers) {
      expect(dist(landmark(gripHand, f.tip), gripWrist)).toBeLessThan(
        dist(landmark(gripHand, f.mcp), gripWrist) * 1.1,
      );
    }
  });
});

describe('motion profiles', () => {
  it('jab-right has a fast thrust toward the camera, then retracts', () => {
    const rec = byLabel('jab-right');
    expect(Math.max(...wristSpeeds(rec, 'right'))).toBeGreaterThan(1.5);
    const zs = rec.frames.map((f) => (f.right ? landmark(f.right, LM.WRIST).z : 0));
    expect(Math.min(...zs)).toBeLessThan(-0.22); // reaches toward the camera
    const last = rec.frames[rec.frames.length - 1];
    if (!last) throw new Error('empty recording');
    expect(landmark(mustHand(last.right, 'final right hand'), LM.WRIST).z).toBeGreaterThan(-0.1);
  });

  it('slow-reach covers similar distance with no speed spike', () => {
    const rec = byLabel('slow-reach');
    expect(Math.max(...wristSpeeds(rec, 'right'))).toBeLessThan(0.9);
    const zs = rec.frames.map((f) => (f.right ? landmark(f.right, LM.WRIST).z : 0));
    expect(Math.min(...zs)).toBeLessThan(-0.2); // it really does reach forward
  });

  it('fire-stream holds the fist extended much longer than a jab', () => {
    const extended = (f: LandmarkFrame): boolean =>
      f.right !== null && landmark(f.right, LM.WRIST).z < -0.25;
    expect(longestRunMs(byLabel('fire-stream'), extended)).toBeGreaterThan(500);
    expect(longestRunMs(byLabel('jab-right'), extended)).toBeLessThan(320);
  });

  it('twin-cannon holds both fists together at chest before the thrust', () => {
    const rec = byLabel('twin-cannon');
    const together = (f: LandmarkFrame): boolean =>
      f.left !== null &&
      f.right !== null &&
      dist(landmark(f.left, LM.WRIST), landmark(f.right, LM.WRIST)) < 0.13;
    expect(longestRunMs(rec, together)).toBeGreaterThan(300);
    // Joint thrust: both wrists reach toward the camera.
    const bothForward = rec.frames.some(
      (f) =>
        f.left !== null &&
        f.right !== null &&
        landmark(f.left, LM.WRIST).z < -0.25 &&
        landmark(f.right, LM.WRIST).z < -0.25,
    );
    expect(bothForward).toBe(true);
  });

  it('breath-charge parks both fists at hip height for at least 0.9 s', () => {
    const lowHold = (f: LandmarkFrame): boolean =>
      f.left !== null &&
      f.right !== null &&
      landmark(f.left, LM.WRIST).y > 0.8 &&
      landmark(f.right, LM.WRIST).y > 0.8;
    expect(longestRunMs(byLabel('breath-charge'), lowHold)).toBeGreaterThan(900);
  });

  it('rising-flame sweeps both palms upward fast', () => {
    const rec = byLabel('rising-flame');
    expect(Math.max(...wristSpeeds(rec, 'left'))).toBeGreaterThan(1.2);
    expect(Math.max(...wristSpeeds(rec, 'right'))).toBeGreaterThan(1.2);
    const ys = rec.frames.map((f) => (f.left ? landmark(f.left, LM.WRIST).y : 1));
    expect(Math.min(...ys)).toBeLessThan(0.4); // hands finish high (small y)
  });

  it('hand-enter-leave drops confidence, loses the hand, and recovers', () => {
    const rec = byLabel('hand-enter-leave');
    const lowConf = rec.frames.some((f) => f.right !== null && f.right.confidence < 0.5);
    expect(lowConf).toBe(true);
    const nullFrames = rec.frames.filter((f) => f.right === null).length;
    expect(nullFrames).toBeGreaterThanOrEqual(15);
    const last = rec.frames[rec.frames.length - 1];
    if (!last) throw new Error('empty recording');
    expect(last.right).not.toBeNull();
    // The left hand never leaves.
    expect(rec.frames.every((f) => f.left !== null)).toBe(true);
  });

  it('negative fixtures never show a jab-class speed spike', () => {
    for (const label of ['idle-rest', 'talking-hands', 'fidget'] as const) {
      const rec = byLabel(label);
      for (const side of ['left', 'right'] as const) {
        expect(Math.max(...wristSpeeds(rec, side))).toBeLessThan(1.2);
      }
    }
  });
});

describe('replay harness end to end (T004)', () => {
  it('loads generated JSON from disk and drives it through ReplaySource', () => {
    const raw = readFileSync(new URL('jab-right.json', SYNTHETIC_DIR), 'utf8');
    const rec = JSON.parse(raw) as LandmarkRecording;
    expect(rec.version).toBe(1);
    expect(rec.label).toBe('jab-right');

    const source = new ReplaySource(rec);
    const delivered: LandmarkFrame[] = [];
    source.onFrame((f) => delivered.push(f));
    source.drain();

    expect(delivered).toHaveLength(rec.frames.length);
    expect(source.done).toBe(true);
    const first = delivered[0];
    if (!first) throw new Error('no frames delivered');
    expect(first.t).toBe(0);
    for (let i = 1; i < delivered.length; i++) {
      const prev = delivered[i - 1];
      const cur = delivered[i];
      if (!prev || !cur) throw new Error('frame gap');
      expect(cur.t).toBeGreaterThan(prev.t);
    }

    // reset() rewinds cleanly for a second run.
    source.reset();
    expect(source.tick()?.t).toBe(0);
  });

  it('every fixture on disk replays completely', () => {
    for (const label of EXPECTED_LABELS) {
      const raw = readFileSync(new URL(`${label}.json`, SYNTHETIC_DIR), 'utf8');
      const rec = JSON.parse(raw) as LandmarkRecording;
      expect(rec.label).toBe(label);
      const source = new ReplaySource(rec);
      let count = 0;
      source.onFrame(() => count++);
      source.drain();
      expect(count).toBe(rec.frames.length);
      expect(count).toBe(source.frameCount);
    }
  });
});
