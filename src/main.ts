/**
 * Boot and screen state machine (T062, Phase 6 integration).
 *
 * Entry points (see src/boot/route.ts for the pure routing decision):
 *   (none)            full game: title -> calibration -> arena, live camera
 *   ?replay=NAME      the SAME full flow driven by a looping synthetic
 *                     fixture (bare names resolve to fixtures/synthetic/)
 *   ?screen=arena     dev shortcut straight into the arena on replay input
 *   ?debug=tracking   filtered-skeleton overlay (&fixture=name, &live)
 *   ?debug=moves      move-event debug scene (&fixture=name, &live)
 *   ?debug=arena      arena environment visual harness
 *   ?debug=fire       fire system visual harness
 *   ?debug=perf       Phase 3 perf gate: scripted stress scene + verdict
 *
 * Audio (Section 12): one AudioEngine + one MoveAudio for the whole flow.
 * unlock() and sealPress() fire inside the Play click (user gesture),
 * ignite() on the calibration ignition, wipe() with every flame wipe,
 * ambientStart() when the arena settles, and every move/kill/coal sound
 * routes through the AudioHooks bridge (src/boot/audioWiring.ts).
 */

import { mountTrackingDebug } from './screens/trackingDebug';
import { mountMovesDebug, REPLAY_VELOCITY_SCALE } from './screens/movesDebug';
import { mountArenaDebug } from './game/arenaDebug';
import { mountFireDebug } from './vfx/fireDebug';
import { mountPerfGate } from './screens/perfGate';
import {
  ArenaScreen,
  LoopingReplaySource,
  type ArenaContext,
} from './screens/arena';
import { ScreenManager, flameWipe } from './screens/screenManager';
import { TitleScreen } from './screens/title';
import {
  CalibrationScreen,
  type CalibrationContext,
} from './screens/calibration';
import { AudioEngine } from './audio/engine';
import { MoveAudio } from './audio/moveAudio';
import { buildAudioHooks } from './boot/audioWiring';
import { faultKindFor, isMobileLike, replayFixtureUrl, routeFor } from './boot/route';
import {
  DEFAULT_CALIBRATION,
  type CalibrationStats,
} from './gestures/calibrationStats';
import { ReplaySource } from './tracking/replaySource';
import type { LandmarkSource } from './tracking/types';
import './ui/theme.css';

export type ScreenName = 'title' | 'calibration' | 'arena';

const DESKTOP_GATE_BODY =
  'Firebending needs a desktop or laptop with a webcam. ' +
  'Your hands deserve a bigger stage. Come back on a computer.';

const CAMERA_FAULT_BODY =
  'The fire needs your camera to see your hands. ' +
  'Allow camera access in your browser and reload the page to begin.';

const NETWORK_FAULT_BODY =
  'The spirits are unreachable. Check your connection and reload.';

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app root');

const params = new URLSearchParams(window.location.search);

switch (routeFor(params)) {
  case 'debug-tracking':
    void mountTrackingDebug(app, {
      fixture: params.get('fixture') ?? 'jab-right',
      live: params.has('live'),
    });
    break;
  case 'debug-moves':
    void mountMovesDebug(app, {
      fixture: params.get('fixture') ?? undefined,
      live: params.has('live'),
    });
    break;
  case 'debug-arena':
    mountArenaDebug(app);
    break;
  case 'debug-fire':
    mountFireDebug(app);
    break;
  case 'debug-perf':
    mountPerfGate(app);
    break;
  case 'arena-replay':
    void bootArenaReplay(app, replayFixtureUrl(params.get('replay') ?? 'jab-right'));
    break;
  case 'title-flow-replay':
    void bootGameFlow(app, params.get('replay'));
    break;
  case 'title-flow':
    if (
      isMobileLike({
        hasTouch: 'ontouchstart' in window,
        innerWidth: window.innerWidth,
      })
    ) {
      mountMessageScreen(app, null, DESKTOP_GATE_BODY, { wordmark: true });
    } else {
      void bootGameFlow(app, null);
    }
    break;
}

/**
 * The full game flow (Phase 6 exit): title, calibration ritual, arena chain.
 * `replayFixture` null = live camera; otherwise the whole flow runs on a
 * looping replay of that fixture with DEFAULT_CALIBRATION and the replay
 * velocity compensation (see movesDebug.ts REPLAY_VELOCITY_SCALE).
 */
async function bootGameFlow(
  root: HTMLElement,
  replayFixture: string | null,
): Promise<void> {
  const engine = new AudioEngine();
  const moveAudio = new MoveAudio(engine);
  const audioHooks = buildAudioHooks(engine, moveAudio);

  const manager = new ScreenManager({
    host: root,
    // Flame wipe between every screen pair, with its whoosh.
    transition: (host, swap) => {
      engine.wipe();
      return host ? flameWipe(host, swap) : swap();
    },
  });

  let source: LandmarkSource | null = null;
  let liveStream: MediaStream | null = null;

  const startArena = (stats: CalibrationStats): void => {
    const activeSource = source;
    if (!activeSource) return;
    const ctx: ArenaContext = {
      source: activeSource,
      stats: replayFixture !== null ? DEFAULT_CALIBRATION : stats,
      audio: audioHooks,
      ...(replayFixture !== null
        ? { velocityScale: REPLAY_VELOCITY_SCALE }
        : {}),
    };
    void manager.show('arena', ctx).then(() => {
      // Brazier crackle bed once the hall is on screen.
      engine.ambientStart();
    });
  };

  const startRitual = async (): Promise<void> => {
    try {
      if (replayFixture !== null) {
        const replay = await ReplaySource.load(replayFixtureUrl(replayFixture));
        source = new LoopingReplaySource(replay);
      } else {
        // Live MediaPipe path stays a lazy chunk (Phase 1 decision).
        const { LiveLandmarkSource } = await import('./tracking/liveSource');
        const live = new LiveLandmarkSource();
        await live.start(); // camera permission prompt happens here
        liveStream = live.mediaStream;
        source = live;
      }
    } catch (err) {
      console.error('Firebending: input source failed to start', err);
      // T070: a denied camera and a failed model download read differently.
      if (faultKindFor(err) === 'camera') {
        mountMessageScreen(root, 'NO FLAME WITHOUT SIGHT', CAMERA_FAULT_BODY);
      } else {
        mountMessageScreen(root, 'THE HALL IS SILENT', NETWORK_FAULT_BODY);
      }
      return;
    }
    const calCtx: CalibrationContext = {
      source,
      ...(liveStream ? { stream: liveStream } : {}),
      onIgnite: () => engine.ignite(),
      onComplete: (stats) => startArena(stats),
    };
    await manager.show('calibration', calCtx);
    // Replay input starts once calibration is listening; the live source is
    // already running (frames before the screen mounts are simply dropped).
    if (replayFixture !== null && source) void source.start();
  };

  manager.register(
    'title',
    new TitleScreen({
      onPlay: () => {
        // Inside the click handler: the context must start unsuspended.
        engine.unlock();
        engine.sealPress();
        void startRitual();
      },
    }),
  );
  manager.register('calibration', new CalibrationScreen());
  manager.register('arena', new ArenaScreen());

  await manager.show('title');
}

/**
 * Dev entry (Phase 5 exit): mount the arena screen directly on looping replay
 * input, skipping title/calibration. DEFAULT_CALIBRATION plus the replay-path
 * velocity compensation (REPLAY_VELOCITY_SCALE; see movesDebug.ts).
 */
async function bootArenaReplay(root: HTMLElement, replayUrl: string): Promise<void> {
  const replay = await ReplaySource.load(replayUrl);
  const screen = new ArenaScreen();
  await screen.enter(root, {
    source: new LoopingReplaySource(replay),
    stats: DEFAULT_CALIBRATION,
    velocityScale: REPLAY_VELOCITY_SCALE,
  });
}

/**
 * Parchment message screen (T070): the mobile rejection gate and the flow
 * fault states. Kind, ink on parchment. With `wordmark` the brushstroke
 * FIREBENDING wordmark sits above the panel (the mobile gate should still
 * feel like the game's front door).
 */
function mountMessageScreen(
  root: HTMLElement,
  heading: string | null,
  body: string,
  opts: { wordmark?: boolean } = {},
): void {
  root.replaceChildren();
  const layer = document.createElement('div');
  layer.className = 'fb-screen-layer fb-gate';
  const stack = document.createElement('div');
  stack.className = 'fb-gate-stack';
  if (opts.wordmark) {
    const mark = document.createElement('h1');
    mark.className = 'fb-wordmark fb-gate-wordmark';
    mark.textContent = 'FIREBENDING';
    stack.appendChild(mark);
  }
  const panel = document.createElement('div');
  panel.className = 'fb-panel fb-gate-panel';
  if (heading !== null) {
    const h = document.createElement('h2');
    h.className = 'fb-gate-heading';
    h.textContent = heading;
    panel.appendChild(h);
  }
  const p = document.createElement('p');
  p.className = 'fb-gate-body';
  p.textContent = body;
  panel.appendChild(p);
  stack.appendChild(panel);
  layer.appendChild(stack);
  root.appendChild(layer);
}
