# Drill analysis report

**No recorded export has been analyzed yet.** This file documents the
pipeline; running `npm run analyze` against a real
`fixtures/recorded/firebending-drill-*.json` OVERWRITES it with the
generated report (same sections as below, filled with the recording's
numbers). Reports generated from synthetic inputs are labeled
`[SYNTHETIC DATA]` in the title plus a banner, and nothing in them may be
used for tuning.

## Pipeline (tools/analyze.ts, `npm run analyze [path]`)

1. Ingests the newest `firebending-drill-*.json` in `fixtures/recorded/`
   (or the path argument). The file is the versioned `StudioExport`
   contract from `src/studio/exportSchema.ts`; all times are video ms.
2. Replays each take's trimmed frames through a REAL `MoveEngine`
   configured with the take's exported thresholds
   (`MoveEngineConfig.thresholds` bypasses profile derivation, so the
   replay runs the exact values the capture ran under), with
   `debugEnabled` on and every near-miss record captured via
   `MoveEngine.nearMissListener` (the 8-slot HUD ring would drop records).
3. Per positive take: counts expected-move events inside each confirmed
   rep window (+150 ms slack). A rep with zero fires is a MISS; the report
   names each gating signal whose per-rep maximum (from the exported
   per-frame signals, over the take's relevant hands) never crossed its
   threshold, with the shortfall, and attaches the engine's own near-miss
   records inside the window.
4. Per negative take (and the static-palm hold): every fired event is a
   false positive, reported with its timestamp and the triggering frame's
   signal values.
5. Signal-to-noise per gating signal per move: median in-rep peak vs the
   95th percentile of the noise pool (out-of-rep frames of the take plus
   every frame of every negative take).
6. Threshold proposals: for each motion threshold, the max-margin
   separator between confirmed-rep peaks and negative-take noise (midpoint
   between the loudest noise and the quietest rep peak above it), with the
   margin and the reps that would still miss, expressed also as the
   implied profile fraction (`JAB_TRIGGER_FRACTION`, `SWEEP_FRACTION`;
   `src/gestures/profile.ts`) relative to the export's motion profile.

**Proposals are never auto-applied.** The tool prints them and this report
records them; constants change only after review against the user's
recorded data. No real export exists yet, so nothing is proposed and
nothing was applied.

## Take expectations

| take slot | kind | expected move | counted event |
| --- | --- | --- | --- |
| jab-left-x5 / jab-right-x5 | positive | jab-blast | trigger |
| alt-jab-combo-x3 | positive | cross-combo | trigger |
| palm-strike-left-x5 / -right-x5 | positive | palm-wave | trigger |
| palm-static-5s | static-palm | none (any fire = FP) | - |
| fire-stream-4s-x2 | positive | fire-stream | sustain-start |
| flame-fan-4s-x2 | positive | flame-fan | sustain-start |
| twin-cannon-x3 | positive | twin-cannon | trigger |
| rising-flame-x3 | positive | rising-flame | trigger |
| fire-whip-left-x3 / -right-x3 | positive | fire-whip | trigger |
| breath-charge-x3 | positive | breath-charge | trigger |
| neg-talking-30s / neg-idle-20s / neg-reaching-20s | negative | none | - |

## Palm investigation: palmScore (3D) vs palmScore2D (template section)

Background: `palmScore`'s facing factor is `normal.z` of the 3D palm
normal. The winding determinant in its numerator uses only landmark x/y,
but the normalization divides by the full cross-product length, whose x/y
components are built from MediaPipe's monocular-depth z guesses. Live z
noise inflates that length, shrinks `normal.z`, and multiplies real palms
down: the reported "palm poses barely recognized live" behavior.
`palmScore2D` (src/gestures/poses.ts) keeps the same winding information
as a raw 2D determinant plus pure 2D extension/gap/hull-aspect features;
no z anywhere.

On HaGRID the two scorers tie on recall with palmScore2D ahead on
precision, so palmScore2D is the LIVE scorer (decision details and full
tables: docs/hagrid-report.md appendix). HaGRID stills cannot exhibit the
live z-noise failure (their z is exactly 0), so the recording is the
final verdict: when a real export is analyzed, the section "Static palm
hold: palmScore (3D) vs palmScore2D (live scorer)" scores the
palm-static-5s take with BOTH scorers side by side (p5/median/p95 and
frames above the 0.75 enter and 0.55 exit levels). Expected outcome on
live data: the 2D column holds clearly more frames above 0.75. If it does
not, the switch must be re-reviewed.

## Regression coverage

`tests/drillAnalyze.test.ts` synthesizes an export from the synthetic
fixtures (frames piped through the real `SignalTracker`, wrapped in the
schema with `meta.synthetic: true`) and asserts: replay fires, in-rep
counting, a deliberate miss with blocker diagnosis, false-positive
detection on a negative, honest no-separation proposal reporting, the
dual palm scoring, and the loud SYNTHETIC labeling of this report.
