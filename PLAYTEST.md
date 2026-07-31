# PLAYTEST

Round three is built around one idea: no more guessing. You record real data, the analyzer tunes from it.

## 1. Launch the studio

```
npm run studio
```

It opens http://localhost:5205/studio.html and prints the URL. Allow the camera. The framing guide in the center tells you exactly what to fix ("Step back", "Raise your camera") until your whole body and both hands are framed.

## 2. Record takes

Left sidebar lists 16 takes (13 moves, 3 negatives). Click any take, read the instruction card on the right (it has a looping stick figure showing the motion, rep counts, and a common-mistakes line), press SPACE, wait out the 3-2-1, perform, press SPACE to stop. Everything autosaves to the browser continuously; a refresh loses nothing.

## 3. Trim and confirm reps

After each take you land in review: scrub with arrows or J/K/L, watch the signal track under the video (your punches are visible as peaks), drag the gold handles to trim, then click each auto-detected rep marker to Confirm or Reject. Missed rep: scrub to it and press M. Re-record anything; takes are never overwritten, star the best.

## 4. Export and analyze

Click EXPORT. The banner tells you exactly where to put the file:

Save the file into C:\Users\yalam\firebending\fixtures\recorded\ then run:

```
npm run analyze
```

It replays your trimmed frames through the real gesture engine and writes docs/drill-report.md: which reps fired, which signal blocked each miss and by how much, false positives during your negative takes, and proposed thresholds with margins. Nothing is applied automatically; tell Claude to apply the proposals and it will, with the report as justification.

## 5. Then play

```
npm run dev
```

http://localhost:5173/ as before. What changed underneath since last time:

- Hands are now tracked from upscaled crops around your wrists (pose finds the wrists first), so distance no longer ruins hand landmarks. The framing gate in calibration gets you standing in the right spot before the game starts.
- The face tracker is gone; head parallax comes from body pose. Pose runs in a worker.
- Palm detection no longer depends on depth guesses (new 2D scorer, tuned on real hands).
- The in-world hands are anatomical now: flat palm, knuckle row, tapered fingers, proper thumb.
- The arena has a film look (bloom, grain, vignette) and six recomposed stations.

## Knobs (only after analyze, or by feel with the D HUD open)

| Symptom | File | Knob |
|---|---|---|
| Jabs hard to fire | src/gestures/profile.ts | JAB_TRIGGER_FRACTION (0.45) down |
| Jabs misfire | same | up |
| Crops jitter or lag my hands | src/tracking/roiCrop.ts | smoothing tau / deadbands |
| Framing gate too strict | src/game/framingGate.ts | floors and the 2s hold |
| Scene brightness | src/game/renderer.ts | TONE_EXPOSURE (1.2) |
| Bloom too eager | src/game/post.ts | POST_BLOOM_THRESHOLD |

The D HUD still shows every signal against its threshold live, and near-misses print exactly which condition failed and by how much.
