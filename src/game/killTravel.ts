// Kill-travel anchor sequence (T031): a deterministic march of arena
// positions down the lane for the infinite kill chain. The director asks for
// anchor N, spawns the construct there, and hands the position to
// CameraRig.travelTo on the previous kill.

import * as THREE from 'three';

export interface ArenaAnchor {
  /** Where the construct stands. */
  position: THREE.Vector3;
  /** Unit vector the construct faces (toward the approaching camera). */
  facing: THREE.Vector3;
}

/** First construct waits ~6 m down the lane (matches arena.ts enemyAnchor). */
const FIRST_Z = -6;
/** Each subsequent anchor advances this far down the lane. */
const STEP = 5;
/** Small lateral alternation so the chain weaves between the column rows. */
const LATERAL = 1.2;
/** Construct chest height (matches arena.ts enemyAnchor). */
const ANCHOR_Y = 1.1;

/** Where the player starts; used to derive anchor 0's facing. */
const PLAYER_START = new THREE.Vector3(0, ANCHOR_Y, 0.6);

function anchorPosition(index: number): THREE.Vector3 {
  const x = index === 0 ? 0 : index % 2 === 1 ? LATERAL : -LATERAL;
  return new THREE.Vector3(x, ANCHOR_Y, FIRST_Z - STEP * index);
}

/**
 * Deterministic anchor for kill number `index` (0-based). Enemy 0 stands at
 * (0, 1.1, -6); each next anchor advances 5 m down the lane, alternating
 * +1.2 / -1.2 laterally. Pure function of index: calling twice returns equal
 * values, and z is strictly monotonic toward negative.
 *
 * NOTE FOR THE DIRECTOR AGENT: the built arena is only ~21 m deep. Past
 * z = -18 this sequence keeps advancing anyway; the rig will happily fly
 * there. The director owns the environment illusion for the infinite chain
 * (recycle or re-anchor geometry, slide the coal wall and fog, or quietly
 * recenter the world during the travel's mid-swing when the old lane is
 * off-axis). This module deliberately does not wrap coordinates so combat
 * math and replays stay deterministic.
 */
export function nextArenaAnchor(index: number): ArenaAnchor {
  const i = Math.max(0, Math.floor(index));
  const position = anchorPosition(i);
  const previous = i === 0 ? PLAYER_START : anchorPosition(i - 1);
  const facing = previous.clone().sub(position);
  facing.y = 0;
  if (facing.lengthSq() < 1e-9) {
    facing.set(0, 0, 1);
  } else {
    facing.normalize();
  }
  return { position, facing };
}
