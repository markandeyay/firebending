# Phase-engine evaluation report (2026-07-31)

Evaluation of the rebuilt position-state-machine detector (`src/gestures/phaseEngine.ts`,
`PhaseMoveEngine`) against the user's real recorded drill,
`fixtures/recorded/firebending-drill-2026-07-31.json`, head to head with the legacy
velocity engine (`src/gestures/moves.ts`, `MoveEngine`), plus a framerate stress test
proving the rebuild's core claim: the same recorded trajectories resampled to 10, 14,
20 and 30 fps fire the same events.

Harness: `tools/phaseEval.ts` (run `npx tsx tools/phaseEval.ts`), resampler:
`tools/resample.ts`, permanent CI invariant: `tests/framerateStress.test.ts`.

## 1. Methodology

- **Takes**: the export carries 11 takes (no palm-strike takes and no `neg-*` takes
  were recorded). The 7-move mapping follows `tools/analyze.ts` EXPECTATIONS exactly:
  jab-left/right map to jab-blast, alt-jab-combo to cross-combo, fire-stream AND
  flame-fan to fire-stream, palm-static-5s is the negative (any fire on it is a false
  positive).
- **Rep windows**: `effectiveReps` from `tools/analyze.ts`. The recording has ZERO
  confirmed rep markers, so every window is AUTO-PEAK (machine-detected from each
  take's primary review signal, which is a HAND signal). This matters; see section 2.
- **Hit**: the expected move fired (trigger, or sustain-start for fire-stream) inside
  a rep window widened by REP_SLACK_MS (150 ms) on both ends; at most one hit per
  window. A supplementary "cmpl" metric matches on the motion-completion time
  (`event.t - triggerLatencyMs`) instead of the emission time, to separate "motion
  missed" from "motion detected, emitted after the window" (the phase engine has a
  deliberate 250 ms settle on jabs).
- **False positive**: any fire outside all windows on a positive take, or any fire at
  all on the negative take. FPs are attributed to the move that fired.
- **Baseline**: legacy MoveEngine replayed exactly as `analyze.ts replayTake` does,
  under each take's exported capture-time thresholds.
- **Phase**: PhaseMoveEngine constructed with the export's stored motion profile. This
  export carries none, so it runs on the anatomical defaults (reach prior 0.85 sw).
- **Resampling**: nearest-frame decimation down (a slower camera: real frames kept
  verbatim), positional linear interpolation up (hands and pose positions lerp;
  interpolated pose frames get `interpolated: true` and `pose.t` = the interpolation
  target, mirroring the live worker path). Rep windows are computed once from the
  native take and reused at every rate.

## 2. What the data actually contains (read this before the tables)

Three measured facts about this recording control every number below.

1. **Real pose samples arrive at ~3.8 Hz, not ~14.** The frame stream is ~14 fps, but
   the pose tracker produced a new detection only every ~267 ms (median gap 267 ms,
   p95 333 ms); frames in between carry the held sample. A ~300 ms punch therefore
   spans 1 to 2 real pose samples. Every timing retune in section 4 follows from this
   single fact. (Also: each take's `pose.t` lives in a different clock domain from
   `frame.t` in this export, so the engine's staleness pause never engages in replay;
   live capture shares one domain.)
2. **The AUTO-PEAK rep windows are hand-signal windows, and the hand tracker loses
   the hand during every fast motion.** The windows systematically cover the
   chamber/pull-in burst, while the detectable thrust lands one to two pose samples
   AFTER the window ends. Several windows are zero-width or plainly wrong (rising
   window at 7686..7686; the last "jab" windows cover the end-of-take arm drop).
   With unconfirmed windows and a 150 ms slack that is smaller than one real pose
   sample gap, in-window hit rates UNDERSTATE detection; that is why the fires
   themselves and the cmpl column are also reported. This is a ground-truth quality
   problem, not a detector problem: confirming markers in the studio review would fix
   it.
3. **Screen-space extension is blind to dead-on pushes.** A punch thrown straight at
   the camera fully foreshortens: the wrist lands optically on the shoulder. Measured
   normalized extension: angled jabs (jab-left/right takes) peak 0.76..1.09; dead-on
   punches (alt-jab take) peak 0.18..0.65 and often DIP to 0.08 at full extension;
   the real fire-stream hold measures 0.26..0.49 the whole time; hanging idle arms
   read 1.9..2.6. Consequences in section 6.

## 3. Per-move results, baseline vs phase (native rate)

| move | reps | baseline hits | phase hits | phase cmpl hits | baseline FP | phase FP |
| --- | --- | --- | --- | --- | --- | --- |
| jab-blast | 11 | 0 | 3 | 7 | 0 | 10 |
| fire-stream | 5 | 1 | 0 | 0 | 0 | 10 |
| cross-combo | 6 | 0 | 0 | 0 | 0 | 0 |
| twin-cannon | 6 | 0 | 0 | 0 | 0 | 2 |
| rising-flame | 3 | 0 | 1 | 1 | 0 | 1 |
| fire-whip | 5 | 0 | 1 | 1 | 0 | 3 |
| breath-charge | 6 | 1 | 1 | 1 | 1 | 2 |
| **TOTAL** | **42** | **2** | **6** | **10** | **1** | **28** |

Honest reading, both directions:

- The baseline detects almost nothing on this data (2/42), exactly the failure that
  motivated the rebuild; it also fires almost nothing, so it has almost no FPs. The
  phase engine detects real motion for 5 of 7 moves; its window hits (6, or 10
  completion-adjusted) understate that because of the window skew in section 2.
- Raw fires against physical reps (window bookkeeping aside): jab-left 6 jabs fired
  for 6 physical chamber-punch cycles, jab-right 6 for 6, twin-cannon 2 of 3 proper
  chambers, rising-flame 2 of 4 sweep attempts (the other 2 were swallowed by the
  4 s RISING_COOLDOWN_MS, not missed; the drill's reps are ~3 s apart), breath-charge
  2 of 3 dwells (one charge per continuous hold by design; the third dwell was too
  short), fire-whip 3 of 3 right-arm swings, 0 of 3 left (section 6).
- The phase FP column is dominated by two clusters: 10 spurious fire-stream
  sustain-starts (one after nearly every jab; section 6, problem 1) and real
  detections that land outside misplaced AUTO windows (twin 2, rising 1, whip 2, jab
  4). The single FP on the baseline is a breath-charge on the breath take outside its
  windows.
- The negative take (palm-static-5s) is silent on both engines at every rate.

## 4. Retunes applied (every change, before -> after, measured justification)

All in the files the phase engine owns; structure untouched, constants only. Full
citations live in each constant's doc comment.

| constant | file | before | after | why the data demanded it |
| --- | --- | --- | --- | --- |
| EXT_EXTENDED_MIN | extension.ts | 0.70 | 0.65 | Softest recorded rep peaks (0.59..0.61 sw) normalize to 0.69..0.72 on the 0.85 prior but to 0.63..0.66 once the per-arm learner absorbs the player's hardest punch (0.86..0.93 sw); 0.65 also catches a soft rep one pose sample (~270 ms) earlier. Guard tops out at 0.42 normalized. |
| MAX_THRUST_MS | extension.ts | 400 | 650 | A chamber-to-punch traversal spans up to two real pose gaps (~570 ms) plus up to one frame period of quantization (100 ms at the 10 fps floor); the stress harness measured one recorded rep at 583..643 ms depending on the frame grid, so 600 dropped it at exactly 14 fps. Slowest recorded deliberate reach (816 ms) still rejected. |
| PAIR_WINDOW_MS | phaseEngine.ts | 250 | 400 | Joint two-hand motions land their per-arm edges ONE pose sample apart at 3.8 Hz (measured: twin rep 1 edges 283 ms apart, rising rep 4 completions 334 ms apart; both refused at 250). 400 covers one gap plus jitter, under two gaps. |
| MAX_SWEEP_MS | phaseEngine.ts | 600 | 900 | The HIP-to-ABOVE transit spans up to two pose gaps plus frame quantization (measured: rising rep 1 completed 618 ms after the last HIP sample and was refused at 600). |
| JAB_SETTLE_MS | phaseEngine.ts | 150 | 250 | Pinched by two bounds. Lower: at 150 the release gate re-read the very sample that crossed the threshold (pose gap ~267 ms), so the hanging-arm rejection never saw the plunge (measured false jab on the alt-jab arms-drop at 14254 ms). Upper: the jab must release before its own dwell promotes to a stream at 350 ms at ANY rate; frames land on period multiples, so that is guaranteed only for settle <= 350 - 100 (the 10 fps period). At 300, the 14 fps grid skipped from 286 to 357 and held-out jabs were silently swallowed by their stream upgrade; the stress harness caught it. |
| SHOULDER_LINE_Y | zones.ts | 0 | -0.25 | The user's twin chamber holds the joined wrists ON the shoulder line (measured body y -0.16..+0.35), so a boundary at 0 flickered the chamber into ABOVE_SHOULDER and broke the CHEST hold. Deliberate raises are far clear (sweep tops y -0.9..-1.4). |
| HIP_ZONE_MARGIN -> HIP_ZONE_TOP_FRACTION | zones.ts | hipY - 0.15 sw | hipY x 0.75 | The real breath chamber sits 0.20..0.31 sw ABOVE the hip line and the rising start posture 0.4..0.5 sw above it (hip line ~2.0 sw), so the 0.15 band contained neither and both moves scored zero. Expressed as a torso fraction because an absolute sw margin does not transfer between body proportions (the synthetic test body's torso is 1.16 sw vs the drill's ~2.0). Thrust completions stay clear (y 0.6..1.1). |
| LATERAL_OUTER_MIN | zones.ts | 1.30 | 1.10 | Whip grip holds park at outward 0.79..1.00 sw; the swing apex falls BETWEEN 3.8 Hz samples, so on-sample swing extremes only measure 1.06..1.33. At 1.30, two of five recorded swings never produced an on-sample crossing. 1.10 = loudest hold + 0.10 margin. |

Existing tests that encoded the old values were updated to the retuned ones
(tests/zones.test.ts, tests/extension.test.ts sanity block, one origin expectation in
tests/phaseEngine.test.ts whose release frame moved with the settle).

Before/after on the mandated metric: phase window hits went 4 -> 6 (completion 10)
and, more meaningfully, per-take raw detections went from jab 9 / twin 1 / rising 1 /
breath 0 / whip 2 to jab 12 / twin 2 / rising 2 / breath 2 / whip 4, with the
negative take silent throughout.

## 5. Framerate stress

### 5.1 Detection-rate matrix, in-window hits per rate (phase engine)

| move | 10 fps | 14 fps | 20 fps | 30 fps | spread |
| --- | --- | --- | --- | --- | --- |
| jab-blast | 3/11 | 3/11 | 3/11 | 4/11 | 1 |
| fire-stream | 0/5 | 0/5 | 0/5 | 0/5 | 0 |
| cross-combo | 0/6 | 0/6 | 0/6 | 0/6 | 0 |
| twin-cannon | 0/6 | 0/6 | 0/6 | 0/6 | 0 |
| rising-flame | 1/3 | 1/3 | 0/3 | 0/3 | 1 |
| fire-whip | 1/5 | 1/5 | 1/5 | 1/5 | 0 |
| breath-charge | 1/6 | 1/6 | 1/6 | 1/6 | 0 |

**PASS: every move within one rep across 10/14/20/30.** The two spread-1 cells are
boundary flips of a fire against a window edge (rising's window is zero-width), not
lost detections; the raw fire counts below are the cleaner invariant.

### 5.2 Raw expected-move fire counts per take per rate (phase engine)

| take | 10 | 14 | 20 | 30 |
| --- | --- | --- | --- | --- |
| jab-left-x5 (jab-blast) | 6 | 6 | 6 | 6 |
| jab-right-x5 (jab-blast) | 6 | 6 | 6 | 6 |
| twin-cannon-x3 (twin-cannon) | 2 | 2 | 2 | 2 |
| rising-flame-x3 (rising-flame) | 2 | 2 | 2 | 2 |
| breath-charge-x3 (breath-charge) | 2 | 2 | 2 | 2 |
| fire-whip-left-x3 (fire-whip) | 1 | 1 | 1 | 1 |
| fire-whip-right-x3 (fire-whip) | 3 | 3 | 3 | 3 |
| palm-static-5s (negative, ANY fire) | 0 | 0 | 0 | 0 |

Perfectly flat. This is the table `tests/framerateStress.test.ts` pins forever
(strict equality across rates for all seven rows plus zero on the negative).

Two residual rate-sensitive artifacts, reported, not hidden: the stale-fist
breath-charge FP on the alt-jab arm-drop (section 6, problem 5) appears at 10/14 but
not 20/30 (interpolated wrist positions wobble its stillness anchor), and one
fire-whip FP appears on the fire-stream take at 30 fps only (interpolated arc grazes
the outer band during the take-end arm drop).

### 5.3 Baseline engine on the same resamples (contrast)

| move | 10 fps | 14 fps | 20 fps | 30 fps |
| --- | --- | --- | --- | --- |
| jab-blast | 0/11 | 0/11 | 0/11 | 0/11 |
| fire-stream | 0/5 | 1/5 | 1/5 | 1/5 |
| all others | 0 | 0 | 0 | 0 (breath-charge 1/6 at every rate) |

The baseline's one fire-stream detection dies at 10 fps (its velocity estimates
degrade with sampling). It has nothing else to lose: at this capture quality the
velocity engine is already blind at every rate, which is the original failure in its
starkest form.

## 6. Remaining failures, named plainly

These are real design problems on the user's real data. They are not tuned around,
and the numbers above include them.

1. **Every jab is followed by a phantom fire-stream (10 FPs).** The user's between-rep
   rest posture (arm relaxed, forward-down) measures extension 0.76..1.0, which is
   EXTENDED; after each jab the arm "dwells extended" for well over 350 ms and the
   engine legitimately promotes it to a stream. On this player's geometry, extension
   alone cannot distinguish "arm pushed out at chest height" (real stream, wrist near
   body y 0) from "arm at rest" (wrist y 0.5..0.9). A wrist-height gate on the stream
   promotion would separate them cleanly in the data, but that is a new condition,
   not a constant, so it is proposed here rather than implemented.
2. **fire-stream and flame-fan are undetectable as extension events.** The real
   stream push is thrown dead at the camera and never exceeds 0.49 normalized
   extension; the flame-fan is waved ABOVE the shoulder, outside the thrust zones,
   with no fast traversal. 0/5, at every rate. Detecting these needs a signal that
   survives foreshortening (pose z, hand scale, or a re-recorded angled push).
3. **cross-combo is undetectable: dead-on punches are invisible.** In the alt-jab
   take the punch peak reads as an extension DIP (wrist optically on the shoulder,
   0.08); there is no RETRACTED to EXTENDED traversal in the signal at all. 0/6. The
   jab takes only work because those punches were thrown at a slight angle. Same
   root cause as problem 2, and the single strongest argument for adding a
   foreshortening-aware term to extension.
4. **Move cooldowns cap drill scoring.** rising-flame reps are ~3 s apart but
   RISING_COOLDOWN_MS is 4000, so alternate sweeps are refused by design (2 of 4
   fired, and the stress test pins 2). Same shape for twin-cannon's 5 s cooldown
   (its rep 2 fired exactly on the cooldown boundary). These are game-balance
   constants in moves.ts, outside this pass's ownership.
5. **The breath-charge fist gate cannot reject hanging idle arms.** MediaPipe
   fistScore saturates on relaxed hands (documented in moves.ts), and the
   confidence-aware hold keeps the gate's last debounced state while hands are
   untracked; arms hanging still in the (widened) hip band for 1 s therefore charge
   (measured FP on the alt-jab take's tail at 15604). The positional parts
   (stillness, hip band) cannot separate it because hanging arms are equally still.
   Needs either a fresher-hand requirement on the gate or a lateral-position term.
6. **fire-whip left arm: 2 of 3 reps blocked by the grip score, 1 by sampling.** The
   left-hand grip hold scored 0.08..0.73 against GRIP_ENTER_SCORE 0.78 (a hand-pose
   gate in moves.ts), so the whip never armed on reps 1-2; rep 3's swing apex never
   produced an on-sample outward crossing even at the retuned 1.10 boundary. The
   right arm detects 3/3.
7. **Ground truth quality.** Zero confirmed markers means every window is a machine
   guess from hand signals that vanish during motion; the windows' ~1-pose-sample
   skew is the difference between the hits column (6) and the cmpl column (10), and
   several windows are simply wrong. Recommendation: confirm markers in the studio
   review on the next recording; the harness will use them automatically.

## 7. Verdict

On the user's real ~14 fps recording, with real pose samples at only ~3.8 Hz, the
phase engine detects genuine, correctly-typed motion for five of seven moves and its
detections are EXACTLY as good at 10 fps as at 30 fps; the legacy velocity baseline
detects essentially nothing at any rate. The framerate-independence claim, the entire
point of the rebuild, is proven and pinned by CI. The two undetectable moves
(fire-stream on this push style, cross-combo on dead-on punches) plus the phantom
stream promotion share one root cause worth designing against next:
**screen-space extension collapses under foreshortening**, and no constant can fix
that.
