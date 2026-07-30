import { describe, expect, it } from 'vitest';
import { ReplaySource } from '../src/tracking/replaySource';
import type { LandmarkFrame, LandmarkRecording } from '../src/tracking/types';

function makeRecording(n: number): LandmarkRecording {
  const frames: LandmarkFrame[] = [];
  for (let i = 0; i < n; i++) {
    frames.push({ t: i * 33.3, left: null, right: null, face: null });
  }
  return { version: 1, label: 'empty-idle', fps: 30, frames };
}

describe('ReplaySource', () => {
  it('emits every frame in order to listeners via tick()', () => {
    const source = new ReplaySource(makeRecording(5));
    const seen: number[] = [];
    source.onFrame((f) => seen.push(f.t));
    source.drain();
    expect(seen).toHaveLength(5);
    expect(seen[0]).toBe(0);
    expect(seen[4]).toBeCloseTo(4 * 33.3);
    expect(source.done).toBe(true);
  });

  it('returns null after exhaustion and supports reset', () => {
    const source = new ReplaySource(makeRecording(2));
    source.tick();
    source.tick();
    expect(source.tick()).toBeNull();
    source.reset();
    expect(source.tick()?.t).toBe(0);
  });

  it('unsubscribe stops delivery', () => {
    const source = new ReplaySource(makeRecording(3));
    let count = 0;
    const off = source.onFrame(() => count++);
    source.tick();
    off();
    source.drain();
    expect(count).toBe(1);
  });
});
