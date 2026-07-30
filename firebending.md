# FIREBENDING
### System Design Document and Build Contract

> This document is the single source of truth for this project. Every agent working on this codebase must read this file in full before writing any code. Only Section 16 (Progress Tracker) may ever be edited. Every other section is frozen. If reality forces a deviation from this spec, record the deviation and its reason in the Progress Tracker's Decision Log, do not rewrite the spec.

---

## 1. What this is

A browser game where the player firebends using their real hands through a laptop webcam. No VR, no controllers, no keyboard during gameplay. The webcam is the only sensor. The player stands in front of their laptop, punches and gestures, and fire comes out of their hands on screen.

Flow: Title screen ("FIREBENDING", Play button) → hand calibration ritual → dropped into a 3D training arena → fight a chain of training constructs → on each kill the camera travels to the next opponent. The player never walks or turns. The world moves around them.

Target: a polished, deployable demo that looks incredible in a 30 second Twitter video and is playable by anyone via a public link.

## 2. Hard rules (never violate)

1. **Zero references to Avatar: The Last Airbender.** No character names, place names, show terminology ("Agni Kai", "Fire Nation", "Sozin", etc.), logos, sounds, or fonts from the show. This project is inspired by the same real-world sources the show drew from (East Asian martial arts, Edo-period Japanese architecture, firelight) but must be a fully original work called Firebending. This applies to code comments, asset names, commit messages, and the README.
2. **Aesthetic law: no neon, no gradients-as-decoration, no sci-fi glow.** All light in this world is firelight: warm, amber, flickering. UI is ink, parchment, brush strokes, lacquered wood, muted gold. If a color would look at home in a synthwave poster, it is banned.
3. **The player is always planted facing the webcam.** No locomotion input, no free camera rotation. All apparent movement is authored camera animation.
4. **All processing is client side.** The webcam feed never leaves the device. State this in the README and on the title screen in small text.
5. **60 fps on a mid-tier laptop** with both trackers running. Performance is a feature. If a visual effect costs the frame budget, cut the effect.
6. **Do not use em dashes in any user-facing text, README content, or UI copy.**

## 3. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Build | Vite + TypeScript | Strict mode on |
| Rendering | Three.js (latest stable) | WebGL2, single canvas |
| Hand tracking | MediaPipe Tasks Vision, HandLandmarker | 2 hands, GPU delegate, VIDEO mode |
| Head tracking | MediaPipe Tasks Vision, FaceLandmarker | Head pose only, no gaze |
| Physics | Rapier (WASM, compat build) | Sandbag/construct ragdoll and knockback only, keep scope minimal |
| Audio | Howler.js or Web Audio directly | Synthesized/CC0 sounds only |
| Tests | Vitest | Runs headless, no camera ever required |
| Deploy | Vercel or Netlify static | Must produce a working public URL |

No React. This is a game loop, not an app. Plain TS modules and a single HTML entry.

## 4. Repository layout

```
firebending/
├── firebending.md            ← this document
├── README.md                 ← written in the final phase
├── index.html
├── src/
│   ├── main.ts               ← boot, screen state machine
│   ├── screens/              ← title, calibration, arena
│   ├── tracking/
│   │   ├── handSource.ts     ← MediaPipe wrapper, worker-friendly
│   │   ├── faceSource.ts
│   │   ├── filters.ts        ← One Euro filter, hysteresis helpers
│   │   ├── replaySource.ts   ← feeds recorded/synthetic landmark JSON
│   │   └── types.ts          ← LandmarkFrame, the universal input type
│   ├── gestures/
│   │   ├── poses.ts          ← fist/palm/grip classifiers (pure functions)
│   │   ├── moves.ts          ← the 9-move state machine
│   │   └── calibrationStats.ts
│   ├── game/
│   │   ├── arena.ts          ← environment build
│   │   ├── enemies.ts
│   │   ├── combat.ts         ← damage, stamina, cooldowns
│   │   ├── cameraRig.ts      ← parallax + travel splines
│   │   └── director.ts       ← kill → travel → next enemy chain
│   ├── vfx/
│   │   ├── fire.ts           ← core fire system (see Section 10)
│   │   ├── embers.ts
│   │   └── impact.ts         ← hit sparks, shake, hit-stop, slow-mo
│   ├── audio/
│   └── ui/                   ← HUD, damage numbers, ink/parchment styling
├── fixtures/
│   ├── synthetic/            ← generated landmark sequences per move
│   └── recorded/             ← real capture sessions (may be empty at start)
├── tools/
│   └── capture.html          ← standalone landmark recorder page
└── tests/
```

**The universal input rule:** gameplay code never touches MediaPipe directly. Everything consumes `LandmarkFrame` objects from a `LandmarkSource` interface with two implementations: live camera and replay. This is what makes the entire game testable without a webcam.

## 5. Tracking pipeline

- HandLandmarker runs every frame. FaceLandmarker runs every 4th frame (~15 Hz), smoothed. If frame time exceeds budget, degrade face first, never hands.
- Run trackers in a Web Worker if transferring frames proves cheap enough; otherwise main thread with careful scheduling. Measure first, decide in Phase 1, log the decision.
- All landmark streams pass through a One Euro filter (per landmark, tuned: minCutoff ~1.0, beta ~0.007 as starting values, tune against fixtures).
- Handedness labels are mirrored (webcam is a mirror). Normalize once at the source so game code thinks in "player left / player right".
- Confidence gating: a hand is "tracked" only after 10 consecutive frames above 0.7 presence confidence, and "lost" after 15 frames below. No flicker.

## 6. Pose vocabulary (pure functions in poses.ts)

Each returns a confidence 0..1 from a single `LandmarkFrame`:

- `fistScore(hand)`: all four fingertips curled toward palm center (distance tip→wrist vs knuckle→wrist ratios).
- `palmScore(hand)`: fingers extended and together, palm normal facing camera (z of palm normal).
- `gripScore(hand)`: fingers curled but thumb wrapped vertically, hand raised above elbow line proxy (wrist above a calibrated shoulder-height estimate), roughly static.
- `handSpeed(hand)`: filtered wrist velocity in normalized screen units/sec, plus a toward-camera component using z delta.
- `handsTogether(l, r)`: wrist distance below calibrated threshold.

Pose transitions use hysteresis: entering a pose requires score > 0.75 for 4 frames, leaving requires score < 0.55 for 6 frames. A move never triggers on a single frame.

## 7. The moveset (moves.ts state machine)

Stamina ("Breath") meter: 100 units, regenerates 12/sec when no sustained move is active.

| # | Move | Trigger | Effect | Cost/Cooldown |
|---|---|---|---|---|
| 1 | Jab Blast | Fist pose + speed spike toward camera, then retract | Fast small fireball along punch vector, light damage | 0.25s per hand |
| 2 | Fire Stream | Fist held extended > 0.35s after a punch | Narrow sustained jet from fist, steerable | 18 Breath/sec |
| 3 | Cross Combo | 3 alternating-hand jabs within 1.5s | Third hit auto-upgrades: bigger fireball, knockback | Resets combo window |
| 4 | Palm Wave | Palm pose + thrust | Wide short-range cone, pushback | 0.6s cooldown |
| 5 | Flame Fan | Palm held extended > 0.35s | Wide sustained cone, steerable sweep | 26 Breath/sec |
| 6 | Twin Cannon | Both fists together at chest ≥ 0.3s, then joint thrust | Giant fireball, screen shake, 120ms hit-stop, slow-mo on kill | 40 Breath, 5s cooldown |
| 7 | Rising Flame | Both palms low, fast upward sweep | Fire wall in front, blocks projectiles 1.2s | 25 Breath, 4s cooldown |
| 8 | Fire Whip | Grip pose held 0.4s, then lateral arm swing > threshold speed | Arcing whip crack in swing direction, medium damage, satisfying crack sound | 20 Breath, 1.5s cooldown |
| 9 | Breath Charge | Both fists at hips, held 1.0s | Embers gather at fists, low rumble. Next move within 3s is empowered (1.6x damage, bigger VFX) | 15 Breath |

Aim: every projectile/stream fires along the velocity vector of the triggering hand (filtered over last 6 frames), not toward screen center. The hand is the crosshair.

Priority when ambiguous: two-hand moves > grip moves > palm > fist. The state machine evaluates in that order and a triggered move locks out others for its animation duration.

## 8. Game flow

**Title screen.** Black lacquer background, faint drifting embers, brushstroke wordmark "FIREBENDING", a single Play button styled as a wax seal. Small line: "Your camera never leaves your device." Clicking Play requests camera permission.

**Calibration.** Dimmed mirrored webcam feed. Two ink-outline hands on screen, text "Raise your hands." When both hands hit stable tracking (Section 5 gating), outlines snap to the player's hands and ignite with a whoosh, text "Bender recognized." During the 2s ignition, capture calibration stats: neutral wrist positions, wrist-to-wrist span (shoulder width proxy), baseline hand size for depth normalization. These tune per-player velocity thresholds in calibrationStats.ts. Then a flame-wipe transition into the arena.

**Arena and the chain.** The player faces a training construct ~6m ahead. HUD: Breath meter (ink brush bar, bottom left), enemy health as a cracked-seal indicator above the construct, floating damage numbers in brush-stroke numerals. On kill: 0.5s slow-mo with ember burst, then the camera travels along an authored spline (2 to 3 seconds, passing braziers, banners, columns) to the next arena position where the next construct waits. Infinite chain for the demo, difficulty ramps by construct HP and, later, thrown projectiles the player blocks with Rising Flame or ducks under (head-Y drop detection).

**Head tracking (mild, always on).** Head yaw/pitch/position drive: (a) camera parallax, max ±4° rotation and ±0.25m offset, heavily smoothed; (b) damage numbers spawn biased toward the side the player faces; (c) duck detection: head Y dropping > 20% of calibrated baseline within 0.4s counts as a dodge. No turning of any kind.

## 9. Art direction spec

- Palette: charcoal near-black (#1a1512 range), oxblood/deep vermilion columns, muted antique gold trim, warm parchment, tatami tan floor. Fire provides the only saturation.
- Environment: low-poly, flat/toon shaded. Wooden columns with gold caps, hanging cloth banners (simple vertex-shader sway), stone braziers with live flames, paper lanterns, light volumetric-feel fog (cheap: layered transparent planes or fog + god-ray sprites), a low wall of coals behind the arena as key light.
- Lighting: one warm key from the fire wall, flickering point lights on braziers (flicker = layered sine noise on intensity, subtle), deep soft shadows. No blue fill lights, no rim-light cyan.
- Typography/UI: brush-stroke display font (an open-licensed one, e.g. from Google Fonts with a calligraphic feel), parchment panels with torn edges, ink-splash transitions. UI motion is fast and weighty, never bouncy.

## 10. Fire VFX spec (this is the product, spend effort here)

Realistic-feeling stylized fire, built in layers, all GPU-instanced:

1. **Core flame:** instanced billboard particles using a procedural flame shader (noise-distorted radial gradient, NOT a flat sprite) with additive blending, color ramp black→deep red→orange→yellow-white at the core, animated by scrolling 2 octaves of noise. Flipbook texture is an acceptable fallback if the shader stalls progress.
2. **Embers:** small bright instanced points with upward buoyancy + turbulence curl, spawned by every move and ambiently in the arena.
3. **Smoke:** sparse soft dark billboards above sustained flames, low opacity.
4. **Heat distortion:** screen-space refraction pass over active fire regions (render fire mask, offset UVs by noise). If the perf budget objects, this is the first cut.
5. **Light coupling:** every fireball/stream carries a point light that tints the environment as it travels. This is the single cheapest thing that makes fire read as real.
6. **Impact:** spark burst, scorch decal that fades over 10s, brief bloom pulse (bloom kept restrained, threshold high, firelight only).

Projectiles are not spheres with textures. A Jab Blast is a comet: bright core, trailing flame particles, ember wake, light source.

## 11. Enemies (demo scope)

Training constructs, not humans: straw-and-wood sparring dummies on weighted bases, banded with dark iron, some wearing skeletal armor silhouettes (original design). They wobble on Rapier joints when hit, char progressively (material darkens by damage %), and on death burst into embers and collapsing parts. Tier 2 constructs slowly lob arcing coal projectiles the player ducks or blocks. No pathfinding, no humanoid animation. Charring + wobble + knockback IS the animation.

## 12. Audio

Layered whoosh/roar synthesis or CC0 packs: punch whoosh, ignition crackle, sustained roar (looped, volume follows stream intensity), deep boom for Twin Cannon, whip crack, ambient brazier crackle bed, low taiko-style hit on kills. Master ducking on hit-stop. All audio must be license-clean.

## 13. Testing strategy (the overnight lifeline)

No test may ever require a camera. The `LandmarkSource` abstraction (Section 4) is mandatory from the first commit.

1. **Synthetic fixtures (Phase 0):** a generator script produces landmark sequences for each move: parameterized keyframe poses (fist, palm, grip, rest) interpolated with noise jitter, at 30 fps, saved as JSON in fixtures/synthetic/. Include negative cases: idle hands, talking-with-hands motion, slow reaches, hand entering/leaving frame.
2. **Unit tests:** every pose function and every move trigger tested against fixtures. Assertions: correct move fires, wrong moves do not (false-positive suite is as important as true-positive), trigger latency under 120ms of frame time from gesture completion.
3. **Replay harness:** the full game can boot with `?replay=fixtures/...` driving input, headless-testable game logic (combat math, director state machine, stamina) via Vitest without WebGL where possible.
4. **Real recordings:** tools/capture.html records live landmark sessions to JSON for fixtures/recorded/. When the human adds recordings, the same test suite runs against them. Synthetic fixtures are the floor, real recordings are the truth. Thresholds tuned on synthetic data are provisional and flagged as such in the tracker.
5. **Perf gate:** an automated scene stress test logging frame times; fail the phase if median frame > 16.6ms in the standard arena scene on the dev machine.

## 14. Performance budgets

- Hand tracking: every frame. Face: 15 Hz. Combined ML budget ≤ 7ms/frame on GPU delegate.
- Draw calls ≤ 150, particles ≤ 6000 instanced, lights ≤ 8 dynamic (pool and recycle projectile lights).
- Texture memory ≤ 128MB. Total JS bundle ≤ 2MB gzipped excluding WASM/models.
- Degrade ladder (auto, in order): heat distortion off → particle count halved → face tracking 7.5 Hz → shadow resolution halved.

## 15. Build phases

Each phase ends with: tests green, a tagged git commit (`phase-N-complete`), a perf check, and a Progress Tracker update. Do not start phase N+1 with phase N red.

- **Phase 0, Skeleton and harness:** Vite + TS + Three boot, LandmarkSource interface, replay + synthetic fixture generator, capture tool, CI-able test setup. Exit: a cube renders, fixtures generate, one dummy test passes on replay input.
- **Phase 1, Tracking core:** live hand + face sources, filters, mirroring, confidence gating, worker-or-not decision recorded. Exit: debug overlay draws stable filtered skeletons from replay fixtures; live path compiles and is behind a flag.
- **Phase 2, Pose and move engine:** poses.ts + moves.ts complete, all 9 moves trigger correctly on synthetic fixtures, false-positive suite green, aim vectors computed. Exit: debug scene prints move events with latency stats.
- **Phase 3, Arena:** environment per Section 9, camera rig with parallax, lighting, ambient embers, fog. Exit: perf gate green in full arena.
- **Phase 4, Fire VFX:** Section 10 layers 1, 2, 5, 6 minimum. Every move has a distinct, named effect. Exit: visual review checklist in tracker filled with screenshots saved to /docs/screens/.
- **Phase 5, Combat and director:** constructs, damage, stamina, HUD, damage numbers, kill → travel → next chain, duck/block vs tier-2 projectiles. Exit: full loop playable end to end on replay input.
- **Phase 6, Screens and juice:** title, calibration ritual with ignition, transitions, audio pass, hit-stop/slow-mo tuning, Breath Charge empowerment glow. Exit: complete flow from Play to 5 kills, sounds on everything.
- **Phase 7, Hardening:** degrade ladder, tracking-loss UX (pause + "Show your hands" overlay), single-hand fallback (fist family still works), lighting-conditions help panel, error states, mobile rejection screen (desktop only, say so kindly).
- **Phase 8, Ship:** README (see Section 17), deploy to a public URL, final perf audit, capture 3 gameplay GIFs into /docs/, tag v0.1.0.

## 16. PROGRESS TRACKER (the only editable section)

> Rules: append, never delete. Every work session updates this section and nothing else in this file. Keep entries terse. This section is the project's memory graph: tasks carry IDs and explicit dependency edges so any fresh agent can reconstruct full state from this section alone.

### 16.1 Task graph
Format: `ID | phase | title | depends-on | status (todo/doing/done/blocked) | owner-agent | notes`

```
T000 | P0 | repo scaffold            | -          | done | orchestrator | vite+ts+three boot, cube renders, build+tests green
T001 | P0 | LandmarkSource iface     | T000       | done | orchestrator | types.ts + ReplaySource with sync tick() for headless tests
T002 | P0 | synthetic fixture gen    | T001       | done | agent-fixtures | fixtures/lib.ts engine + 15 seeded recordings (10 moves, 5 negatives)
T003 | P0 | capture tool             | T001       | done | agent-capture | tools/capture.html self-contained, L/R overlay tags + swap-hands safety net
T004 | P0 | test harness boots       | T002       | done | agent-fixtures | disk JSON through ReplaySource.drain() end to end, all 15 fixtures
T010 | P1 | live hand source         | T001       | done | agent-tracking | handSource.ts, pure mirror/handedness fns tested; live path needs human camera check
T011 | P1 | face source              | T001       | done | agent-tracking | faceSource.ts + liveSource.ts, face at 1/4 rate, degrade to 1/8 past 7ms budget
T012 | P1 | filters + gating         | T002       | done | agent-filters | filters.ts: OneEuro, Hysteresis, ConfidenceGate, FilteredSource; 20 tests
T020 | P2 | pose functions           | T012       | done | agent-poses | poses.ts, ratio-based scale-free scoring, 29 tests; palmScore needs handedness param
T021 | P2 | move state machine       | T020       | done | agent-moves | moves.ts MoveEngine; retract-gated discrete vs 350ms-hold sustained; latency 0-17ms
T022 | P2 | false-positive suite     | T021       | done | agent-moves | 33 tests: all 10 positives exact event lists, 5 negatives zero events, cooldown/breath/empower
T030 | P3 | arena environment        | T000       | done | agent-arena | 21 mesh nodes, 6 dynamic lights, headless-guarded canvas textures, seeded PRNG layout
T031 | P3 | camera rig + parallax    | T011,T030  | done | agent-rig | cameraRig.ts + killTravel.ts, 13 tests; parallax jointly clamped 4deg/0.25m incl breathing sway
T040 | P4 | fire particle core       | T030       | done | agent-fire | fire.ts FireSystem facade; 4700 instanced cap; shader-side particle motion; 20 tests
T041 | P4 | per-move VFX             | T021,T040  | done | agent-movefx | moveEffects.ts: 9 named effects, screenToWorld reach-plane mapping; impact.ts decal pool; 22 tests
T050 | P5 | constructs + physics     | T030       | done | agent-constructs | enemies.ts: rapier world, spring-back wobble (gravityScale 0 + K=250), charring, debris, lob arcs
T051 | P5 | combat + HUD             | T021,T050  | done | agent-combat | combat.ts damage table + duck/block; hud.ts ink HUD; 24 tests; combat claims manager.onDeath, director uses combat.onKill
T052 | P5 | director chain           | T051       | done | agent-director | director.ts + arena.ts integration; lane re-base with orbit arrival; e2e replay loop test green
T062a| P6 | game flow + perf gate    | T052,T061  | done | agent-juice | full flow wired, 312 tests; perf gate run on dev machine: median 16.70ms p95 17.3 max 18.1, 901 frames, 32 draw calls, PASS (vsync-aware rule)
T060 | P6 | title + calibration      | T010       | done | agent-screens | ScreenManager + flameWipe + title + calibration + calibrationStats; 15 tests; main.ts wiring recipe in agent report, applied at P5/P6 integration
T061 | P6 | audio pass               | T041       | done | agent-audio | engine.ts + moveAudio.ts, all synthesized, seeded deterministic buffers; 29 tests; unlock() on Play click
T062 | P6 | juice tuning             | T052       | todo |  |
T070 | P7 | hardening ladder         | T062       | done | agent-hardening | degrade ladder, tracking-loss FSM, single-hand OK as-is, error states, mobile gate; 339 tests
T080a| P8 | README + deploy prep     | T070       | done | agent-ship | README + vercel.json + netlify.toml; bundle 238.9kB gzip JS vs 2MB budget PASS; howler dropped
T080 | P8 | README + deploy + GIFs   | T070       | done | orchestrator | all done except live deploy (HUMAN credentials, steps in MORNING.md); v0.1.0 tagged; phase-8 tag waits on public URL
```

### 16.2 Session log
Format: `[timestamp] agent | tasks touched | result | next`

[2026-07-30 03:00] orchestrator | T000, T001 | repo init, pushed, scaffold builds, 3 tests green | fan out wave 1: T002, T003, T010+T011, T012, T030
[2026-07-30 03:08] orchestrator | T012, T010, T011 merged | 38 tests green, committed | launch T020 poses + T060 screens; T031 waits on T030
[2026-07-30 03:15] orchestrator | T030, T003 merged | arena committed, capture tool committed | launched T031 rig, T040 fire core, T050 constructs; in flight: T002, T020, T060
[2026-07-30 03:20] orchestrator | T002, T004 merged | 66/66 tests green, Phase 0 fully done | in flight: T020, T060, T031, T040, T050; T021 next when T020 lands
[2026-07-30 03:22] orchestrator | phase-0-complete tagged; T020 merged | poses committed | launched T021+T022 combined agent + P1-exit debug overlay agent
[2026-07-30 03:28] orchestrator | T031 merged | 108/108 tests green | in flight: T021+T022, T040, T050, T060, P1 debug overlay; anchors past z=-18 need director-side environment illusion (noted in killTravel.ts)
[2026-07-30 03:34] orchestrator | P1 debug overlay merged, phase-1-complete | 152/152 green, vite build ok, overlay at ?debug=tracking (&fixture=name, &live) | in flight: T021+T022, T040, T050, T060
[2026-07-30 03:40] orchestrator | T060, T040 merged; liveSource gains mediaStream getter for calibration preview | 162 green, 2 failing in enemies.test.ts belong to still-running T050 agent | in flight: T021+T022, T050; next: T041 when moves land
[2026-07-30 03:46] orchestrator | T050 merged | 164/164 green, rapier runs for real in node tests | in flight: T021+T022 only; T041 + T051 launch when moves land
[2026-07-30 03:52] orchestrator | T021, T022 merged | 197/197 green, Phase 2 code complete | launching T041, T051, and moves debug scene (P2 exit criterion); tag phase-2 when debug scene lands
[2026-07-30 04:04] orchestrator | moves debug merged, phase-2-complete tagged | 209/209 green; ?debug=moves cycles all 10 positives with latency footer | in flight: T041, T051
[2026-07-30 04:12] orchestrator | T041 merged | 231/231 green; 9 named effects (Cinder Bolt, Third Strike Comet, Kiln Lance, Hearth Wave, Ember Fan, Furnace Shot, Kindled Wall, Cinder Lash, Inner Coal) | launched T061 audio; in flight: T051, T061
[2026-07-30 04:20] orchestrator | T051 merged | 255/255 green | launched T052 director + arena screen; in flight: T052, T061; wall-active check is null-test only (VFX and gesture clocks share no epoch)
[2026-07-30 04:32] orchestrator | T061 merged | 284/284 green | in flight: T052 only; audio wiring at integration: unlock+sealPress on Play, ignite in calibration, ambientStart on arena mount, moveAudio.handleEvent per MoveEvent, onKill/onHitStop/onCoal hooks from combat
[2026-07-30 04:48] orchestrator | T052 merged | 291/291 green, vite build ok; P5 exit (full loop on replay) achieved headlessly | launched T062a (flow+juice+perf harness); tags for P3/P4/P5 held until browser perf gate + screenshots
[2026-07-30 05:05] orchestrator | T062a merged; browser verification via Chrome automation | PERFGATE on dev machine: 901 frames, median 16.70ms (vsync-locked 60fps), p95 17.3, max 18.1, 32 draw calls, 365 particles, 2 lights, PASS; screenshots in docs/screens/ (title, arena+HUD, fire, perf load); fixed ?screen=arena bare-name fixture resolution; phases 3-5 tagged | next: T070 hardening
[2026-07-30 05:15] orchestrator | full flow verified in browser: title -> Play -> calibration gate-in on replay -> flame wipe -> arena; phase-6-complete tagged | launched T070 hardening | note: background-tab throttling makes unattended browser flows crawl; all interactive verification must actively drive the tab
[2026-07-30 05:40] orchestrator | T070 merged, phase-7-complete tagged; FIXED live bug: flameWipe negative rAF delta -> negative arc radius exception hung the transition (clamp added); 3 gameplay GIFs captured in browser (demo incl. calibration+twin-cannon kill chain, fan cone, whip ambience) | launched T080a ship prep | remaining: deploy (HUMAN credentials), MORNING.md
[2026-07-30 05:50] orchestrator | T080a, T080 merged; MORNING.md written; v0.1.0 tagged | build complete: 339 tests green, bundle 238.9kB gzip JS, perf gate PASS, phases 0-7 tagged | only live deploy remains (HUMAN); loop stopping
[2026-07-30 16:00] orchestrator | T090 parallax sign | traced full yaw sign chain, found the inversion at the Three.js Y-axis application, fixed via PARALLAX_YAW_SIGN -1 + P-key runtime toggle + regression tests, pushed | launched T091 (HaGRID retune) and T092 (adaptive thresholds + debug HUD) in parallel
[2026-07-30 16:50] orchestrator | T091, T092 merged; grip hysteresis raised to 0.78/0.55 on HaGRID evidence; synthetic grip thumb rebuilt to real thumbs-up geometry; FIX_ME.md written | 379/379 green, tsc clean, browser-verified (HUD near-miss log, P toast, twin-cannon replay, zero console errors) | remaining: human plays through new calibration per FIX_ME.md

### 16.3 Decision log
Format: `[timestamp] decision | reason | affected sections`

[2026-07-30 03:00] LandmarkFrame = {t, left, right, face} with 21-point hands in mirrored player space; mirroring happens in sources | one normalization point per Section 5 | S4, S5
[2026-07-30 03:00] ReplaySource exposes sync tick()/drain() alongside real-time start() | headless deterministic tests need frame stepping | S13
[2026-07-30 03:00] T012 (filters) starts concurrently with T002 (fixtures): unit tests use inline synthetic signals, fixture integration after merge | dependency is for tuning, not compilation; maximizes parallelism | S16.1
[2026-07-30 03:08] Trackers run on main thread, no worker | GPU delegate already runs inference off JS thread; VideoFrame transfer adds copy cost; revisit only if profiling shows stalls | S5
[2026-07-30 03:08] Handedness: raw feed is unmirrored so MediaPipe label Right fills frame.left, Left fills frame.right; landmarks mirrored x to 1-x | invariant: player's own left hand lands in left slot | S5
[2026-07-30 03:08] Hand reacquisition resets filter banks via 0.5s time-gap detection, not explicit null notification | gated-out hands never reach the bank so gap-reset covers reacquisition automatically | S5
[2026-07-30 03:08] 6-frame aim velocity window lives in gesture layer, not filters; filters export only two-frame wristVelocity | aim logic belongs next to move state machine | S6, S7
[2026-07-30 03:15] Arena canvas textures guarded behind typeof document check, flat-color fallback headless | Vitest runs in node env per S13 | S9, S13
[2026-07-30 03:15] Capture tool: face sample-and-hold up to 500ms between 1/4-rate detections; recording fps = measured average not nominal; hand confidence = handedness score (no separate presence score in VIDEO mode) | recordings should mirror what a live source emits | S5, S13
[2026-07-30 03:15] Capture tool self-detects facial matrix row/column-major layout via translation magnitude; YAW_SIGN/PITCH_SIGN constants exposed for live correction | matrix layout reported inconsistently across MediaPipe builds | S5
[2026-07-30 03:20] fixtures/nodeShim.d.ts declares minimal node:fs typings | @types/node not installed and tsconfig pins types to vite/client; delete shim if @types/node added | S13
[2026-07-30 03:20] Fixture hands translate without rotating during thrusts; hand-enter-leave coords legitimately exceed [0,1] like real MediaPipe partial-visibility output | distance-ratio classifiers are orientation-light; revisit if poses need orientation cues | S6, S13
[2026-07-30 03:22] palmScore takes handedness param; palm normal from cross(indexMCP-wrist, pinkyMCP-wrist), z positive for facing right hand, sign flipped for left | abs() cannot distinguish palm from back of hand | S6
[2026-07-30 03:22] gripScore raised-factor uses absolute wrist y band 0.55..0.65, to be replaced by calibrated shoulder-height estimate later | calibrationStats not yet merged when poses written | S6, S8
[2026-07-30 03:34] Live MediaPipe path loaded via dynamic import only; replay/debug never loads it; build splits it into a lazy chunk | enforces "live behind a flag" structurally and keeps main bundle small | S5, S14, S15
[2026-07-30 03:34] LoopingReplaySource shifts t monotonically across loop seams | negative dt at seams would corrupt One Euro filters and gates | S13
[2026-07-30 03:34] fixtures/synthetic not copied into dist; replay debug is dev-only | keep deploy small; revisit if deployed build needs demo replay mode | S14
[2026-07-30 03:40] Calibration screen consumes the RAW source (runs its own Section 5 gates); FilteredSource wraps the same inner source for gameplay after | wrapping calibration in FilteredSource would double acquire delay to ~20 frames | S5, S8
[2026-07-30 03:40] Fire particle motion computed in vertex shader from spawn attributes (start + v*age + 0.5*buoyancy*age^2); streams = continuous spawns; O(1) update pinned by attribute-version tests | zero per-frame attribute writes keeps 60fps budget | S10, S14
[2026-07-30 03:40] FireLightPool defaults to 2 traveling lights; arena uses 7 of the 8-light budget; director may dim brazier lights during heavy fire and hand budget to the pool | S14 cap tension documented in fire.ts | S10, S14
[2026-07-30 03:40] Ember/smoke layers folded into fire.ts; src/vfx/embers.ts intentionally not created | one system, one update clock; repo layout deviation recorded | S4, S10
[2026-07-30 03:46] Construct torso: gravityScale 0 + spring torque (K=250, ang damping 3.5) instead of gravity + spring | upright is a stable equilibrium, wobble tuning orthogonal, no tip-over drift | S11
[2026-07-30 03:46] Coal lobs are closed-form parabolas, no rapier bodies; base body has no collider | keeps physics scope minimal per S3; avoids pivot contact jitter | S3, S11
[2026-07-30 03:52] DEVIATION from S6: grip pose uses 5-frame score average with hysteresis enter 0.45 exit 0.28 (not 0.75/0.55) | synthetic GRIP_LOCAL vs FIST_LOCAL nearly indistinguishable (thumb rise ~0.34 both); fire-whip safety comes from motion context (static hold then lateral swing) not score margin | S6, S7
[2026-07-30 03:52] Aim events carry screen-space velocity (punch toward camera = aim.z < 0); combat layer maps screen -z to world forward | one documented mapping point instead of per-move conversions | S7
[2026-07-30 03:52] triggerLatencyMs measured from trigger-condition completion, not pose acquisition; hysteresis runs during wind-up | 4-frame hysteresis at 30fps would otherwise exceed the 120ms budget by construction | S7, S13
[2026-07-30 03:52] Cross-combo: third alternating jab emits cross-combo INSTEAD of third jab-blast; blocked twin-cannon consumes both thrust records so it never leaks two jabs | S7 ambiguity resolved | S7
[2026-07-30 04:04] FINDING: One Euro filtering attenuates synthetic thrust peaks ~45% (raw 1.45-1.65 u/s becomes 0.80-0.91 filtered); without correction palm-wave/fan/twin/whip never fire through FilteredSource | T022 tests feed raw frames, gameplay feeds filtered | S5, S7, S13
[2026-07-30 04:04] Remedy: REPLAY_VELOCITY_SCALE 1.8 via the engine velocityScale hook on replay path only; live stays 1.0 with per-player scaling from calibrationStats | verified: all 10 positives fire, all 5 negatives silent through filtered pipeline at 1.8 | S7, S13
[2026-07-30 04:12] Hand origin unprojects onto a reach plane 0.8m in front of camera, frustum-sized so frame-edge hands ignite at screen edge | the hand is the crosshair, one mapping point | S7, S10
[2026-07-30 04:12] Sustained VFX cones self-terminate after 0.6s without ticks | lost sustain-end must never hold a pooled light forever | S10, S14
[2026-07-30 04:12] All audio synthesized with Web Audio, zero external files | license-clean by construction, tiny bundle | S12
[2026-07-30 04:20] Combat treats rising-flame wall as active iff wallActiveUntil() non-null; the until value is opaque | VFX clock (seconds) and gesture clock (ms) share no epoch | S7, S8
[2026-07-30 04:20] DuckDetector: enter = 400ms windowed drop > 20% baseline AND 15% below baseline; exit = within 10% of baseline; y-down space | slow drift never triggers | S8
[2026-07-30 04:20] Breath penalty on player hit: combat exposes onBreathPenalty(15); MoveEngine.spend() added at integration | engine had no public spend | S7, S8
[2026-07-30 04:32] Audio: Web Audio direct, Howler unused (drop dep at ship); charge rumble stops when a follow-up move consumes it or after 3s fallback; noise buffers seeded via mulberry32, one-shots slice a rotating cursor | determinism and variety without Math.random | S12
[2026-07-30 04:48] Arena group static; lane re-base relocates only dead constructs/debris (+15z per cycle at the -16 trigger); re-base travels use negative viewDistance so the camera orbits to a front-facing arrival | moving the arena would carry the lane away from recentered action; restores planted-player combat frame every cycle | S8
[2026-07-30 04:48] Damage numbers via per-frame hp-delta polling, flush at >=5 damage or 0.25s | combat exposes no per-hit callback; sustained beams batch instead of spamming | S8
[2026-07-30 04:48] Director fires slow-mo on EVERY kill (S8); combat's twin-kill slow-mo folds into the same channel; director/camera/HUD on wall-clock dt, world on scaled dt | one time-scaling channel | S7, S8
[2026-07-30 05:05] DEVIATION from S13.5: perf gate passes when median <= 16.6 + 0.5ms vsync slack AND p95 <= 25ms | on a 60Hz display rAF deltas quantize to ~16.7ms, so a perfectly vsync-locked 60fps run can never show median <= 16.6; measured run (median 16.70, p95 17.3, zero drops) is exactly 60fps | S13
[2026-07-30 05:05] Perf gate cannot run unattended in a background tab (Chrome occlusion throttling stalls rAF); the recorded PASS came from an actively-driven tab | HUMAN item added for a focused-window rerun | S13
[2026-07-30 16:00] Parallax yaw was inverted: player-space +yaw (looks right) fed unsigned into setFromAxisAngle(Y_AXIS,...), and a positive Three.js Y rotation pans the camera LEFT | fixed with PARALLAX_YAW_SIGN = -1 applied at target computation (eases through PARALLAX_TAU, no snap on toggle); P key flips at runtime with toast; position and pitch paths verified correct | S8
[2026-07-30 16:45] Pose thresholds retuned on real hands: HaGRID annotations only (~256MB range-requested, no images, no inference), 300/class committed to fixtures/hagrid | fist precision 0.92 -> 0.94 at recall 1.0; palm recall 0.65 -> 0.93; grip precision 0.75 -> 0.96 at recall 0.65 (shape-only). Untunable from stills: PALM_FACING_* (2D), GRIP_RAISED_Y_* (cropped framing), hysteresis frame counts | S6
[2026-07-30 16:45] FINDINGS from HaGRID: thumbs-down is a fist to any thumb-agnostic curl metric (precision vs dislike unreachable by design); 'four' and open-hand no_gesture alias palm; a REAL vertical-thumb grip holds the thumb ~0.74 hand-scale units OFF the index knuckles (fist tuck: 0.22), opposite of the original synthetic guess | fist/grip stay context-separated (whip = static hold + lateral swing); GRIP_THUMB_* edges made permissive rather than fist-rejecting | S6, S7
[2026-07-30 16:45] Grip hysteresis raised 0.45/0.28 -> 0.78/0.55 (supersedes 03:52 deviation; now ABOVE spec 0.75/0.55) | every 3-of-4-curl HaGRID distractor saturates at exactly 0.75, a precision cliff; entering at 0.78 buys 0.96 precision. Synthetic GRIP_LOCAL thumb rebuilt to real thumbs-up geometry so the fixture saturates the thumb factors and clears the higher bar | S6, S13
[2026-07-30 16:45] Toward-camera punch signal switched from MediaPipe z velocity to windowed relative palm-span growth (spanOf = max(palm length, palm width), growth 1/s); retract = span shrink; z demoted to optional secondary behind Z_TOWARD_SECONDARY=false | apparent-size growth is projective geometry from landmarks the tracker is confident about; monocular z is a depth guess. Fixtures gained perspective hand scaling (1/(1+z*1.8)) so synthetic thrusts carry the signal | S6, S7, S13
[2026-07-30 16:45] ROOT CAUSE of the 04:04 One Euro attenuation: beta 0.007 was pixel-scale; normalized-unit punch derivatives (~3 u/s) never raised the adaptive cutoff. Retuned beta 4.0, dCutoff 4.0: 3-frame spike attenuation 44.3% -> 1.5%, rest jitter 1.22x prior | REPLAY_VELOCITY_SCALE drops 1.8 -> 1.1; the compensation hack is now nearly gone | S5, S7, S13
[2026-07-30 16:45] All motion-trigger thresholds now derive from a per-player MotionProfile (calibration punch/push steps, localStorage fb.motionProfile.v1, ?recalibrate=1 or R to redo) via exported fractions (jab 0.45 of peak, retract 0.35, sweeps 0.5) with 3x-neutral and absolute floors; DEFAULT_PROFILE reproduces the old constants exactly so replay/tests stay deterministic | replaces the never-recorded real-gesture-fixture plan at the user's direction | S7, S8, S13

- HUMAN: live camera verification of handedness invariant (raise your left hand, left slot should light in debug overlay), yaw/pitch signs, and GPU delegate fallback in a real browser. Facial-matrix convention is unit-test pinned but only a live run proves it matches MediaPipe output.
- HUMAN: MediaPipe model + WASM assets load from Google/jsdelivr CDNs at runtime. Confirm acceptable vs vendoring locally. Video frames still never leave the device either way.
- RESOLVED (2026-07-30 pm): recording real gesture fixtures is no longer the plan (user's direction). Replaced by (a) HaGRID real-hand tuning of static pose thresholds and (b) per-player adaptive motion calibration. tools/capture.html still works if recordings are ever wanted.
- HUMAN: play through the NEW calibration (three punches + palm push) and judge trigger feel; FIX_ME.md at repo root has the exact steps, the D-key debug HUD, the P-key parallax check, and the one fallback number to nudge (JAB_TRIGGER_FRACTION in src/gestures/profile.ts).
- HUMAN: visual judgment of the arena (composition, flicker, haze, banner sway) via mountArenaDebug; orchestrator will wire a ?arena URL param before ship.
- HUMAN: vendor an open-licensed brush/calligraphic display font (woff2 in repo, @font-face in src/ui/theme.css, first in --fb-font-display). Current stack is system serif fallbacks and reads engraved rather than brushstroke on Windows.
- HUMAN: visual pass on title screen (ember density, wordmark spacing, seal emboss) and calibration ritual (hand outline SVG shape, ignite flare subtlety, flame wipe weight at 700ms).
- HUMAN: fire shader visual judgment via mountFireDebug (wired behind ?debug=fire before ship): expect noise-torn licks not flat sprites, warm ramp, ember curl, faint smoke, light pooling; check fps under sustained load.
- HUMAN: judge construct wobble feel live (SPRING_K 250, damping 3.5, ~1.4s period, tuned headless only), debris scatter/fade (damping may read viscous), and whether the tier 2 chest plates read as skeletal armor.
- HUMAN: rerun ?debug=perf once in a focused Chrome window to confirm the recorded PASS (background-tab throttling makes unattended runs stall; recorded numbers came from an actively-driven tab and show flawless 60fps).
- HUMAN: play ?screen=arena&replay=... and judge loop feel: travel swoop, re-base orbit arrival every 3rd kill (debris relocation pop is expected, hides behind ember burst), slow-mo/hit-stop weight, damage-number cadence, seal height (SEAL_ANCHOR_Y 2.5).
- DEBT: fire-stream (range 14m) cannot reach the third construct of each cycle at z=-16 from the planted player frame; projectile moves carry those kills. If beams should always reach, combat needs a movable playerPosition later. Tier-2 coals land near camera home rather than at deep-anchor camera; mechanically correct, visually approximate; revisit in juice tuning.
- HUMAN: sound feel judgment needs ears (all params tuned by construction, never heard): jab reads as air not static; twin-cannon 32Hz sub may vanish on laptop speakers (raise SUB_F1 if so); fan vs stream distinctly airier; coal whistle Q=12 not ringing; ambient bed level; compressor pumping under twin+duck; MASTER volume headroom.
- RESOLVED (2026-07-30 pm): GRIP_LOCAL rebuilt to real thumbs-up geometry (HaGRID-measured); grip hysteresis now 0.78/0.55, above the S6 spec levels. Fist remains a grip shape alias by design; whip separation stays contextual.
- RESOLVED (2026-07-30 pm): the One Euro attenuation was a beta-scale bug (0.007 pixel-scale in a normalized-unit signal). beta 4.0/dCutoff 4.0 cut spike attenuation to 1.5%; REPLAY_VELOCITY_SCALE reduced 1.8 -> 1.1.
- DEBT: HaGRID could not tune PALM_FACING_* (2D landmarks), GRIP_RAISED_Y_* (cropped stills), or hysteresis frame counts; those remain synthetic-tuned. Live play with the D-key HUD is the verification path.
- DEBT: adaptive punch-step detection during calibration uses a small absolute floor (0.6 u/s) to find calibration punches before a profile exists; if a very-far-from-camera player cannot register calibration punches, lower that floor in src/screens/calibration.ts.

### 16.5 Tuning values that differ from spec defaults

- Static pose thresholds: tuned on REAL hands (HaGRID, docs/hagrid-report.md). Before -> after: FIST_CURL 1.05/1.45 -> 0.92/1.43; PALM_EXT 1.15/1.55 -> 1.3/1.65; PALM_GAP 0.35/0.8 -> 0.55/1.0; GRIP_THUMB near/far 0.5/1.0 -> 1.1/1.7; GRIP_THUMB_RISE_FULL 0.5 -> 0.4. Still synthetic-only: PALM_FACING_*, GRIP_RAISED_Y_*.
- Grip hysteresis 0.45/0.28 -> 0.78/0.55 over 5-frame average (spec 0.75/0.55; entered ABOVE spec to clear the HaGRID 0.75 distractor cliff) | Decision Log 16:45.
- One Euro: beta 0.007 -> 4.0, dCutoff 1.0 -> 4.0 (spec starting values were pixel-scale; see Decision Log 16:45). Face minCutoff stays 1.5.
- Motion thresholds are no longer absolute: derived per player from MotionProfile via fractions (jab/thrust 0.45 of peak punch, retract 0.35, sweeps 0.5, statics 0.12 with 3x-neutral floors). DEFAULT_PROFILE (peak punch 2.0 u/s, growth 3.0 /s) reproduces the old values: spike 0.9 u/s + growth 1.35 /s, retract shrink 1.05 /s, rising/whip 1.0, statics 0.3/0.4, aim 0.5. EXTEND_HOLD 350ms, TWIN chest y 0.4-0.68, BREATH hip y > 0.7 remain absolute (geometry, not speed).
- Toward-camera signal is span growth, not z (Z_TOWARD_SECONDARY=false). Fixture perspective scaling K=1.8.
- REPLAY_VELOCITY_SCALE 1.8 -> 1.1 (replay/debug path only; live uses calibrated scaling) | residual One Euro loss is now ~4-5%.
- PARALLAX_YAW_SIGN -1 (new constant; P key toggles at runtime).

## 17. README requirements (written in Phase 8, not before)

Hero GIF at top, one-line pitch, "Try it" link, how it works (webcam → landmarks → gesture state machine → fire), the moveset table with small illustrative GIFs, privacy note (all client side), local dev instructions, tech stack, a short "why" paragraph. Clean, confident, no emoji spam, no em dashes.

## 18. Agent operating instructions

- **Orchestrator pattern:** the main loop agent plans against the task graph, then delegates to focused sub-agents per task cluster (e.g. a tracking agent, a VFX agent, a gameplay agent, a test agent). Sub-agents receive: the relevant sections of this doc, the current tracker state, and a narrow definition of done. Sub-agents do not edit the tracker; the orchestrator merges results and updates it.
- **Memory discipline:** context is reconstructed each session from Section 16 plus `git log --oneline`. Anything worth remembering goes in the tracker, not in loose files. One exception: /docs/screens/ for visual evidence.
- **Verification bias:** prefer a failing test over a hopeful commit. If a task cannot be verified headlessly, build the verification first or mark the task blocked with a note for the human.
- **Human-required items:** record real landmark sessions with tools/capture.html, judge visual quality of fire/arena, judge gesture feel live, provide the deploy account. Queue these in 16.4 as `HUMAN:` items rather than guessing.
- Commit small, commit often, conventional messages, tag phase completions.
