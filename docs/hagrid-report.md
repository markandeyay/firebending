# HaGRID retuning report: static pose classifiers on real hands

The three static pose scorers in `src/gestures/poses.ts` (fistScore,
palmScore, gripScore) were originally tuned on synthetic geometry only. This
report documents retuning them against real human hands from the HaGRID
dataset (Kapitanov et al., CC-BY-SA-4.0), and what real data does and does
not support.

## Dataset subset and download budget

Target dataset: `cj-mills/hagrid-sample-500k-384p` on HuggingFace (509,323
images, a 384p sample of HaGRID v1 train_val). It ships as a single 13.4 GB
zip; nothing close to that was downloaded. Only annotations were fetched, no
images, and no inference was run.

Empirical finding: the sample's own `ann_train_val/*.json` files use the
HaGRID v1 schema (bboxes, labels, leading_hand, user_id) and contain **no
landmarks**. The landmarks therefore come from the official HaGRID
"annotations_with_landmarks" archive (linked from github.com/hukenovs/hagrid,
same dataset and license), whose val-split per-class JSONs carry
`hand_landmarks` (21 2D points per hand). The two sources were joined by
image id, restricted to ids actually present in the cj-mills sample zip
(verified against the zip's member listing), so the analyzed subset is
exactly HaGRID-500k-sample images.

Downloads (all via HTTP range requests into the two zips, cached):

| item | size |
| --- | --- |
| sample zip central directory (member listing, 509k entries) | ~87 MB |
| sample `ann_train_val/<class>.json`, 13 classes | ~131 MB |
| official annotations zip central directory | ~0.1 MB |
| official `annotations/val/<class>.json`, 13 classes (deflate) | ~38 MB |
| total | **~256 MB** (hard cap was 2 GB) |

Extraction: `tools/hagrid/extract.py` (with `tools/hagrid/rangezip.py`).
Analysis: `tools/hagrid/analyze.ts` and `tools/hagrid/features.ts`, run with
`npx tsx`, importing the real scorers from `src/gestures/poses.ts` (a
parametrized copy used for sweeps is parity-checked against the real
functions at every run).

## Classes and sample counts

Joined (unambiguous leading-hand attribution) per class: 2333 to 2654 hands;
no_gesture hands harvested from second hands inside the same images: 6853.
First 400 per class (sorted by image id) were analyzed; the first 300 per
class are committed as `fixtures/hagrid/<class>.json` (14 classes, 2.84 MB
total, coordinates rounded to 4 decimals).

Positives: fist -> fist; palm, stop -> palm; like -> grip (thumbs-up fist).
Negative suite: no_gesture, ok, one, peace, four, rock, call, dislike,
stop_inverted, mute.

## Format caveats verified empirically

1. **Landmark normalization**: `hand_landmarks` are normalized to the FULL
   image, not the hand bbox. Verified: on 500 fist entries, every wrist
   landmark falls inside its labeled bbox interpreted as full-image coords
   (554 hands checked, 0 outside).
2. **Dimensionality**: HaGRID landmarks are 2D. Fixtures carry z = 0 for
   every point. Consequences: the palm facing factor becomes a pure winding
   sign (normal.z is exactly +1 or -1), and finger-curl ratios are 2D
   projections (slightly foreshortened versus live MediaPipe 3D output).
3. **Handedness mapping validation**: fixtures map HaGRID v1 `leading_hand`
   directly to our player handedness ('right' means the player's own right
   hand) with the player-space mirror x -> 1 - x_image, y unchanged. On the
   open-palm classes the palmScore facing factor must then come out
   positive, and it does: **stop 300/300 (100%), palm 299/300 (99.7%)
   positive**. The direct (non-flipped) mapping is correct; no flip was
   needed.

## Method notes

- Threshold semantics match `Hysteresis.update`: a frame counts toward pose
  entry when score > threshold (strict). This matters: several distractors
  saturate at exactly 0.75 on fist/grip (3 of 4 fingers fully curled ->
  3/4 exactly) and a strict comparison keeps them out.
- Grip's raised-wrist factor cannot be exercised by stills (photo hands sit
  anywhere in the frame), so grip was evaluated shape-only: each hand is
  translated so its wrist sits at y = 0.5 before scoring. The
  GRIP_RAISED_Y_FULL/NONE band (0.55/0.65) is unchanged and **not tuned**.
- Static images can tune score LEVELS only. The frame-count windows (enter
  4 frames / exit 6 frames, grip smoothing) need motion recordings and are
  untouched.
- PALM_FACING_MIN/FULL are untunable from 2D data (facing is binary here)
  and are unchanged.

## Constants changed in poses.ts

| constant | old | new | driver |
| --- | --- | --- | --- |
| FIST_CURL_FULL_RATIO | 1.05 | 0.92 | real curled fingers project to ratio <= 0.95 (p95); tighter edge pushes half-curled no_gesture hands down |
| FIST_CURL_NONE_RATIO | 1.45 | 1.43 | keeps the synthetic half-curl fixture (ratio 1.32) partially credited; lower values break tests/poses.test.ts |
| PALM_EXT_NONE_RATIO | 1.15 | 1.3 | suppresses ok (curled index ratio ~1.3) while real palms sit >= 1.56 (p5) |
| PALM_EXT_FULL_RATIO | 1.55 | 1.65 | same |
| PALM_GAP_TIGHT | 0.35 | 0.55 | real HaGRID palms hold fingers apart (mean tip gap median 0.56, p75 0.63 hand-scale); old edges scored the median palm 0.54 |
| PALM_GAP_SPREAD | 0.8 | 1.0 | same |
| GRIP_THUMB_NEAR | 0.5 | 1.1 | real thumbs-up hold the thumb tip FAR from the index knuckles (median 0.74, p95 1.39); old edges gave the median like hand only 0.62 credit while giving every fist full credit |
| GRIP_THUMB_FAR | 1.0 | 1.7 | same; the factor is now a wild-thumb guard, not a fist separator |
| GRIP_THUMB_RISE_FULL | 0.5 | 0.4 | real thumbs-up rise is 0.41 at p25; lowering the full-credit edge recovers like recall |

Unchanged: PALM_FACING_MIN/FULL (untunable from 2D), GRIP_THUMB_RISE_MIN,
GRIP_RAISED_Y_FULL/NONE (untunable from stills), HANDS_TOGETHER_THRESHOLD
(out of scope).

Note: the prose docstrings in poses.ts still cite the old example numbers
(e.g. "ratio <= 1.05 scores 1"); only constant values were changed per the
task's file-ownership rule. A follow-up comment refresh is suggested.

## Before/after at the operating thresholds

All numbers on the committed fixtures (300 hands/class), strict score > t.
"Suite" = the 10-class negative suite above. Geometric aliases the scorer
ignores by design are split out rather than hidden in an average:
dislike is a fist with the thumb down (fistScore ignores the thumb), four
is an open hand with the thumb folded (palmScore ignores the thumb), and
open-hand no_gesture hands facing the camera are literal palms.

### fistScore (positives: fist; suite excludes dislike, reported separately)

| operating point | before | after |
| --- | --- | --- |
| enter 0.75: precision | 0.920 | **0.943** |
| enter 0.75: recall | 1.000 | **1.000** |
| exit 0.55: recall | 1.000 | 1.000 |
| enter 0.85: precision / recall | 0.932 / 0.997 | 0.961 / 0.997 |
| dislike scoring > 0.75 (alias) | 297/300 | 296/300 |
| with dislike counted a negative: precision at 0.75 | 0.482 | 0.489 |

The 0.95 precision target vs the full suite is unreachable for a
thumb-agnostic fist scorer because dislike IS a fist under its features;
excluding thumb-variant fists it is met at enter 0.85 (0.961) and nearly
met at 0.75 (0.943). Residual FPs are no_gesture hands that are genuinely
curled (11/300) plus mute foreshortening tails.

### palmScore (positives: palm + stop)

| operating point | before | after |
| --- | --- | --- |
| enter 0.75: recall | 0.653 | **0.932** |
| enter 0.75: precision vs suite minus four/no_gesture | 0.992 | **0.979** |
| enter 0.75: precision vs suite minus four | 0.945 | 0.946 |
| enter 0.75: precision vs full suite | 0.778 | 0.667 |
| exit 0.55: recall | 0.742 | 0.958 |
| stop_inverted (back of hand) > 0.55 | 0/300 | 0/300 |

The big win is recall: real palms hold fingers slightly apart and the old
gap edges rejected a third of them. Full-suite precision is structurally
capped by four (247/300 score > 0.75 after retune) and open-hand no_gesture
(20/300): both are geometrically our shield pose under a thumb-ignoring
scorer, and only a structural change (thumb feature) could separate them.
Against distractors the scorer can separate, precision is 0.98.

### gripScore, shape-only (positives: like; wrist translated to y 0.5)

| operating point | before | after |
| --- | --- | --- |
| enter 0.45 (current moves.ts): precision / recall | 0.158 / 0.423 | 0.181 / 0.857 |
| enter 0.55: precision / recall | 0.186 / 0.283 | 0.271 / 0.807 |
| enter 0.75: precision / recall | 0.750 / 0.060 | **0.960 / 0.647** |
| dislike (thumb down) > 0.45 | 1/300 | 1/300 |
| fist scoring > 0.75 (alias) | 268/300 | 285/300 |

## Recommended grip enter/exit for moves.ts (not applied here)

**Recommend GRIP_ENTER_SCORE 0.45 -> 0.78 and GRIP_EXIT_SCORE 0.28 ->
0.55.** Real-hand data shows a precision cliff just above 0.75: every
3-of-4-curled distractor (one, call, mute, rock, peace) saturates at
exactly 0.75, so at enter 0.78 the suite precision is 0.963 with like
recall 0.613, while at the current 0.45 the suite precision is 0.18 (one:
270/300 false positives, call: 240/300, mute: 199/300). The current low
thresholds date from synthetic grip vs fist being indistinguishable; real
data confirms fist remains inseparable (below) but shows the *other*
distractors are cleanly separable at 0.78. Exit 0.55 keeps 0.807 of like
hands above the exit level for hold stability.

Two caveats the swept stills cannot resolve:

1. **fist vs grip stays inseparable by shape.** Real fists tuck the thumb
   with the tip near index-PIP height, giving thumb-rise medians of 0.57
   (fist) vs 0.48 (like); the distributions overlap almost completely, and
   thumb-to-index distance separates them in the *opposite* direction from
   the synthetic geometry (fist near 0.22, like far 0.74). Values-only
   tuning cannot invert the factor without zeroing the synthetic grip
   fixture (thumb tip ON the index PIP, d = 0.07), which
   tests/poses.test.ts pins. Whip safety must keep coming from move
   context (static raised hold + lateral swing), as moves.ts already
   documents.
2. These are score LEVELS from stills; the 4-frame enter / 6-frame exit
   windows and GRIP_SMOOTH_FRAMES need motion data.

## Synthetic-fixture tensions

- FIST_CURL_NONE_RATIO wanted to go to ~1.35 for stronger no_gesture
  suppression (precision 0.943 -> 0.957 at enter 0.75) but the synthetic
  half-curl fixture (actual tip ratio 1.32, its comment says ~1.25) must
  keep fistScore > 0.1. Kept 1.43; cost about 0.4 precision points.
- GRIP_THUMB_NEAR/FAR could separate like from fist if inverted
  (crediting a FAR thumb), but the synthetic grip fixture places the thumb
  tip on the index PIP and must keep gripScore > 0.75. Kept the factor
  permissive instead (guard above 1.1); separation deferred to move
  context.
- tests/poses.test.ts, tests/moves.test.ts, tests/fixtures.test.ts and the
  new tests/hagridPoses.test.ts all pass with the applied constants.

## Regression suite

`tests/hagridPoses.test.ts` loads the committed fixtures and asserts the
handedness/facing validation plus per-pose precision/recall floors set
slightly below the measured values (e.g. fist precision >= 0.93 at 0.75,
palm separable-precision >= 0.96 and recall >= 0.91, grip precision >= 0.94
and recall >= 0.60 above the 0.75 shelf, dislike <= 1% at grip 0.45). It
runs headless in node with no network.

## Appendix (Round 3 Phase 4f): palmScore2D and the live-scorer switch

### Why a 2D palm scorer

The user reports palm poses are barely recognized LIVE while the same
constants score well here. The suspect is palmScore's facing factor:
`normal.z` of `normalize(cross(indexMCP - wrist, pinkyMCP - wrist))`. The
numerator of that z component is a pure 2D winding determinant, but the
NORMALIZATION divides by the full 3D cross-product length whose x/y
components are products of landmark z values. MediaPipe hand z is a
monocular depth guess (the reason z is banned from the motion loop, see
src/gestures/motion.ts); live z noise inflates the normal's x/y
components, deflates `normal.z`, and the facing smoothstep (0.1 -> 0.6)
then multiplies real palms down. HaGRID cannot exhibit this failure: its
landmarks are 2D, z is exactly 0, and facing degenerates to a binary
+1/-1 - which is precisely why the original retune could not tune the
facing edges. `palmScore2D` (src/gestures/poses.ts) removes z entirely:

1. extension: per-finger tip/MCP wrist-distance ratios from x/y only;
2. together: mean adjacent 2D fingertip gap / 2D hand scale;
3. winding: the raw signed 2D determinant / hand-scale^2 (the same
   winding information as the facing factor, positive iff the palm faces
   the camera, immune to z noise), smoothstepped 0.05 -> 0.35;
4. hull aspect: minor/major of the min-area rectangle over the 2D
   landmark convex hull (rotating calipers), smoothstepped 0.12 -> 0.25
   as a permissive guard against knife-thin edge-on silhouettes.

### Edge tuning (tools/hagrid/features.ts 2D block + analyze.ts sweeps)

Extension and gap edges carry over verbatim from palmScore (1.3/1.65,
0.55/1.0): HaGRID's z = 0 means those constants were ALREADY tuned on the
identical 2D quantities. Winding: palm p5 0.35 / stop p5 0.33 vs
stop_inverted p95 -0.40, no_gesture p75 -0.20, mute median 0.01. Swept
WIND_FULL over 0.15/0.25/0.35/0.40/0.45/0.55: 0.35 is the largest value
that keeps recall exactly at the 3D scorer's numbers at both hysteresis
levels while maximizing precision; 0.40 begins dropping recall (0.9233 at
enter 0.75). WIND_MIN 0.1 also nicks recall (0.9300), so 0.05 stays.
Aspect: palm p5 0.43, stop p5 0.28; ASPECT_FULL 0.35 drops recall to
0.9100 (narrow real stop hands), so the guard sits at 0.12 -> 0.25.

### palmScore vs palmScore2D on HaGRID (pos = palm + stop, 300 hands each)

| operating point | palmScore (3D) | palmScore2D |
| --- | --- | --- |
| enter 0.75: recall | 0.9317 | **0.9317** (equal) |
| enter 0.75: precision, full suite | 0.6671 | **0.6817** |
| enter 0.75: precision, suite minus four/no_gesture | 0.9790 | **0.9859** |
| enter 0.75: precision, suite minus four | 0.946 | **0.976** |
| exit 0.55: recall | 0.9583 | **0.9583** (equal) |
| stop_inverted > 0.55 (back of hand) | 0/300 | 0/300 |
| no_gesture > 0.75 | 20/300 | **6/300** |
| four > 0.75 (open-hand alias, by design) | 247/300 | 247/300 |

palmScore2D dominates: identical recall at both hysteresis levels with
strictly better precision at every swept threshold, and back-of-hand
rejection intact via the winding sign alone.

### Decision (rule: 2D recall >= 3D recall at equal-or-better precision)

**Applied: palmScore2D is the live palm scorer.** `moves.ts` (the palm
hysteresis input) and the studio's `signals.ts` (the exported `palm`
signal) now call palmScore2D; palmScore stays exported for comparison.
Synthetic-fixture replays were verified unaffected (palm-wave, flame-fan,
rising-flame all hold 26+ frames above the 0.75 enter on the 2D scorer;
full move suite green). `tools/analyze.ts` scores the palm-static-5s take
of a real export with BOTH scorers side by side; since HaGRID cannot show
the live z-noise failure, the user's recording is the final verdict on
the switch (docs/drill-report.md, palm section).

Regression floors for palmScore2D live in tests/hagridPoses.test.ts,
including a pin that its recall never drops below palmScore's at either
hysteresis level (the decision rule re-checked on every run).
