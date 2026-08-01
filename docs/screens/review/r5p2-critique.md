# R5 P2 review: state-machine debug HUD and in-scene aim ray (commit eedfc18)

Reviewed 2026-07-31 against the Section 9 aesthetic law and general UI quality.
Surfaces: the rebuilt D HUD detection block (src/ui/debugHud.ts) and the debug
aim ray (src/screens/arena.ts, buildAimRay / updateAimRay).

Review environment caveat: during this session the working tree carried
uncommitted edits to src/gestures/extension.ts, zones.ts and phaseEngine.ts,
and those files were being modified live (nine vite full reloads landed while
testing). debugHud.ts and arena.ts were clean and match the merge, so the HUD
and ray rendering verdicts stand; engine DATA observations below may reflect
the in-flight working tree rather than eedfc18 exactly.

## Verdicts

| Surface | Verdict |
| --- | --- |
| HUD detection block (arm machines, aim readout, state lines) | FIX (two MEDIUM, two LOW) |
| Debug aim ray | SHIP (one LOW note) |
| RATES block (unchanged by this merge) | SHIP |
| Palette compliance, both surfaces | PASS |
| Copy quality | PASS |

## Sampled colors

All samples taken from the saved PNGs in this directory (1440x900 CSS px).

- HUD text glyphs: #C9772E exactly, on every sampled row (y 30, 62, 94, 126,
  254). This is the panel's declared ember ink. No neon, no blue or cyan
  anywhere on the panel.
- HUD panel background: #1A130F (charcoal at 0.85 alpha over the hall).
- Degraded-reading accent (code inspection): #D0532F warm ink-red, firelight
  family. Not exercised on replay paths (rates block shows its null state).
- Aim ray, near the hand to far end: #DAAF5B, #CE9F4B, #BB8C3B, #AB7D31,
  #A5792E (r5p2-hud-extending-aim-ray.png); #D1A651 to #927022 on the
  retracted frame. Hue sits at 38 to 40 degrees with R > G >> B throughout:
  this reads as ember gold dimming with distance, not yellow neon. PASS.

## Issues

### HUD detection block

1. MEDIUM. Panel width jitters as values change. The panel is right-anchored
   with only max-width set (420px), so its rendered width follows the longest
   current line. Measured 272, 284, 332 and 338 px within one 8 second window
   as zone tokens swapped between CHEST, LATERAL_INNER and ABOVE_SHOULDER.
   The whole left edge, border and every line's start point lurch sideways
   several times per second during motion, which is exactly when you are
   trying to read it. The state column padding inside a line is stable (the
   padEnd(9) works; ext, bar and zone columns never shift within a line);
   it is the panel box itself that moves. Fix: set width, not just max-width.

2. MEDIUM. Stale state renders without the PAUSED flag during hand loss.
   Over the recorded jab-right fixture (right hand present in 103 of 233
   frames, left in none) the tracking-loss card came up and the arm lines
   froze at "L EXTENDED ext 3.45 [########] zone HIP" for tens of seconds
   with no PAUSED marker (r5p2-hud-after-jab-blast.png). The panel asserts a
   live EXTENDED state that is minutes old. PAUSED does render on the
   no-pose path (r5p2-hud-nopose-paused.png shows "zone NONE PAUSED"), so
   the flag plumbing works; the hand-confidence freeze path either does not
   set machine.paused or the arena stops feeding frames without telling the
   HUD. Either way the reader cannot distinguish "holding a pose" from
   "input died". Engine edits were in flight, so verify against the final
   tree before filing.

3. LOW. Zero-millisecond transition noise. "RETRACTED>EXTENDING 0ms" and
   "EXTENDED>RETRACTED 0ms" print constantly; entry transitions are
   instantaneous by definition, so 0ms conveys nothing and reads like a
   timing bug next to the genuinely informative "EXTENDING>EXTENDED 533ms".
   Consider suppressing the suffix when the duration is zero.

4. LOW. The aim readout carries no age. "aim yaw +21.3deg pitch -40.6deg"
   and "last move jab-blast" persisted unchanged through an entire replay
   loop. This matches the contract (last EMITTED aim) but nothing labels it
   as historical, and it sits directly above live per-frame lines.

Also observed, engine data rather than HUD rendering: extension values up to
3.49 rendered while hands were lost (contract expectation is roughly 0 to
1.35, with the jab overdrive gate at 1.35). The bar clamps so the panel
survives cleanly, but a reading near triple the overdrive gate suggests the
pose-only extension path is unnormalized. The HUD did its job by making this
visible; flag to the detection owner.

Non-issues verified: empty states are all legible and honest ("aim - (no
move emitted yet)", "raw -", "last move -", "profile default", "rates - (no
live probe)", "zone NONE PAUSED"). Longest observed line ("L RETRACTED ext
0.00 [--------] zone NONE PAUSED") fits the 420px budget with room to spare;
no wrapping or clipping seen at any state. Extension bar glyphs are a stable
ten characters and read instantly. The displayed fields cover the
PhaseEngineDebug contract completely and correctly (state, extension, zone,
paused, lastTransition per arm; lastAim as signed yaw/pitch degrees plus raw
components; lastMove; sustain and breath; learned reach; profile seeds; head;
parallax; rates).

### Debug aim ray

5. LOW. Attribution is good in motion, weaker at rest and during dropouts.
   When gloves render, the ray meets the firing fist cleanly
   (r5p2-hud-retracted-aim-ray.png, left fist). But when the firing arm's
   hand is untracked the ray floats with no visible anchor
   (r5p2-hud-extending-aim-ray.png: firing arm is the left, ext 0.48, and
   only the right glove is on screen). And at rest the positional preview
   aims steeply down (pitch around -40 deg), so the ray reads as a wire from
   the hand to the floor, running off the bottom edge. All of this is
   faithful to previewAim, which is the tool's whole point, so SHIP; but a
   short fade-in from the origin or a small origin tick would make the hand
   end unambiguous.

Ray palette and weight: correct. AIM_RAY_COLOR 0xe0a458 renders as sampled
above; the 1px line at 0.85 opacity is present but understated, visible over
both lit wood and shadow, invisible when the HUD is closed. It never reads
as a laser sight. Wood-block sensibility preserved.

### Copy

No em dashes anywhere in the HUD output (verified across roughly 100 sampled
text snapshots; separators are ASCII hyphens and ">"). No sentence starts
with a bare numeral. Labels are terse lowercase in the established style.
PASS.

## Reproduction

1. `npm run dev`, Chromium with `--use-fake-device-for-media-stream
   --use-fake-ui-for-media-stream` (not actually needed on replay routes).
2. Legacy synthetic fixture (no pose):
   `http://localhost:5173/?screen=arena&replay=jab-right`, press D. Expect
   both arms "RETRACTED ext 0.00 [--------] zone NONE PAUSED", empty aim
   lines, no ray (correct: pose null hides it), gloves in scene.
3. Recorded fixture with pose: the synthetic fixtures predate pose, so
   convert a take from fixtures/recorded/firebending-drill-2026-07-31.json
   into a LandmarkRecording (map takes[n].frames to {t, left, right, face:
   null, pose}, rebase t to frame 0, wrap in {version: 1, label, fps,
   frames}), save under fixtures/ and load with
   `?screen=arena&replay=fixtures/<name>.json`, press D. The
   alt-jab-combo-x3 take (both hands present) drives the machines through
   RETRACTED / EXTENDING / EXTENDED, emits jab-blast, and shows the ray;
   the jab-right-x5 take (no left hand ever) reproduces issue 2.
4. Width jitter: watch the panel's left edge over the alt-jab loop, or
   measure `getBoundingClientRect().width` at 150 ms intervals.

Screenshots in this directory:

- r5p2-hud-first-open.png: HUD just opened, empty aim readout, loss card.
- r5p2-hud-after-jab-blast.png: post-move EXTENDED lines, stale without
  PAUSED (issue 2), ext 3.45 anomaly.
- r5p2-hud-extending-aim-ray.png: mid-EXTENDING lines, ray visible,
  unanchored (issues 3, 5).
- r5p2-hud-retracted-aim-ray.png: both arms RETRACTED, ray anchored at the
  left fist.
- r5p2-hud-nopose-paused.png: no-pose empty state, PAUSED flags, no ray.
- r5p2-aim-ray-faint-rest.png: ray legibility floor over dark wood
  (#604D23 at its brightest there; still findable, arguably near the edge).
