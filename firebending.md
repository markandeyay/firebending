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
T000 | P0 | repo scaffold            | -          | todo |  |
T001 | P0 | LandmarkSource iface     | T000       | todo |  |
T002 | P0 | synthetic fixture gen    | T001       | todo |  |
T003 | P0 | capture tool             | T001       | todo |  |
T004 | P0 | test harness boots       | T002       | todo |  |
T010 | P1 | live hand source         | T001       | todo |  |
T011 | P1 | face source              | T001       | todo |  |
T012 | P1 | filters + gating         | T002       | todo |  |
T020 | P2 | pose functions           | T012       | todo |  |
T021 | P2 | move state machine       | T020       | todo |  |
T022 | P2 | false-positive suite     | T021       | todo |  |
T030 | P3 | arena environment        | T000       | todo |  |
T031 | P3 | camera rig + parallax    | T011,T030  | todo |  |
T040 | P4 | fire particle core       | T030       | todo |  |
T041 | P4 | per-move VFX             | T021,T040  | todo |  |
T050 | P5 | constructs + physics     | T030       | todo |  |
T051 | P5 | combat + HUD             | T021,T050  | todo |  |
T052 | P5 | director chain           | T051       | todo |  |
T060 | P6 | title + calibration      | T010       | todo |  |
T061 | P6 | audio pass               | T041       | todo |  |
T062 | P6 | juice tuning             | T052       | todo |  |
T070 | P7 | hardening ladder         | T062       | todo |  |
T080 | P8 | README + deploy + GIFs   | T070       | todo |  |
```

### 16.2 Session log
Format: `[timestamp] agent | tasks touched | result | next`

(empty)

### 16.3 Decision log
Format: `[timestamp] decision | reason | affected sections`

(empty)

### 16.4 Known issues / debt

(empty)

### 16.5 Tuning values that differ from spec defaults

(empty)

## 17. README requirements (written in Phase 8, not before)

Hero GIF at top, one-line pitch, "Try it" link, how it works (webcam → landmarks → gesture state machine → fire), the moveset table with small illustrative GIFs, privacy note (all client side), local dev instructions, tech stack, a short "why" paragraph. Clean, confident, no emoji spam, no em dashes.

## 18. Agent operating instructions

- **Orchestrator pattern:** the main loop agent plans against the task graph, then delegates to focused sub-agents per task cluster (e.g. a tracking agent, a VFX agent, a gameplay agent, a test agent). Sub-agents receive: the relevant sections of this doc, the current tracker state, and a narrow definition of done. Sub-agents do not edit the tracker; the orchestrator merges results and updates it.
- **Memory discipline:** context is reconstructed each session from Section 16 plus `git log --oneline`. Anything worth remembering goes in the tracker, not in loose files. One exception: /docs/screens/ for visual evidence.
- **Verification bias:** prefer a failing test over a hopeful commit. If a task cannot be verified headlessly, build the verification first or mark the task blocked with a note for the human.
- **Human-required items:** record real landmark sessions with tools/capture.html, judge visual quality of fire/arena, judge gesture feel live, provide the deploy account. Queue these in 16.4 as `HUMAN:` items rather than guessing.
- Commit small, commit often, conventional messages, tag phase completions.
