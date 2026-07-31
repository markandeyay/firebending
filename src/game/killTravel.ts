// Courtyard stations and authored camera-travel recipes (Phase 5).
//
// The straight-lane infinite chain is gone. The arena is now a finite
// courtyard with six authored combat STATIONS arranged radially around the
// open center at varied distance, elevation and angle. The director cycles
// them in a fixed order (killIndex % STATION_COUNT) forever; the difficulty
// ramp keeps climbing by kill index.
//
// Each station carries:
//   - anchor: where the construct stands (chest height = floorY + 1.1)
//   - floorY: local ground height (bridge deck sits at +0.5)
//   - cameraPos: the authored camera base pose while fighting there
//   - facing: unit horizontal vector from the anchor toward the camera
//
// Each TRANSITION (arrival at station j) has an authored spline recipe: a
// path STYLE that shows off one environment feature, interior control points
// (world space; the rig prepends its live position as the spline start), a
// duration in [2, 4] s and an easing curve. Six transitions, six distinct
// styles, so the "never the same style twice in a row" rule holds by
// construction; travelRecipeFor still accepts a banned style and substitutes
// a neutral alternate so the director can enforce the rule defensively.
//
// Everything here is pure and deterministic: same inputs, same values.

import * as THREE from 'three';
import type { TravelEasing } from './cameraRig';

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

/** Construct chest height above its local floor. */
const CHEST_ABOVE_FLOOR = 1.1;

export interface Station {
  /** Stable identifier (also used in debug overlays). */
  name: string;
  /** Where the construct stands (world, chest height). */
  anchor: THREE.Vector3;
  /** Local ground height under the construct (0 = courtyard floor). */
  floorY: number;
  /** Authored camera base position while fighting at this station. */
  cameraPos: THREE.Vector3;
  /** Unit horizontal vector from the anchor toward the camera. */
  facing: THREE.Vector3;
}

function station(
  name: string,
  ax: number,
  az: number,
  floorY: number,
  cx: number,
  cy: number,
  cz: number,
): Station {
  const anchor = new THREE.Vector3(ax, floorY + CHEST_ABOVE_FLOOR, az);
  const cameraPos = new THREE.Vector3(cx, cy, cz);
  const facing = new THREE.Vector3(cx - ax, 0, cz - az);
  if (facing.lengthSq() < 1e-9) facing.set(0, 0, 1);
  else facing.normalize();
  return { name, anchor, floorY, cameraPos, facing };
}

/**
 * The authored station cycle. View distances run ~5.4 to ~7.1 m; elevations
 * are courtyard floor, the terrace vantage (camera raised past the broad
 * steps) and the bridge deck (construct raised over the coal channel).
 *
 *   0 entry-hall      construct (0, -6),      camera at the south porch
 *   1 colonnade       construct (-5.6,-10.5), colonnade run behind it
 *   2 terrace-vantage construct (2.2,-12.2),  camera UP on the terrace
 *   3 bridge-deck     construct ON the bridge over the coal channel
 *   4 great-gate      construct framed inside the spirit gate, camera west
 *   5 channel-edge    construct at the channel end under the coal wall
 */
export const STATIONS: readonly Station[] = [
  station('entry-hall', 0, -6, 0, 0, 1.5, 0.6),
  station('colonnade', -5.6, -10.5, 0, -0.6, 1.55, -7.4),
  station('terrace-vantage', 2.2, -12.2, 0, 6.4, 2.55, -17.9),
  station('bridge-deck', -3.5, -15.0, 0.5, -1.9, 1.7, -10.1),
  station('great-gate', 5.7, -6.0, 0, -0.8, 1.5, -5.7),
  station('channel-edge', -6.9, -17.7, 0, -2.6, 1.35, -12.9),
];

export const STATION_COUNT = STATIONS.length;

/** Station index for a kill index: the fixed cycle, looping forever. */
export function stationIndexFor(killIndex: number): number {
  const i = Math.max(0, Math.floor(killIndex));
  return i % STATION_COUNT;
}

/** The station construct `killIndex` spawns at. The returned object is the
 *  shared authored table entry: treat it as read-only. */
export function stationFor(killIndex: number): Station {
  const s = STATIONS[stationIndexFor(killIndex)];
  if (!s) throw new Error('station table is empty');
  return s;
}

// ---------------------------------------------------------------------------
// Travel recipes
// ---------------------------------------------------------------------------

export type PathStyle =
  | 'colonnade-arc'
  | 'gate-pull'
  | 'steps-descent'
  | 'bridge-sweep'
  | 'channel-glide'
  | 'canopy-rise';

interface RecipeSpec {
  style: PathStyle;
  /** Interior spline control points, world space. */
  points: ReadonlyArray<readonly [number, number, number]>;
  durationSec: number;
  easing: TravelEasing;
}

/**
 * One recipe per ARRIVAL station (index matches STATIONS). Each shows off a
 * different feature:
 *   -> 0 gate-pull:      out through the spirit gate, then back to the porch
 *   -> 1 colonnade-arc:  a west arc sweeping along the colonnade columns
 *   -> 2 canopy-rise:    a rising turn under the lantern canopy wires
 *   -> 3 steps-descent:  down the broad terrace steps to the bridge view
 *   -> 4 bridge-sweep:   over the bridge and channel, curling to the gate
 *   -> 5 channel-glide:  a low skim past the coal channel's west mouth
 */
const RECIPES: readonly RecipeSpec[] = [
  {
    style: 'gate-pull',
    points: [
      [3.0, 1.8, -10.4],
      [8.9, 2.0, -6.0],
      [5.0, 1.7, -0.6],
    ],
    durationSec: 3.4,
    easing: 'easeInOutCubic',
  },
  {
    style: 'colonnade-arc',
    points: [
      [-3.6, 2.1, -2.2],
      [-6.0, 1.9, -5.6],
    ],
    durationSec: 2.6,
    easing: 'easeInOutCubic',
  },
  {
    style: 'canopy-rise',
    points: [
      [0.8, 3.6, -10.0],
      [4.2, 3.9, -14.6],
    ],
    durationSec: 3.2,
    easing: 'easeInOutSine',
  },
  {
    style: 'steps-descent',
    points: [
      [6.4, 2.3, -14.9],
      [5.2, 1.35, -12.3],
      [0.6, 1.4, -10.6],
    ],
    durationSec: 3.0,
    easing: 'easeOutQuint',
  },
  {
    style: 'bridge-sweep',
    points: [
      [-3.5, 2.3, -13.8],
      [-1.0, 2.8, -17.0],
      [2.6, 2.2, -11.0],
    ],
    durationSec: 3.6,
    easing: 'easeInOutCubic',
  },
  {
    style: 'channel-glide',
    points: [
      [-5.4, 0.9, -8.8],
      [-7.2, 0.8, -12.4],
    ],
    durationSec: 2.8,
    easing: 'easeInOutSine',
  },
];

/** Defensive substitute when a style would repeat back to back. Every value
 *  differs from its key, so the substitution always breaks the repeat. */
const ALTERNATE_STYLE: Readonly<Record<PathStyle, PathStyle>> = {
  'gate-pull': 'canopy-rise',
  'colonnade-arc': 'channel-glide',
  'canopy-rise': 'colonnade-arc',
  'steps-descent': 'bridge-sweep',
  'bridge-sweep': 'steps-descent',
  'channel-glide': 'gate-pull',
};

export interface TravelRecipe {
  style: PathStyle;
  /** Interior spline control points (cloned). Empty = rig default swing. */
  controlPoints: THREE.Vector3[];
  /** Where the camera settles: the arrival station's authored pose. */
  endPosition: THREE.Vector3;
  /** Travel duration, already inside the rig's [2, 4] clamp. */
  durationSec: number;
  easing: TravelEasing;
}

/**
 * The authored travel recipe for arriving at construct `killIndex`'s station.
 * Deterministic. When `bannedStyle` matches the authored style (which cannot
 * happen in the fixed six-station cycle, but the director enforces the
 * no-repeat rule defensively), a neutral alternate recipe is returned: a
 * different style label with the rig's default swing path.
 */
export function travelRecipeFor(killIndex: number, bannedStyle?: PathStyle): TravelRecipe {
  const arrival = stationIndexFor(killIndex);
  const spec = RECIPES[arrival];
  const st = stationFor(killIndex);
  if (!spec) throw new Error('travel recipe table is incomplete');
  if (bannedStyle !== undefined && spec.style === bannedStyle) {
    return {
      style: ALTERNATE_STYLE[spec.style],
      controlPoints: [],
      endPosition: st.cameraPos.clone(),
      durationSec: 2.5,
      easing: 'easeInOutCubic',
    };
  }
  return {
    style: spec.style,
    controlPoints: spec.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    endPosition: st.cameraPos.clone(),
    durationSec: spec.durationSec,
    easing: spec.easing,
  };
}
