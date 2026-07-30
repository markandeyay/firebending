/**
 * Real-hand regression suite: scores the committed HaGRID landmark fixtures
 * (fixtures/hagrid/*.json, 300 hands per class extracted from the
 * cj-mills/hagrid-sample-500k-384p subset of HaGRID) with the live pose
 * scorers and asserts precision/recall floors at the operating thresholds.
 *
 * Floors sit slightly below the values measured at tuning time
 * (docs/hagrid-report.md) so the suite is robust to small fixture updates
 * while still catching constant regressions. Runs headless, no network.
 *
 * Threshold semantics mirror Hysteresis.update: a hand counts as detected
 * when score > threshold (strict), matching moves.ts entry counting.
 *
 * Grip caveat: HaGRID stills place hands anywhere in the frame, so grip is
 * evaluated shape-only by translating each hand so its wrist sits at
 * y = 0.5 (full credit from the raised-wrist factor). The raised-y band is
 * not exercised by this suite.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cross,
  fistScore,
  gripScore,
  lm,
  normalize,
  palmScore,
  sub,
} from '../src/gestures/poses';
import type { Handedness } from '../src/gestures/poses';
import type { HandFrame } from '../src/tracking/types';
import { HAND_LANDMARK_COUNT, LM } from '../src/tracking/types';

const FIXTURE_DIR = new URL('../fixtures/hagrid/', import.meta.url);

interface Sample {
  hand: HandFrame;
  handedness: Handedness;
}

const CLASSES = [
  'fist',
  'palm',
  'stop',
  'like',
  'ok',
  'one',
  'peace',
  'four',
  'rock',
  'call',
  'dislike',
  'stop_inverted',
  'mute',
  'no_gesture',
] as const;

type ClassName = (typeof CLASSES)[number];

function loadClass(name: ClassName): Sample[] {
  const raw = JSON.parse(
    readFileSync(new URL(`${name}.json`, FIXTURE_DIR), 'utf8')
  ) as Array<{
    landmarks: Array<{ x: number; y: number; z: number }>;
    confidence: number;
    handedness: Handedness;
  }>;
  return raw.map((r) => ({
    hand: { landmarks: r.landmarks, confidence: r.confidence },
    handedness: r.handedness,
  }));
}

const data = new Map<ClassName, Sample[]>(
  CLASSES.map((c) => [c, loadClass(c)])
);

/** Translate a hand so its wrist y is 0.5 (neutralizes grip's raised band). */
function atNeutralY(hand: HandFrame): HandFrame {
  const wrist = hand.landmarks[0];
  if (!wrist) throw new Error('missing wrist');
  const dy = 0.5 - wrist.y;
  return {
    landmarks: hand.landmarks.map((p) => ({ x: p.x, y: p.y + dy, z: p.z })),
    confidence: hand.confidence,
  };
}

function scores(
  classes: ClassName[],
  score: (s: Sample) => number
): number[] {
  return classes.flatMap((c) => data.get(c)!.map(score));
}

function precisionRecall(
  pos: number[],
  neg: number[],
  threshold: number
): { precision: number; recall: number } {
  const tp = pos.filter((x) => x > threshold).length;
  const fp = neg.filter((x) => x > threshold).length;
  return {
    precision: tp + fp > 0 ? tp / (tp + fp) : 1,
    recall: tp / pos.length,
  };
}

// The false-positive suite from the retuning brief. Per-pose geometric
// aliases are pulled out where the scorer cannot distinguish them by
// design (see docs/hagrid-report.md): dislike is a fist with the thumb
// down (fistScore ignores the thumb) and four is an open hand with the
// thumb folded (palmScore ignores the thumb).
const NEG_SUITE: ClassName[] = [
  'no_gesture',
  'ok',
  'one',
  'peace',
  'four',
  'rock',
  'call',
  'dislike',
  'stop_inverted',
  'mute',
];

const fistOf = (s: Sample) => fistScore(s.hand);
const palmOf = (s: Sample) => palmScore(s.hand, s.handedness);
const gripOf = (s: Sample) => gripScore(atNeutralY(s.hand));

describe('hagrid fixtures', () => {
  it('every class has 300 hands of 21 landmarks in player space', () => {
    for (const c of CLASSES) {
      const samples = data.get(c)!;
      expect(samples, c).toHaveLength(300);
      for (const s of samples) {
        expect(s.hand.landmarks, c).toHaveLength(HAND_LANDMARK_COUNT);
        for (const p of s.hand.landmarks) {
          expect(p.z, c).toBe(0);
          expect(Number.isFinite(p.x) && Number.isFinite(p.y), c).toBe(true);
        }
      }
    }
  });

  it('handedness mapping: open palms face the camera for both hands', () => {
    // Guards the leading_hand -> player-handedness join and the x-mirror:
    // if either were flipped, the facing sign would come out negative.
    for (const cls of ['stop', 'palm'] as const) {
      const samples = data.get(cls)!;
      let facing = 0;
      for (const s of samples) {
        const wrist = lm(s.hand, LM.WRIST);
        const u = sub(lm(s.hand, LM.INDEX_MCP), wrist);
        const v = sub(lm(s.hand, LM.PINKY_MCP), wrist);
        const z = normalize(cross(u, v)).z;
        if ((s.handedness === 'right' ? z : -z) > 0) facing++;
      }
      expect(facing / samples.length, cls).toBeGreaterThanOrEqual(0.99);
    }
  });
});

describe('fistScore on real hands', () => {
  const pos = scores(['fist'], fistOf);
  const neg = scores(
    NEG_SUITE.filter((c) => c !== 'dislike'),
    fistOf
  );

  it('meets the precision/recall floors at the 0.75 enter level', () => {
    const { precision, recall } = precisionRecall(pos, neg, 0.75);
    expect(precision).toBeGreaterThanOrEqual(0.93); // measured 0.943
    expect(recall).toBeGreaterThanOrEqual(0.99); // measured 1.000
  });

  it('holds recall at the 0.55 exit level', () => {
    const { recall } = precisionRecall(pos, neg, 0.55);
    expect(recall).toBeGreaterThanOrEqual(0.99); // measured 1.000
  });
});

describe('palmScore on real hands', () => {
  const pos = scores(['palm', 'stop'], palmOf);
  const negSeparable = scores(
    NEG_SUITE.filter((c) => c !== 'four' && c !== 'no_gesture'),
    palmOf
  );
  const negNoFour = scores(
    NEG_SUITE.filter((c) => c !== 'four'),
    palmOf
  );

  it('meets the floors at the 0.75 enter level (separable distractors)', () => {
    const { precision, recall } = precisionRecall(pos, negSeparable, 0.75);
    expect(precision).toBeGreaterThanOrEqual(0.96); // measured 0.979
    expect(recall).toBeGreaterThanOrEqual(0.91); // measured 0.932
  });

  it('stays precise with no_gesture included (open-hand aliases remain)', () => {
    const { precision } = precisionRecall(pos, negNoFour, 0.75);
    expect(precision).toBeGreaterThanOrEqual(0.93); // measured 0.946
  });

  it('rejects back-of-hand open palms (stop_inverted)', () => {
    const inv = scores(['stop_inverted'], palmOf);
    expect(inv.filter((x) => x > 0.55).length / inv.length).toBeLessThanOrEqual(
      0.01
    );
  });

  it('holds recall at the 0.55 exit level', () => {
    const { recall } = precisionRecall(pos, negSeparable, 0.55);
    expect(recall).toBeGreaterThanOrEqual(0.94); // measured 0.958
  });
});

describe('gripScore (shape-only) on real hands', () => {
  const pos = scores(['like'], gripOf);
  const neg = scores(NEG_SUITE, gripOf);

  it('meets the floors above the 0.75 shelf (recommended enter 0.78)', () => {
    // The 3-of-4-curled distractors (one/call/mute/rock/peace) saturate at
    // exactly 0.75, so precision cliffs upward just above it.
    const { precision, recall } = precisionRecall(pos, neg, 0.75);
    expect(precision).toBeGreaterThanOrEqual(0.94); // measured 0.960
    expect(recall).toBeGreaterThanOrEqual(0.6); // measured 0.647
  });

  it('is not fooled by thumbs-down (dislike)', () => {
    const dis = scores(['dislike'], gripOf);
    expect(dis.filter((x) => x > 0.45).length / dis.length).toBeLessThanOrEqual(
      0.01
    );
  });

  it('documents the fist alias: a real fist still passes the shape gate', () => {
    // Real fists tuck the thumb with its tip near index-PIP height, so the
    // rise factor cannot separate fist from thumbs-up (medians 0.57 vs
    // 0.48 hand-scale units). Whip safety comes from move context (static
    // raised hold + lateral swing), not the score margin. This assertion
    // pins the known aliasing so a silent behavior change is caught.
    const fist = scores(['fist'], gripOf);
    expect(fist.filter((x) => x > 0.75).length / fist.length).toBeGreaterThan(
      0.8
    );
  });
});
