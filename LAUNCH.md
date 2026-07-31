# LAUNCH

The final round is merged: 624 tests green, tsc clean, perf gate PASS, bundle within budget. This file is the handoff: what changed, what to judge, every knob you might want to turn, and how to ship it.

## 1. What changed this round

- **Data-driven tuning.** Your recorded drill session (11 takes) was ingested and analyzed with auto-detected rep windows. Real numbers replaced guesses: the breath-charge fist gate dropped to your measured chamber level (enter 0.63), and the elbow-only thrust floor (4.29 rad/s) is the max-margin separator computed over all 105 hand-vanish episodes in your data.
- **The 7-move set.** Palm classification left the critical path. Thrusts are pose-agnostic: elbow extension fused with wrist speed and hand-bbox growth decides, finger curl is irrelevant. Palm-wave and flame-fan are gone; a palm strike is a jab-blast, a held push is a fire-stream. Seven moves remain: jab-blast, fire-stream, cross-combo, twin-cannon, rising-flame, fire-whip, breath-charge.
- **The elbow-only rule.** Your drills showed the hand tracker losing the hand during every fast jab (both hands null in all 11 auto-detected jab windows). The disappearance is now itself the signal: with body pose fresh and a hand seen within the last 300 ms, a violent elbow extension registers the thrust on the pose skeleton alone, aimed along the forearm. Elbow re-flex resolves to a jab; staying extended resolves to fire-stream. Measured on the drill data this took fire-stream detection from 0 percent to 40 percent; jabs stayed capture-limited at the 14 fps studio recording rate (see section 2).
- **Fire rebuild.** Blackbody temperature ramp (1000 to 2600 K) with per-particle spawn temperature, curl-noise turbulence, soft particles against scene depth, sub-frame ribbon emission for fast comets, embers that arc, land on the floor and cool where they lie, smoke tinted by live fire activity, and point lights flickering from the actual live particle count. All GPU-instanced with an O(1) CPU update.
- **Constructs rebuilt.** Straw, rope, banded iron and stone variants across the six stations, burn-dissolve damage staging, wound smolder above 50 percent damage, staged death captures in docs/screens.
- **Audio.** Fully procedural adaptive score (drone that swells with combat, taiko kills, travel flute) plus per-move synthesis. Zero bundled audio without a verified license; CC-BY candidates are listed for human fetch in docs/ATTRIBUTIONS.md.
- **Title and grit.** Woodblock-card title screen, ACES grade with tone curve, edge chromatic aberration, film grain, vignette, heat shimmer, half-res fire compositing, soot and wear passes on the courtyard.

## 2. What to judge, in order

1. **Play the flow.** `npm run dev`, click Play, calibrate (three punches and a push), fight through at least six kills. Judge trigger feel, aim, travel variety, hit weight. This is the product.
2. **On any misfire, press D.** The debug HUD shows every fusion signal live (elbow velocity, wrist speed, bbox growth, each against its threshold) and a near-miss log naming the exact condition that refused a move. Nothing about a miss is a mystery.
3. **Re-record in the studio.** `npm run studio`. The original drill was captured at about 14 fps, which is what limited jab validation: a 150 ms punch spans two frames at that rate. The tracking pipeline now runs pose-driven ROI crops and is markedly faster; the studio should capture near 30 fps. Record the 16 takes, confirm reps in review, export, then run `npm run analyze` and have Claude apply the proposed thresholds. Every remaining gesture-feel question routes through this data.

## 3. Knobs per gesture

Motion thresholds derive from your calibration profile through fractions in `src/gestures/profile.ts`; absolute geometry and timing live in `src/gestures/moves.ts`. The derivation is always max(fraction x calibrated peak, 3 x neutral baseline, absolute floor).

| Gesture | Knob | Where | Value |
|---|---|---|---|
| All thrusts (jab, cross, stream, twin) | `JAB_TRIGGER_FRACTION` | profile.ts | 0.45 of calibrated punch peak (speed, bbox growth, elbow velocity) |
| Jab resolve (retract) | `RETRACT_FRACTION` | profile.ts | 0.35 of punch growth peak |
| Jab per-hand cooldown | `JAB_COOLDOWN_MS` | moves.ts | 250 |
| Vanished-hand thrust window | `HAND_VANISH_WINDOW_MS` | moves.ts | 300 ms since the hand was last tracked |
| Vanished-hand elbow floor | `ELBOW_VANISH_VEL` | moves.ts | 4.29 rad/s (max-margin from your drill data) |
| Stream upgrade hold | `EXTEND_HOLD_MS` | moves.ts | 350 ms extended after a thrust |
| Cross combo window | `COMBO_WINDOW_MS` | moves.ts | 1500 ms, three alternating jabs |
| Twin cannon hold | `TWIN_HOLD_MS` / `TWIN_GRACE_MS` | moves.ts | 300 / 500 ms, hands together in the chest band |
| Rising flame | `RISING_LOW_HOLD_MS` / `SWEEP_FRACTION` | moves.ts / profile.ts | 150 ms low hold, sweep at 0.5 of punch speed |
| Fire whip | `WHIP_HOLD_MS` / `GRIP_ENTER_SCORE` / `GRIP_EXIT_SCORE` | moves.ts | 400 ms static grip hold at 0.78 / 0.55 hysteresis, then a lateral swing at the sweep threshold |
| Breath charge | `BREATH_HOLD_MS` / `BREATH_FIST_ENTER` / `BREATH_FIST_EXIT` | moves.ts | 1000 ms at the hips; fist enter 0.63 (your measured chamber p5), exit 0.55 |
| Statics and aim | `STATIC_FRACTION` / `AIM_FRACTION` | profile.ts | 0.12 / 0.2 of punch speed, with floors 0.4 and 0.5 |
| Pose freshness | `POSE_FRESH_MS` | moves.ts | 250 ms; stale pose falls back to the two-secondary rule |
| Safety floors | `FLOOR_*` | profile.ts | speed 0.5, growth 0.6, elbow 1.5 rad/s, sweep 0.6 |

Recalibrate any time with `?recalibrate=1` or the R key on the title screen.

## 4. Deploy

Both configs are committed (`vercel.json`, `netlify.toml`; build command `npm run build`, output `dist/`). The build is static and self-contained.

Vercel:

```sh
npx vercel login
npx vercel --prod
```

Netlify:

```sh
npx netlify-cli login
npx netlify-cli init
npx netlify-cli deploy --prod --build
```

Then replace the Try It placeholder in README.md with the live URL and tag `phase-8-complete`.

## 5. Remaining HUMAN items

From firebending.md 16.4, in priority order:

1. **Play and judge.** The full live flow, trigger feel, and the elbow-only jab behavior when your hand blurs out of tracking.
2. **Studio re-record, analyze, apply.** 16 takes at the new capture rate, confirm reps, export, `npm run analyze`, apply proposals (section 2 above).
3. **Pose FULL adoption rule.** In the studio, watch the live stats panel with yourself in frame: if handMs + poseMs stays under 16 ms, flip `createPoseLandmarker('full')` to be the default. The committed numbers are worst-case no-subject measurements; only a human in frame produces the real ones.
4. **Audio candidates.** Optionally fetch and verify the CC-BY ambient tracks listed in docs/ATTRIBUTIONS.md; the synthesized score ships fine without them.
5. **Font vendoring.** An open-licensed brush display font (woff2 in repo, @font-face in src/ui/theme.css, first in --fb-font-display). The current system-serif stack reads engraved rather than brushstroke.
6. **Live subject perf.** Confirm frame budget with a person in frame (D HUD or studio stats). The degrade ladder (particles, pose rate, shadows) is armed if the budget suffers.
