# FIX_ME

Literal steps for a tired human. Do them in order.

## 1. Run the game

```
npm run dev
```

Open http://localhost:5173/ in Chrome. (If a dev server is already running from the overnight session, just open the URL.)

## 2. Run through the new calibration

1. Click Play, allow the camera.
2. Raise both hands until the outlines ignite ("Bender recognized.").
3. New step: "Throw three punches." A meter bar appears. Throw a real punch at the camera; the bar should jump and a counter should tick 1, then 2, then 3. Stand still for the first second of this step so it can measure your resting baseline.
4. New step: "Push your palms forward." Push both palms toward the camera; the meter ticks again.
5. You land in the arena. Your measured peaks are now the thresholds (a jab fires at 45 percent of YOUR peak punch), saved to localStorage so reloads skip straight past these steps.

To redo calibration: press R while on the calibration screen, or load http://localhost:5173/?recalibrate=1

If a step will not register anything for 20 seconds it falls back to defaults and continues; you are never stuck.

## 3. Open the debug HUD

Press D in the arena. Top right panel shows, per hand: fist/palm/grip scores (a `*` means the pose is active), wrist speed, span growth (the new toward-camera signal), plus the state machine, your calibrated thresholds, your profile values (or "default"), head yaw, and camera parallax.

The last lines are the near-miss log. When a move almost fires you get exactly which condition failed and by how much, for example:

```
JAB: speed 0.54 vs threshold 0.90 FAIL
```

## 4. Check the parallax with P

Turn your head slowly to the left. The camera should drift gently LEFT, like looking out a window. If it feels backwards, press P; a toast tells you which mode you are in. Correct is the default: "Parallax yaw: head left pans left (window style, default)". If you had to press P to make it feel right, tell Claude; the default sign constant is `PARALLAX_YAW_SIGN` in src/game/cameraRig.ts.

## 5. If a move still misfires, report this back

Open the HUD (D), do the gesture 3 times, then copy down:

1. The near-miss lines (move name, value, threshold).
2. Your profile line values (peak speeds and growths).
3. Which move you meant to do and what happened instead (nothing, or the wrong move).

That is enough to retune precisely.

## Fallback: the one number to nudge

If adaptive calibration still feels wrong, edit `JAB_TRIGGER_FRACTION` in **src/gestures/profile.ts** (currently 0.45):

- Jabs too hard to fire: lower it, try 0.35.
- Jabs firing when you just move your hand: raise it, try 0.55.

Save the file; vite hot-reloads. That one fraction scales the main punch trigger. The equivalent knobs for other moves sit right next to it (`RETRACT_FRACTION`, `SWEEP_FRACTION`) and every derived threshold is visible live in the HUD.
