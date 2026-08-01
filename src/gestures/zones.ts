/**
 * Spatial zones in body-local coordinates (position-state-machine rebuild,
 * 2026-07-31). Zones replace the legacy absolute y bands and hip-relative
 * margins: every boundary is expressed in SHOULDER-WIDTH units inside the
 * slowly-drifting body frame (bodyFrame.ts), so a player of any size at any
 * distance gets the same zone geometry, and a dropped frame cannot move a
 * boundary.
 *
 * Body coordinates (bodyFrame.ts): x grows to the player's right, y grows
 * DOWN (screen convention kept on purpose), unit = one shoulder width,
 * origin = shoulder midpoint. The hip line sits near body y +1.15.
 *
 * ZONES ARE EDGE-TRIGGERED CONSUMERS' DATA: the engine reacts to zone
 * ENTER/EXIT transitions (and dwell timers started/stopped by those edges),
 * never to per-frame level effects, per the rep-counter transition-rule
 * discipline. This module only classifies; the edges live in the engine.
 *
 * zoneOf returns ONE label per point with a documented priority
 * (ABOVE_SHOULDER, then HIP, then the lateral bands, then CHEST): the HUD
 * and dwell logic want a single name. The whip's swing however happens with
 * the arm RAISED, where the wrist can sit above the shoulder line while
 * still being laterally inner or outer, so the lateral crossing logic reads
 * lateralBandOf (pure |x|) instead of the exclusive classifier.
 */

import type { BodyPoint } from './bodyFrame';

export type ZoneName =
  | 'HIP'
  | 'CHEST'
  | 'ABOVE_SHOULDER'
  | 'LATERAL_INNER'
  | 'LATERAL_OUTER';

/** Side-relative lateral band (see lateralBandOf). */
export type LateralBand = 'center' | 'inner' | 'outer';

// ---------------------------------------------------------------------------
// Boundary constants (shoulder-width units), exported for the HUD and tests
// ---------------------------------------------------------------------------

/**
 * The shoulder line: body y 0 by construction. Points with y below this
 * (numerically negative; screen-up) are ABOVE_SHOULDER.
 */
export const SHOULDER_LINE_Y = 0;

/**
 * The HIP zone starts this far ABOVE the hip line (hipY - margin): wrists
 * chambered slightly above the actual hips still count as at the hips.
 * 0.15 sw reproduces the legacy BREATH_HIP_MARGIN (0.05 screen units at the
 * ~0.32 reference shoulder width) in body units.
 */
export const HIP_ZONE_MARGIN = 0.15;

/**
 * Central band half-width for CHEST: |x| within this is central. 0.75 sw
 * comfortably covers both wrists brought together at the sternum while
 * excluding an arm swung clearly off to one side.
 */
export const CHEST_HALF_WIDTH = 0.75;

/**
 * Inner lateral band starts where the central band ends. Named separately
 * from CHEST_HALF_WIDTH so the whip tuning can move it without touching
 * chest classification.
 */
export const LATERAL_INNER_MIN = 0.75;

/**
 * Outer lateral band: |x| beyond this is a full sideways arm. The whip
 * fires on the inner -> outer crossing. A straight lateral arm reaches
 * roughly wrist |x| ~2 sw (hanging-arm drill reach 1.6..2.2 measured from
 * the shoulder, plus the half-shoulder offset of the shoulder itself), so
 * 1.30 demands a real swing while staying well inside the reachable range.
 */
export const LATERAL_OUTER_MIN = 1.3;

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** Above the shoulder line (screen-up; body y is negative up there). */
export function isAboveShoulder(p: BodyPoint): boolean {
  return p.y < SHOULDER_LINE_Y;
}

/** In the hip band: at or below hipY - HIP_ZONE_MARGIN (y grows down). */
export function isHip(p: BodyPoint, hipY: number): boolean {
  return p.y > hipY - HIP_ZONE_MARGIN;
}

/** Central band between the shoulder line and the hip band. */
export function isChest(p: BodyPoint, hipY: number): boolean {
  return (
    !isAboveShoulder(p) && !isHip(p, hipY) && Math.abs(p.x) <= CHEST_HALF_WIDTH
  );
}

/**
 * Side-relative lateral band from |x| alone, independent of height: the
 * whip's crossing detector. `side` orients the band outward: a right-arm
 * swing grows +x, a left-arm swing grows -x, and the "outward" coordinate
 * is positive for both.
 */
export function lateralBandOf(p: BodyPoint, side: 'left' | 'right'): LateralBand {
  const outward = side === 'right' ? p.x : -p.x;
  if (outward > LATERAL_OUTER_MIN) return 'outer';
  if (outward > LATERAL_INNER_MIN) return 'inner';
  return 'center';
}

/**
 * Exclusive zone classifier, priority documented in the module header:
 * height wins first (ABOVE_SHOULDER, then HIP: those bands gate rising and
 * breath-charge and must never be shadowed by a lateral label), then the
 * lateral bands by |x|, then CHEST as the central remainder.
 */
export function zoneOf(p: BodyPoint, hipY: number): ZoneName {
  if (isAboveShoulder(p)) return 'ABOVE_SHOULDER';
  if (isHip(p, hipY)) return 'HIP';
  const ax = Math.abs(p.x);
  if (ax > LATERAL_OUTER_MIN) return 'LATERAL_OUTER';
  if (ax > LATERAL_INNER_MIN) return 'LATERAL_INNER';
  return 'CHEST';
}
