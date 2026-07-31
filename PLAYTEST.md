# PLAYTEST

The quality pass is done. This is what changed, what to look at, and exactly what to nudge if something feels off.

## Run it

```
npm run dev
```

Open http://localhost:5173/ in Chrome. Click Play, allow the camera, raise both hands, then follow the calibration steps (three punches, palm push). Your thresholds derive from your measured peaks and persist; R on the calibration screen or `?recalibrate=1` redoes them. Because punch detection changed in this pass, do recalibrate once.

## What changed

1. Punch detection was rebuilt a third time, at the root. Palm-span growth was measuring the noisiest quantity at the worst moment (a clenched fist collapses the landmarks). The trigger is now a fusion: elbow extension speed from a new body-pose tracker (primary), plus wrist speed or hand bounding-box growth (secondary). Body pose also gives real shoulder-width calibration, torso-based duck detection, and steadier aim along your forearm.
2. You now have hands in the world: articulated deep-red lacquered gloves that follow your real fingers, knuckle by knuckle, with a little weight and follow-through. A lacquer-framed webcam panel sits bottom-right with your live hand skeletons drawn in ember amber (C toggles it).
3. The renderer got real color management (ACES tonemapping); the arena was rebuilt as an Edo-style courtyard with six combat stations, paper lanterns, a glowing coal channel, a bridge, a great gate, and broad steps. Camera travel between kills now takes six different authored paths and never repeats one twice in a row.
4. Feel: small camera kick on every hit, cracked wax seal for enemy health, cleaner Breath brush stroke, damage numbers with pop and jitter, denser title embers.

## What to look at (in order)

1. Throw a real punch after calibrating. The jab should fire on arm extension even if the camera fumbles your fingers mid-punch. If it misfires, press D: the fusion block shows each signal (elbow, speed, bbox) with PASS/FAIL, and near-misses print like "JAB: elbowVel 2.1 vs 3.4 FAIL".
2. Watch your gloves while you open and close your hands slowly. Every knuckle should bend. Punch and check the follow-through lag feels weighty, not laggy.
3. Kill three constructs and watch three different camera travels (arc, gate pull-back, steps, bridge...). No two consecutive moves should look the same.
4. Turn your head slowly left: the courtyard should drift left, window style. P flips it if it feels backwards.
5. Cover the camera for two seconds mid-fight: pause overlay, then a 3-2-1 ember countdown on resume.

## Knobs, in likelihood order

| Symptom | File | Knob | Direction |
|---|---|---|---|
| Jabs hard to fire | src/gestures/profile.ts | JAB_TRIGGER_FRACTION (0.45) | lower toward 0.35 |
| Jabs fire on casual moves | same | JAB_TRIGGER_FRACTION | raise toward 0.55 |
| Punches missed only when pose tracker active | src/gestures/moves.ts | POSE_FRESH_MS (250) | lower to 150 to trust pose less |
| Gloves feel floaty or rigid | src/vfx/gloves.ts | GLOVE_FOLLOW_TAU (0.08) | lower = tighter, higher = heavier |
| Gloves too big or small | same | GLOVE_SIZE_SCALE (1.55) | taste |
| Parallax backwards | src/game/cameraRig.ts | PARALLAX_YAW_SIGN (-1) | P key tests it live first |
| Whole scene too dark or bright | src/game/renderer.ts | TONE_EXPOSURE (1.2) | 1.0 to 1.4 sane range |

Every derived gesture threshold is visible live in the D HUD, so you always know what number you are fighting.

## If you want to report a misfire

Open the HUD (D), do the gesture three times, copy the fusion block and near-miss lines, and say which move you meant. That is all Claude needs.
