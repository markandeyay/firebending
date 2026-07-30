# MORNING

Good morning. The overnight build ran phases 0 through 8. Everything below is in priority order.

## 1. Launch the game locally

```
npm install
npm run dev
```

Open http://localhost:5173/ in Chrome. You should see the black lacquer title screen with the FIREBENDING wordmark, drifting embers, and a wax-seal PLAY button. Click Play, allow the camera, raise both hands until the ink outlines ignite ("Bender recognized."), and you are in the arena: a firelit hall of vermilion columns, braziers, and a training construct 6m ahead. Punch at the camera to throw fire. Kill the construct and the camera travels to the next one.

No camera handy? Watch the game play itself on synthetic input:
http://localhost:5173/?replay=twin-cannon (also try flame-fan, fire-whip, cross-combo)

Useful debug scenes: `?debug=tracking` (skeletons), `?debug=moves` (gesture events + latency), `?debug=arena`, `?debug=fire`, `?debug=perf` (perf gate; run it in a FOCUSED window, background tabs throttle and stall it).

## 2. Record real gesture sessions (the single highest-value thing you can do)

Every gesture threshold is tuned on synthetic data only and flagged PROVISIONAL in tracker 16.5.

1. Open tools/capture.html in Chrome (if models fail from file://, run `python -m http.server` in the repo root and open http://localhost:8000/tools/capture.html).
2. Start the camera. Verify: raise your LEFT hand, the overlay tag on it must read L (if it reads R, tick "Swap hands" and note it in the tracker). Turn your head right: yaw readout goes positive. Look up: pitch positive.
3. For each label chip (jab-blast, fire-stream, cross-combo, palm-wave, flame-fan, twin-cannon, rising-flame, fire-whip, breath-charge, idle, talking): Record after the countdown, perform the move 3 to 5 times with short rests, Stop, Download, and save the file into fixtures/recorded/.
4. Re-run the gesture suite: `npx vitest run tests/moves.test.ts tests/poses.test.ts` (currently runs against synthetic fixtures). Then judge the live feel directly at `?debug=moves&live`, which shows every trigger, miss, and latency. Tune the exported threshold constants at the top of src/gestures/moves.ts and src/gestures/poses.ts against what you see. Known issues to check first: grip hysteresis was lowered to 0.45/0.28 (spec wanted 0.75/0.55) because synthetic grip and fist are nearly identical, and the replay path needs velocityScale 1.8 because One Euro filtering attenuates synthetic thrusts about 45 percent. Real recordings will tell you the true values.

## 3. HUMAN items, by importance (full list in firebending.md 16.4)

1. Play the full flow live and judge gesture feel. This is the product.
2. Record gesture sessions (section 2 above) and retune thresholds.
3. Deploy (section 4 below). Needs your credentials.
4. Verify handedness invariant and head yaw/pitch signs on a real camera (raise left hand, L slot lights in `?debug=tracking&live`).
5. Visual judgment passes: arena composition (`?debug=arena`), fire shaders (`?debug=fire`), title/calibration polish, HUD legibility, construct wobble and debris feel, tier-2 armor silhouette.
6. Audio with ears: jab reads as air not static, twin-cannon sub audible on laptop speakers, ambient bed level, master headroom. All synthesis constants are exported in src/audio/engine.ts.
7. Vendor an open-licensed brush display font (woff2 into the repo, @font-face in src/ui/theme.css); current stack is system serif and reads engraved rather than brushstroke.
8. Rerun `?debug=perf` in a focused window to confirm the recorded PASS (median 16.70ms, vsync-locked 60fps, zero dropped frames).
9. Decide: keep MediaPipe models/WASM on Google/jsdelivr CDNs, or vendor locally. Video never leaves the device either way.
10. Live-check hardening: cover the camera 2s in the arena (pause overlay + 3-2-1 ember resume), play one-handed 2s (hint chip), simulate WebGL context loss in devtools.

## 4. Deploy (everything is prepped, you provide credentials)

Both configs are committed (vercel.json, netlify.toml). The build is static, self-contained, relative paths, 239 kB gzipped JS excluding WASM. Pick one:

Vercel:
```
npx vercel login
npx vercel --prod
```

Netlify:
```
npx netlify-cli login
npx netlify-cli init
npx netlify-cli deploy --prod --build
```

Then swap the README line `**Try it:** deploy pending, see MORNING.md` for the live URL, commit, push, and consider tagging phase-8-complete (the only unmet Phase 8 exit criterion is the public URL).

## 5. Five lines

Built overnight: a complete webcam firebending game. Tracking pipeline, 9-move gesture engine (339 tests green), firelit arena, GPU-instanced fire VFX, physics constructs with a kill-travel-next director chain, synthesized audio, full title-to-arena flow, hardening, README, deploy configs, three gameplay GIFs, tagged v0.1.0.
Provisional: every gesture threshold (synthetic-only tuning), all audio levels and visual feel (built headless, never seen or heard by a human), the lowered grip hysteresis, and the replay velocityScale 1.8 workaround.
Fixed live during browser verification: a flame-wipe race that could hang the screen transition, and a fixture-URL bug in the arena dev entry.
Deploy is one login away; everything else ships.
The single most important thing to verify by playing: stand at your laptop and throw a real punch. If Jab Blast fires reliably for your hands, in your lighting, at your distance, the game works; if not, the thresholds in section 2 are where to spend your morning.
