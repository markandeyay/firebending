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
 * The ABOVE_SHOULDER boundary. The shoulder line itself is body y 0 by
 * construction; the boundary sits 0.25 sw ABOVE it (negative y) rather
 * than on it. RETUNED 0 -> -0.25 by the phase-eval pass (tools/
 * phaseEval.ts) against the 2026-07-31 drill: the user's twin-cannon
 * chamber holds the joined wrists ON the shoulder line (measured body y
 * -0.16..+0.35 across chamber samples), so a boundary at 0 flickered the
 * chamber into ABOVE_SHOULDER and broke the CHEST-zone hold; deliberate
 * raises are far clear of the moved boundary (rising-flame sweep tops
 * measure y -0.9..-1.4).
 */
export const SHOULDER_LINE_Y = -0.25;

/**
 * The HIP zone starts at this FRACTION of the way down from the shoulder
 * line to the hip line: points with y > hipY * fraction are in the hip
 * band. RETUNED by the phase-eval pass (tools/phaseEval.ts) against the
 * 2026-07-31 drill, replacing the original absolute margin (hipY - 0.15
 * sw, the legacy BREATH_HIP_MARGIN in body units), for two measured
 * reasons:
 * - The user's real breath-charge chamber holds the fists 0.20..0.31 sw
 *   ABOVE the hip line and the rising-flame start posture rests the
 *   wrists 0.4..0.5 sw above it (both on a ~2.0 sw hip line), so the
 *   0.15 band contained neither and both moves scored zero.
 * - An absolute sw margin does not transfer between body proportions:
 *   0.5 sw is a quarter of the drill body's 2.0 sw torso but nearly half
 *   of a shorter-torsoed body's. A fraction of the torso length scales
 *   with the player.
 * At 0.75 the drill's band starts around y 1.5 (contains the measured
 * chamber at 1.64..1.74 and the rising start at 1.43..1.62) while every
 * recorded thrust-family completion stays clear above it (jab / twin
 * releases measure y 0.6..1.1).
 */
export const HIP_ZONE_TOP_FRACTION = 0.75;

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
 * fires on the inner -> outer crossing. RETUNED 1.30 -> 1.10 by the
 * phase-eval pass (tools/phaseEval.ts) against the 2026-07-31 drill: the
 * user's grip holds park the wrist at outward 0.79..1.00 sw, and the whip
 * swing is a fast down-and-out arc whose apex falls BETWEEN the
 * recording's ~3.8 Hz real pose samples, so the on-sample swing extremes
 * only measure 1.06..1.33 sw; at 1.30 two of five recorded swings never
 * produced an on-sample outer crossing. 1.10 sits a 0.10 sw margin above
 * the loudest recorded hold and below every recorded swing extreme but
 * one.
 */
export const LATERAL_OUTER_MIN = 1.1;

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** Above the shoulder line (screen-up; body y is negative up there). */
export function isAboveShoulder(p: BodyPoint): boolean {
  return p.y < SHOULDER_LINE_Y;
}

/** In the hip band: below HIP_ZONE_TOP_FRACTION of the torso (y grows
 *  down; hipY is the hip line in body units). */
export function isHip(p: BodyPoint, hipY: number): boolean {
  return p.y > hipY * HIP_ZONE_TOP_FRACTION;
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
