/**
 * Boot routing (T062): the pure decisions main.ts makes at startup, extracted
 * so headless tests can cover every entry point without a DOM. main.ts owns
 * all side effects; this module owns none.
 */

export type RouteName =
  | 'debug-tracking'
  | 'debug-moves'
  | 'debug-arena'
  | 'debug-fire'
  | 'debug-perf'
  | 'arena-replay'
  | 'title-flow-replay'
  | 'title-flow';

/**
 * Map URL params to an entry point. Precedence: debug screens win over
 * everything, the ?screen=arena dev entry wins over a bare ?replay, and a
 * bare ?replay runs the FULL title -> calibration -> arena flow on replay
 * input. No params = the real game.
 */
export function routeFor(params: URLSearchParams): RouteName {
  switch (params.get('debug')) {
    case 'tracking':
      return 'debug-tracking';
    case 'moves':
      return 'debug-moves';
    case 'arena':
      return 'debug-arena';
    case 'fire':
      return 'debug-fire';
    case 'perf':
      return 'debug-perf';
    default:
      break; // unknown or absent debug value falls through to the game routes
  }
  if (params.get('screen') === 'arena') return 'arena-replay';
  if (params.get('replay') !== null) return 'title-flow-replay';
  return 'title-flow';
}

/**
 * Desktop-only gate (placeholder for the full T070 mobile rejection): a
 * touch-primary device narrower than this is treated as mobile-like and gets
 * the kind parchment rejection instead of a camera prompt.
 */
export const MOBILE_MAX_WIDTH_PX = 900;

export interface DeviceProbe {
  /** `'ontouchstart' in window` at boot. */
  hasTouch: boolean;
  /** `window.innerWidth` at boot, CSS pixels. */
  innerWidth: number;
}

export function isMobileLike(device: DeviceProbe): boolean {
  return device.hasTouch && device.innerWidth < MOBILE_MAX_WIDTH_PX;
}

/**
 * Resolve a ?replay= value to a fetchable URL. A bare fixture name maps into
 * fixtures/synthetic/; anything that already looks like a path or a .json
 * file passes through untouched (recorded sessions, absolute paths).
 */
export function replayFixtureUrl(name: string): string {
  if (name.includes('/') || name.endsWith('.json')) return name;
  return `fixtures/synthetic/${name}.json`;
}
