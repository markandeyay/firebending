/**
 * Ink hand outlines (T070): the brush-outline open hand used by the
 * calibration ritual, extracted so the tracking-loss overlay can reuse the
 * same asset style. Pure DOM construction, no listeners.
 */

/**
 * Simple brush-outline open hand, thumb toward the outside. Drawn for the
 * right hand; the left is mirrored in CSS (.fb-hand--left).
 */
export const HAND_PATH =
  'M28 116 C26 102 24 94 23 82 L14 60 C12 54 17 50 21 54 L30 70 L30 34 ' +
  'C30 28 38 28 38 34 L38 64 L40 22 C40 16 48 16 48 22 L48 62 L52 28 ' +
  'C53 22 60 23 60 29 L57 64 L64 42 C66 36 73 39 71 45 L62 78 ' +
  'C60 92 58 104 56 116';

/** One ink-outline hand element (class fb-hand fb-hand--left|right). */
export function handOutline(side: 'left' | 'right'): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `fb-hand fb-hand--${side}`;
  el.innerHTML =
    `<svg viewBox="0 0 90 120" aria-hidden="true">` +
    `<path d="${HAND_PATH}"></path>` +
    `</svg>`;
  return el;
}
