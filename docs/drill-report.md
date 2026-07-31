# Drill analysis report

- Source: `C:\Users\yalam\firebending\fixtures\recorded\firebending-drill-2026-07-31.json`
- Exported at: 2026-07-31T06:28:25.050Z
- Motion profile: DEFAULT_PROFILE (no calibration in export)
- Replayed under CURRENT derived tuning: spikeSpeed 0.900, spikeGrowth 1.350, elbowExtendVel 3.600, risingUpVel 1.000, whipSwingVx 1.000 (capture-time thresholds are stored per take in the export)


> **AUTO-PEAK REP WINDOWS IN USE.** One or more takes had ZERO confirmed
> rep markers (review markers were never clicked), so their rep windows
> were AUTO-DETECTED by deterministic peak detection over each take's
> primary review signal (src/studio/peaks.ts). Auto windows are marked
> `auto` in every table below. They are the machine's reconstruction of
> where the player's reps were, not human-confirmed ground truth.

## Takes: reps vs fired (7-move set)

Palm-strike takes map to jab-blast and the flame-fan take maps to
fire-stream: palm is no longer a classified pose on the critical path.

| take | maps to | status | pose | reps used | rep source | fired in-rep | misses | false positives |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| alt-jab-combo-x3#1 | cross-combo | confirmed | yes | 6 | **AUTO-PEAK** | 0 | 6 | - |
| breath-charge-x3#1 | breath-charge | confirmed | yes | 6 | **AUTO-PEAK** | 1 | 5 | - |
| fire-stream-4s-x2#1 | fire-stream | confirmed | yes | 2 | **AUTO-PEAK** | 2 | 1 | - |
| fire-whip-left-x3#1 | fire-whip | confirmed | yes | 3 | **AUTO-PEAK** | 0 | 3 | - |
| fire-whip-right-x3#1 | fire-whip | confirmed | yes | 2 | **AUTO-PEAK** | 0 | 2 | - |
| flame-fan-4s-x2#1 | fire-stream (was flame-fan) | confirmed | yes | 3 | **AUTO-PEAK** | 0 | 3 | - |
| jab-left-x5#1 | jab-blast | confirmed | yes | 6 | **AUTO-PEAK** | 0 | 6 | - |
| jab-right-x5#1 | jab-blast | confirmed | yes | 5 | **AUTO-PEAK** | 0 | 5 | - |
| palm-static-5s#1 | static-palm | recorded | yes | - | - | - | - | 0 |
| rising-flame-x3#1 | rising-flame | confirmed | yes | 3 | **AUTO-PEAK** | 0 | 3 | - |
| twin-cannon-x3#1 | twin-cannon | confirmed | yes | 6 | **AUTO-PEAK** | 0 | 6 | - |

## Which moves fired in which takes

Trigger / sustain-start events per move across each whole take
(in-rep + out-of-rep). The expected move is marked with `<-`.

| take | jab-blast | fire-stream | cross-combo | twin-cannon | rising-flame | fire-whip | breath-charge |
| --- | --- | --- | --- | --- | --- | --- | --- |
| alt-jab-combo-x3#1 | 0 | 0 | 0 <- | 0 | 0 | 0 | 0 |
| breath-charge-x3#1 | 0 | 0 | 0 | 0 | 0 | 0 | 2 (1 out-of-rep) <- |
| fire-stream-4s-x2#1 | 0 | 2 (0 out-of-rep) <- | 0 | 0 | 0 | 0 | 0 |
| fire-whip-left-x3#1 | 0 | 0 | 0 | 0 | 0 | 0 <- | 0 |
| fire-whip-right-x3#1 | 0 | 0 | 0 | 0 | 0 | 0 <- | 0 |
| flame-fan-4s-x2#1 | 0 | 0 <- | 0 | 0 | 0 | 0 | 0 |
| jab-left-x5#1 | 0 <- | 0 | 0 | 0 | 0 | 0 | 0 |
| jab-right-x5#1 | 0 <- | 0 | 0 | 0 | 0 | 0 | 0 |
| palm-static-5s#1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| rising-flame-x3#1 | 0 | 0 | 0 | 0 | 0 <- | 0 | 0 |
| twin-cannon-x3#1 | 0 | 0 | 0 | 0 <- | 0 | 0 | 0 |

## Per-move summary: reps, hit rate, false positives

False positives are fires of the move inside OTHER takes' out-of-rep
spans; cross-fires inside other takes' rep windows are listed
separately (a jab firing during a twin-cannon rep is a cross-fire, not
background noise).

| move | takes | reps (auto) | fired in-rep | hit rate | misses | FP (other takes, out-of-rep) | cross-fires (other takes, in-rep) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jab-blast | jab-left-x5#1, jab-right-x5#1 | 11 (11 auto) | 0 | 0% | 11 | 0 | 0 |
| fire-stream | fire-stream-4s-x2#1, flame-fan-4s-x2#1 | 5 (5 auto) | 2 | 40% | 4 | 0 | 0 |
| cross-combo | alt-jab-combo-x3#1 | 6 (6 auto) | 0 | 0% | 6 | 0 | 0 |
| twin-cannon | twin-cannon-x3#1 | 6 (6 auto) | 0 | 0% | 6 | 0 | 0 |
| rising-flame | rising-flame-x3#1 | 3 (3 auto) | 0 | 0% | 3 | 0 | 0 |
| fire-whip | fire-whip-left-x3#1, fire-whip-right-x3#1 | 5 (5 auto) | 0 | 0% | 5 | 0 | 0 |
| breath-charge | breath-charge-x3#1 | 6 (6 auto) | 1 | 17% | 5 | 0 | 0 |

## Missed reps: what blocked them

### alt-jab-combo-x3#1 rep 1 (1754..2237 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.787 | 3.600 | 1.813 |
| wristSpeed | 0.470 | 0.900 | 0.430 |
| bboxGrowth | 0.468 | 1.350 | 0.882 |

### alt-jab-combo-x3#1 rep 2 (3654..3921 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.649 | 3.600 | 1.951 |
| wristSpeed | 0.025 | 0.900 | 0.875 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### alt-jab-combo-x3#1 rep 3 (5071..5555 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.208 | 3.600 | 2.392 |
| wristSpeed | 0.187 | 0.900 | 0.713 |
| bboxGrowth | 0.151 | 1.350 | 1.199 |

### alt-jab-combo-x3#1 rep 4 (8404..8604 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 0.611 | 3.600 | 2.989 |
| wristSpeed | 0.498 | 0.900 | 0.402 |
| bboxGrowth | 0.707 | 1.350 | 0.643 |

### alt-jab-combo-x3#1 rep 5 (13787..14920 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.889 | 3.600 | 1.711 |
| wristSpeed | 0.153 | 0.900 | 0.747 |
| bboxGrowth | 0.532 | 1.350 | 0.818 |

### alt-jab-combo-x3#1 rep 6 (16738..17471 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.943 | 3.600 | 1.657 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### breath-charge-x3#1 rep 1 (1245..1495 ms, AUTO-PEAK window)

- Every gating signal crossed its threshold at some point in the
  window, but no event fired: look at timing (hysteresis frames,
  retract window, cooldowns) via the near-miss records below.

### breath-charge-x3#1 rep 3 (3245..3511 ms, AUTO-PEAK window)

- Every gating signal crossed its threshold at some point in the
  window, but no event fired: look at timing (hysteresis frames,
  retract window, cooldowns) via the near-miss records below.

### breath-charge-x3#1 rep 4 (4812..5946 ms, AUTO-PEAK window)

- Every gating signal crossed its threshold at some point in the
  window, but no event fired: look at timing (hysteresis frames,
  retract window, cooldowns) via the near-miss records below.

### breath-charge-x3#1 rep 5 (8961..9478 ms, AUTO-PEAK window)

- Every gating signal crossed its threshold at some point in the
  window, but no event fired: look at timing (hysteresis frames,
  retract window, cooldowns) via the near-miss records below.

### breath-charge-x3#1 rep 6 (12029..12145 ms, AUTO-PEAK window)

- Every gating signal crossed its threshold at some point in the
  window, but no event fired: look at timing (hysteresis frames,
  retract window, cooldowns) via the near-miss records below.

### fire-stream-4s-x2#1 rep 1 (2737..3220 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.292 | 3.600 | 2.308 |
| wristSpeed | 0.557 | 0.900 | 0.343 |
| bboxGrowth | 0.442 | 1.350 | 0.908 |

### fire-whip-left-x3#1 rep 1 (1554..1821 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| grip | 0.710 | 0.780 | 0.070 |
| swingVx | 0.030 | 1.000 | 0.970 |

### fire-whip-left-x3#1 rep 2 (7537..7804 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| swingVx | 0.112 | 1.000 | 0.888 |

### fire-whip-left-x3#1 rep 3 (9988..10737 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| swingVx | 0.096 | 1.000 | 0.904 |

### fire-whip-right-x3#1 rep 1 (843..1176 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| swingVx | 0.018 | 1.000 | 0.982 |

### fire-whip-right-x3#1 rep 2 (6760..6760 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| swingVx | 0.055 | 1.000 | 0.945 |

### flame-fan-4s-x2#1 rep 1 (2338..2538 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 0.599 | 3.600 | 3.001 |
| wristSpeed | 0.509 | 0.900 | 0.391 |
| bboxGrowth | 0.199 | 1.350 | 1.151 |

### flame-fan-4s-x2#1 rep 2 (4621..4788 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 0.048 | 3.600 | 3.552 |
| wristSpeed | 0.027 | 0.900 | 0.873 |
| bboxGrowth | 0.053 | 1.350 | 1.297 |

### flame-fan-4s-x2#1 rep 3 (8555..10372 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 0.273 | 3.600 | 3.327 |
| wristSpeed | 0.457 | 0.900 | 0.443 |
| bboxGrowth | 0.164 | 1.350 | 1.186 |

### jab-left-x5#1 rep 1 (2841..2995 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.165 | 3.600 | 2.435 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### jab-left-x5#1 rep 2 (4428..4661 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 0.952 | 3.600 | 2.648 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### jab-left-x5#1 rep 3 (5578..6087 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 0.638 | 3.600 | 2.962 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### jab-left-x5#1 rep 4 (7902..8327 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.829 | 3.600 | 1.771 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### jab-left-x5#1 rep 5 (9809..9967 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 0.918 | 3.600 | 2.682 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### jab-left-x5#1 rep 6 (12695..13911 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.451 | 3.600 | 2.149 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### jab-right-x5#1 rep 1 (6452..6669 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.703 | 3.600 | 1.897 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### jab-right-x5#1 rep 2 (8386..8852 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 0.721 | 3.600 | 2.879 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### jab-right-x5#1 rep 3 (12602..12869 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 0.676 | 3.600 | 2.924 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### jab-right-x5#1 rep 4 (14287..14978 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.226 | 3.600 | 2.374 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### jab-right-x5#1 rep 5 (15669..15886 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.894 | 3.600 | 1.706 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

### rising-flame-x3#1 rep 1 (7686..7686 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| upVel | 0.162 | 1.000 | 0.838 |

### rising-flame-x3#1 rep 2 (10419..10752 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| upVel | 0.055 | 1.000 | 0.945 |

### rising-flame-x3#1 rep 3 (11153..11153 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| upVel | 0.041 | 1.000 | 0.959 |

### twin-cannon-x3#1 rep 1 (1259..1726 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 2.149 | 3.600 | 1.451 |
| wristSpeed | 0.140 | 0.900 | 0.760 |
| bboxGrowth | 0.068 | 1.350 | 1.282 |

Engine near-miss records in the window:

| failed condition | best value | threshold | occurrences |
| --- | --- | --- | --- |
| elbowVel | 2.149 | 4.290 | 4 |

### twin-cannon-x3#1 rep 2 (6277..6743 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 2.742 | 3.600 | 0.858 |
| wristSpeed | 0.672 | 0.900 | 0.228 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

Engine near-miss records in the window:

| failed condition | best value | threshold | occurrences |
| --- | --- | --- | --- |
| elbowVel | 2.742 | 3.600 | 8 |

### twin-cannon-x3#1 rep 3 (10343..10809 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 0.828 | 3.600 | 2.772 |
| wristSpeed | 0.215 | 0.900 | 0.685 |
| bboxGrowth | 0.097 | 1.350 | 1.253 |

### twin-cannon-x3#1 rep 4 (11761..12292 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 1.695 | 3.600 | 1.905 |
| wristSpeed | 0.051 | 0.900 | 0.849 |
| bboxGrowth | 0.183 | 1.350 | 1.167 |

### twin-cannon-x3#1 rep 5 (14492..14693 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 2.264 | 3.600 | 1.336 |
| wristSpeed | 0.598 | 0.900 | 0.302 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

Engine near-miss records in the window:

| failed condition | best value | threshold | occurrences |
| --- | --- | --- | --- |
| elbowVel | 2.264 | 3.600 | 4 |

### twin-cannon-x3#1 rep 6 (15026..15826 ms, AUTO-PEAK window)

| blocking signal | rep max | threshold | short by |
| --- | --- | --- | --- |
| elbowVel | 2.395 | 3.600 | 1.205 |
| wristSpeed | 0.000 | 0.900 | 0.900 |
| bboxGrowth | 0.000 | 1.350 | 1.350 |

## Signal-to-noise per move

In-rep peak median vs the noise pool 95th percentile.

Noise pool: NEGATIVE TAKES ABSENT: noise floor built from the between-rep (out-of-rep) spans of 10 positive takes plus all frames of 1 static-palm hold(s).

| take | rep source | signal | peak median (in rep) | noise p95 | ratio |
| --- | --- | --- | --- | --- | --- |
| alt-jab-combo-x3#1 | AUTO-PEAK | elbowVel | 1.787 | 0.859 | 2.08 |
| alt-jab-combo-x3#1 | AUTO-PEAK | wristSpeed | 0.187 | 0.101 | 1.85 |
| alt-jab-combo-x3#1 | AUTO-PEAK | bboxGrowth | 0.468 | 0.152 | 3.08 |
| breath-charge-x3#1 | AUTO-PEAK | fist | 0.779 | 1.000 | 0.78 |
| fire-stream-4s-x2#1 | AUTO-PEAK | elbowVel | 4.816 | 0.859 | 5.61 |
| fire-stream-4s-x2#1 | AUTO-PEAK | wristSpeed | 0.557 | 0.101 | 5.51 |
| fire-stream-4s-x2#1 | AUTO-PEAK | bboxGrowth | 0.442 | 0.152 | 2.92 |
| fire-whip-left-x3#1 | AUTO-PEAK | grip | 1.000 | 0.740 | 1.35 |
| fire-whip-left-x3#1 | AUTO-PEAK | swingVx | 0.096 | 0.052 | 1.85 |
| fire-whip-right-x3#1 | AUTO-PEAK | grip | 1.000 | 0.740 | 1.35 |
| fire-whip-right-x3#1 | AUTO-PEAK | swingVx | 0.055 | 0.052 | 1.06 |
| flame-fan-4s-x2#1 | AUTO-PEAK | elbowVel | 0.273 | 0.859 | 0.32 |
| flame-fan-4s-x2#1 | AUTO-PEAK | wristSpeed | 0.457 | 0.101 | 4.52 |
| flame-fan-4s-x2#1 | AUTO-PEAK | bboxGrowth | 0.164 | 0.152 | 1.08 |
| jab-left-x5#1 | AUTO-PEAK | elbowVel | 1.165 | 0.859 | 1.36 |
| jab-left-x5#1 | AUTO-PEAK | wristSpeed | 0.000 | 0.101 | 0.00 |
| jab-left-x5#1 | AUTO-PEAK | bboxGrowth | 0.000 | 0.152 | 0.00 |
| jab-right-x5#1 | AUTO-PEAK | elbowVel | 1.226 | 0.859 | 1.43 |
| jab-right-x5#1 | AUTO-PEAK | wristSpeed | 0.000 | 0.101 | 0.00 |
| jab-right-x5#1 | AUTO-PEAK | bboxGrowth | 0.000 | 0.152 | 0.00 |
| rising-flame-x3#1 | AUTO-PEAK | upVel | 0.055 | 0.036 | 1.54 |
| twin-cannon-x3#1 | AUTO-PEAK | elbowVel | 2.264 | 0.859 | 2.64 |
| twin-cannon-x3#1 | AUTO-PEAK | wristSpeed | 0.215 | 0.101 | 2.12 |
| twin-cannon-x3#1 | AUTO-PEAK | bboxGrowth | 0.068 | 0.152 | 0.45 |

## Static palm hold: palmScore (3D) vs palmScore2D (live scorer)

palmScore2D is the LIVE scorer since the HaGRID investigation (see
docs/hagrid-report.md appendix). Since the 7-move simplification no
MOVE reads either scorer; this comparison remains the player-data
verdict on the 2D switch for the studio and any future palm use.

| take | scorer | hands scored | p5 | median | p95 | frames > 0.75 | frames > 0.55 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| palm-static-5s#1 | palmScore (3D) | 83 | 1.000 | 1.000 | 1.000 | 83 | 83 |
| palm-static-5s#1 | palmScore2D (live) | 83 | 1.000 | 1.000 | 1.000 | 83 | 83 |

## Threshold proposals (max-margin separators)

For each motion threshold: the midpoint between the loudest noise-pool
value and the quietest rep-window peak above it. Reps whose peak falls
at or below the proposal are listed as still-missing, not hidden.
Fractions are relative to the profile the export carried.

**Noise pool provenance: NEGATIVE TAKES ABSENT: noise floor built from the between-rep (out-of-rep) spans of 10 positive takes plus all frames of 1 static-palm hold(s).**

**Rep peaks come from AUTO-PEAK windows (see banner above).**

| threshold | signal | current | proposed | margin | rep peaks (min..med..max) | noise max | reps still missing | implied fraction |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| spikeSpeed | wristSpeed | 0.900 | n/a | 0.000 | 0.000..0.025..0.672 | 1.164 | 28/28 | no separation found |
| spikeGrowth | bboxGrowth | 1.350 | n/a | 0.000 | 0.000..0.000..0.707 | 1.695 | 28/28 | no separation found |
| elbowExtendVel | elbowVel | 3.600 | 4.592 | 0.224 | 0.048..1.451..4.816 | 4.369 | 27/28 | JAB_TRIGGER_FRACTION (elbow term): 0.574 (now 0.45, peak peakElbowVel=8.00) |
| risingUpVel | upVel | 1.000 | n/a | 0.000 | 0.041..0.055..0.162 | 0.214 | 3/3 | no separation found |
| whipSwingVx | swingVx | 1.000 | n/a | 0.000 | 0.018..0.055..0.112 | 1.163 | 5/5 | no separation found |

**PROPOSALS ARE NOT APPLIED AUTOMATICALLY.** Review the tables above
against the recording, then change the constants in
`src/gestures/profile.ts` / `src/gestures/moves.ts` by hand (the
orchestrator applies them once the user's recorded data supports them).

## Applied tuning changes (2026-07-31 review, hand-applied after this run)

Two data-justified changes were applied; every other proposal was rejected
with the evidence below. The moveset itself was simplified to 7 moves in the
same review (palm removed from the critical path; see src/gestures/moves.ts
header), a structural change, not a threshold change.

### APPLIED: breath-charge chamber fist enter 0.75 -> 0.63

- Before: the chamber used the standard pose hysteresis enter level 0.75.
- After: a dedicated chamber hysteresis (BREATH_FIST_ENTER = 0.63, exit
  0.55) in src/gestures/moves.ts.
- Evidence (breath-charge-x3#1): 196 chamber-hold fist scores measure p5
  0.632 / median 0.711 / min 0.572, jitter p90 0.022; the user's whole
  sustained hold sat BELOW the old 0.75 enter so the 4-frame debounce never
  latched (per-rep fist maxima 0.682..0.803). Enter = recorded p5; exit
  stays below the recorded minimum.
- Validation by replay: 1 of 2 -> BOTH tracker-visible chamber holds fire
  (triggers at 2379 and 10095 ms). The player's third cycle was never
  tracked at all (hands absent 6145..8878 ms).
- Note: relaxed REAL hands also saturate fistScore (noise fist = 1.00), so
  the gate does not separate a chamber from real idle; that separation is
  the hip band + stillness + the 1.0 s hold. The gate is kept because it
  rejects open-handed postures and keeps the synthetic negative suite
  meaningful (synthetic rest hands score fist 0.00..0.04).

### APPLIED: vanished-hand elbow-only thrust path (HAND_VANISH_WINDOW_MS 300, ELBOW_VANISH_VEL 4.29)

- Rule: pose fresh AND the hand tracked within 300 ms but currently null
  (the disappearance is the fast-motion signature: both hands are null in
  all 11 jab AUTO-PEAK windows) AND elbow extension velocity >=
  max(elbowExtendVel, ELBOW_VANISH_VEL) registers a thrust; aim = forearm
  direction, origin = pose wrist; elbow RE-FLEX resolves the jab, the elbow
  staying extended past EXTEND_HOLD_MS resolves Fire Stream; resolution
  consumes the thrust so hand reacquisition cannot double-fire.
- ELBOW_VANISH_VEL derivation (max-margin over the 105 vanish episodes in
  this export): non-thrust episode elbow max 3.93 rad/s (fire-whip-left arm
  re-raise), quietest separable thrust 4.66 rad/s (fire-stream second
  thrust); midpoint 4.29, margin 0.37.
- Variant decision: variant A (no pre-vanish motion guard) at the 4.29
  floor. At the plain 3.6 gate the path WOULD cross-fire on the whip
  re-raise (3.93); the variant-B pre-vanish signature carries no separating
  power on this data (last-tracked bbox growth is ~0 in most thrust
  episodes because the hand vanishes at motion onset, while noise episodes
  reach pre-growth 0.60; toward-camera velocity is not exported at all), so
  the guard cannot substitute for the higher floor without guessing.
- Validation by replay: fire-stream 0/5 -> 2/5 in-rep (both elbow-only
  sustains land inside the second stream rep; the whip takes stay at ZERO
  fires of any move; every FP and cross-fire column stays 0).
- Honest limit: jab/cross-combo/twin stay at 0%. Their vanish-context elbow
  peaks (max 2.74 rad/s at ~14 fps pose sampling) sit BELOW the whip
  re-raise noise (3.93), and in the jab takes the elbow peak often arrives
  MORE than 300 ms after hand loss. No window length or threshold recovers
  them without cross-firing on arm raises: elbow alone cannot tell this
  user's jab from an arm raise. That needs better capture (higher fps or
  hand tracking that survives fast motion) or confirmed markers plus real
  negative takes.

### REJECTED: elbowExtendVel 3.600 -> 4.592 (the general-path separator)

The separator sits ABOVE the current threshold because the full noise
pool's loudest elbow values are the whip-take arm re-raises; 27 of 28
thrust rep peaks sit below it. Applying it would make the general fusion
path strictly worse. (The vanish path above encodes the same separation
where it is actually valid: the vanish context.)

### REJECTED (no separation exists): spikeSpeed, spikeGrowth, risingUpVel, whipSwingVx

The recording shows hand landmarks vanish during fast motion, so in-window
hand-motion peaks are near zero while the noise pools contain
hand-reacquisition spikes (1.16 u/s wristSpeed, 1.70 1/s bboxGrowth,
1.16 u/s swingVx). No threshold value fires on these takes without firing
on reacquisition glitches. HARD RULE honored: no value was guessed.

### KEPT: GRIP_ENTER_SCORE 0.78 despite one 0.710 rep

fire-whip-left rep 1 peaked at grip 0.710, below the 0.78 enter. Lowering
under 0.75 would cross the HaGRID distractor cliff (0.96 precision,
docs/hagrid-report.md); one rep does not outweigh HaGRID. The whip's actual
blocker on this recording is swingVx (hands untracked mid-lash).

### Noise floor provenance

The 3 negative takes and 2 palm-strike takes were never recorded. All noise
floors come from the between-rep (out-of-rep) spans of the 10 positive
takes plus every frame of the static-palm hold, as labeled throughout. Rep
windows are AUTO-PEAK reconstructions (zero markers were confirmed in
review); both facts lower the evidentiary weight of every number here,
which is why only the two changes above (each backed by dense continuous
traces, not just window statistics) were applied.
