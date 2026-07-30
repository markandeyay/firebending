/**
 * Audio wiring (T062): builds the ArenaScreen AudioHooks bridge from one
 * MoveAudio instance plus the small slice of AudioEngine the flow layer
 * touches directly. Pure construction, no Web Audio here, so the whole
 * bridge is testable headless with spy engines.
 *
 * Mapping (spec Section 12):
 *   onMoveEvent  -> MoveAudio.handleEvent (every move sound + sustains)
 *   onKill       -> MoveAudio.onKill (ceremonial taiko hit)
 *   onHitStop    -> MoveAudio.onHitStop (master duck for the freeze)
 *   onSlowMo     -> light master duck so the kill hit stands proud
 *   onPlayerHit  -> light master duck (the coal-landed thud itself arrives
 *                   through onCoalLanded; the engine has no dedicated
 *                   player-hit sound, so we duck lightly instead)
 *   onTravelStart-> the wipe swell doubles as the camera-travel whoosh
 *   onCoal*      -> MoveAudio coal whistle lifecycle
 */

import type { AudioHooks } from '../screens/arena';
import type { MoveAudio } from '../audio/moveAudio';

/** The engine surface the flow wires directly (AudioEngine satisfies it). */
export interface FlowEngineLike {
  duck(amount: number, ms: number): void;
  wipe(): void;
}

/** Light master duck on a coal reaching the player (0..1 of volume, ms). */
export const PLAYER_HIT_DUCK_AMOUNT = 0.35;
export const PLAYER_HIT_DUCK_MS = 140;

/** Very light duck when kill slow-mo begins, under the taiko hit. */
export const SLOWMO_DUCK_AMOUNT = 0.25;
export const SLOWMO_DUCK_MS = 160;

export function buildAudioHooks(
  engine: FlowEngineLike,
  moveAudio: MoveAudio,
): AudioHooks {
  return {
    onMoveEvent: (event) => moveAudio.handleEvent(event),
    onKill: () => moveAudio.onKill(),
    onHitStop: (ms) => moveAudio.onHitStop(ms),
    onSlowMo: () => engine.duck(SLOWMO_DUCK_AMOUNT, SLOWMO_DUCK_MS),
    onPlayerHit: () => engine.duck(PLAYER_HIT_DUCK_AMOUNT, PLAYER_HIT_DUCK_MS),
    onTravelStart: () => engine.wipe(),
    onCoalLob: (flightTimeSec) => moveAudio.onCoalLob(flightTimeSec),
    onCoalBlocked: () => moveAudio.onCoalBlocked(),
    onCoalLanded: () => moveAudio.onCoalLanded(),
  };
}
