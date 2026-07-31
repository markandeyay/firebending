/**
 * captureTs threading (quality round Phase 1): the optional performance.now
 * capture timestamp of the source video frame rides LandmarkFrame from the
 * live source through FilteredSource onto MoveEvents, and its ABSENCE
 * (every fixture and recording) is fully supported end to end.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { FilteredSource } from '../src/tracking/filters';
import { MoveEngine } from '../src/gestures/moves';
import type { MoveEvent } from '../src/gestures/moves';
import type {
  FrameListener,
  LandmarkFrame,
  LandmarkRecording,
  LandmarkSource,
} from '../src/tracking/types';
import { ReplaySource } from '../src/tracking/replaySource';
import { generateRecording } from '../fixtures/lib';
import { FIXTURE_SPECS } from '../fixtures/specs';

const SYNTHETIC_DIR = new URL('../fixtures/synthetic/', import.meta.url);

function loadFixture(label: string): LandmarkRecording {
  const url = new URL(`${label}.json`, SYNTHETIC_DIR);
  if (!existsSync(url)) {
    const spec = FIXTURE_SPECS.find((s) => s.label === label);
    if (!spec) throw new Error(`no spec for fixture ${label}`);
    mkdirSync(SYNTHETIC_DIR, { recursive: true });
    writeFileSync(url, JSON.stringify(generateRecording(spec)));
  }
  return JSON.parse(readFileSync(url, 'utf8')) as LandmarkRecording;
}

/** Minimal manual source: push frames by hand. */
class StubSource implements LandmarkSource {
  private readonly listeners = new Set<FrameListener>();
  async start(): Promise<void> {}
  stop(): void {}
  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  push(frame: LandmarkFrame): void {
    for (const l of this.listeners) l(frame);
  }
}

describe('captureTs threading', () => {
  it('FilteredSource passes captureTs through untouched', () => {
    const inner = new StubSource();
    const filtered = new FilteredSource(inner);
    const seen: LandmarkFrame[] = [];
    filtered.onFrame((f) => seen.push(f));
    inner.push({ t: 0, left: null, right: null, face: null, captureTs: 123456.5 });
    inner.push({ t: 33, left: null, right: null, face: null });
    expect(seen[0]!.captureTs).toBe(123456.5);
    expect('captureTs' in seen[1]!).toBe(false);
  });

  it('MoveEngine stamps events with the triggering frame captureTs', () => {
    const rec = loadFixture('jab-right');
    const engine = new MoveEngine();
    const events: MoveEvent[] = [];
    const src = new ReplaySource(rec);
    const base = 5000;
    src.onFrame((f) => {
      // Simulate the live path: every frame carries a capture timestamp.
      events.push(...engine.update({ ...f, captureTs: base + f.t }));
    });
    src.drain();
    const trigger = events.find((e) => e.kind === 'trigger');
    expect(trigger).toBeDefined();
    expect(trigger!.captureTs).toBe(base + trigger!.t);
    for (const e of events) expect(e.captureTs).toBe(base + e.t);
  });

  it('fixture frames without captureTs yield events without captureTs', () => {
    const rec = loadFixture('jab-right');
    const engine = new MoveEngine();
    const events: MoveEvent[] = [];
    const src = new ReplaySource(rec);
    src.onFrame((f) => {
      events.push(...engine.update(f));
    });
    src.drain();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.captureTs).toBeUndefined();
  });
});
