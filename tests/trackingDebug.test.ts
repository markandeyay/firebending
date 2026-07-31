import { describe, expect, it } from 'vitest';
import {
  boneList,
  formatHud,
  projectToCanvas,
  type HudState,
} from '../src/screens/trackingDebug';
import { HAND_LANDMARK_COUNT } from '../src/tracking/types';

describe('boneList', () => {
  it('has the expected bone count: 5 wrist spokes + 5 finger chains + palm arc', () => {
    // 5 wrist spokes, thumb/index/middle/ring/pinky chains of 3 each,
    // 3 palm-arc segments across the MCPs.
    expect(boneList()).toHaveLength(5 + 5 * 3 + 3);
  });

  it('only references valid landmark indices', () => {
    for (const [a, b] of boneList()) {
      expect(Number.isInteger(a)).toBe(true);
      expect(Number.isInteger(b)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(HAND_LANDMARK_COUNT);
      expect(b).toBeLessThan(HAND_LANDMARK_COUNT);
      expect(a).not.toBe(b);
    }
  });

  it('has no duplicate bones', () => {
    const keys = boneList().map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('projectToCanvas', () => {
  const w = 800;
  const h = 600;

  it('maps the corners of normalized space to canvas corners', () => {
    expect(projectToCanvas({ x: 0, y: 0, z: 0 }, w, h)).toEqual({ x: 0, y: 0 });
    expect(projectToCanvas({ x: 1, y: 1, z: 0 }, w, h)).toEqual({ x: w, y: h });
    expect(projectToCanvas({ x: 1, y: 0, z: -0.5 }, w, h)).toEqual({ x: w, y: 0 });
    expect(projectToCanvas({ x: 0, y: 1, z: 0.5 }, w, h)).toEqual({ x: 0, y: h });
  });

  it('maps the center of normalized space to the canvas center', () => {
    expect(projectToCanvas({ x: 0.5, y: 0.5, z: 0 }, w, h)).toEqual({
      x: w / 2,
      y: h / 2,
    });
  });
});

describe('formatHud', () => {
  const base: HudState = {
    source: 'replay jab-right',
    t: 1234,
    fps: 29.7,
    left: { confidence: 0.91, tracked: true },
    right: { confidence: null, tracked: false },
  };

  it('contains source, time, fps, and per-hand confidence with gated state', () => {
    const hud = formatHud(base);
    expect(hud).toContain('replay jab-right');
    expect(hud).toContain('1.23s');
    expect(hud).toContain('fps: 29.7');
    expect(hud).toContain('L conf 0.91');
    expect(hud).toContain('TRACKED');
    expect(hud).toContain('untracked');
  });

  it('includes live stats only when the live block is present', () => {
    expect(formatHud(base)).not.toContain('poseDegraded');
    const hud = formatHud({
      ...base,
      source: 'live camera',
      live: {
        handMs: 4.2,
        poseMs: 2.1,
        poseHz: 24.6,
        poseWorker: true,
        poseDegraded: true,
      },
    });
    expect(hud).toContain('hand 4.2ms');
    expect(hud).toContain('pose 2.1ms');
    expect(hud).toContain('@ 24.6Hz');
    expect(hud).toContain('(worker)');
    expect(hud).toContain('poseDegraded: yes');
  });

  it('labels the main-thread pose fallback', () => {
    const hud = formatHud({
      ...base,
      source: 'live camera',
      live: {
        handMs: 4.2,
        poseMs: 3.0,
        poseHz: 0,
        poseWorker: false,
        poseDegraded: false,
      },
    });
    expect(hud).toContain('(main)');
    expect(hud).toContain('poseDegraded: no');
  });

  it('never contains em dashes', () => {
    const variants = [
      formatHud(base),
      formatHud({
        ...base,
        left: { confidence: null, tracked: false },
        right: { confidence: 0.5, tracked: false },
        live: {
          handMs: 0,
          poseMs: 0,
          poseHz: 0,
          poseWorker: false,
          poseDegraded: false,
        },
      }),
    ];
    for (const hud of variants) {
      expect(hud).not.toContain('—');
    }
  });

  it('is importable in node without touching the DOM', () => {
    // If module evaluation had touched document/window, the imports at the
    // top of this file would already have thrown in the node environment.
    expect(typeof document).toBe('undefined');
  });
});
