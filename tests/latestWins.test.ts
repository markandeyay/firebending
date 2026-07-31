/**
 * LATEST-FRAME-WINS backpressure (src/tracking/latestWins.ts), exercised
 * with a scripted fake worker: at most one item in flight, a newer offer
 * REPLACES the parked pending item (stale one dropped via onDrop), settle
 * sends the newest pending immediately, reset drops cleanly.
 */

import { describe, expect, it } from 'vitest';
import { LatestWinsChannel } from '../src/tracking/latestWins';

interface Frame {
  id: number;
  closed: boolean;
}

function makeFrame(id: number): Frame {
  return { id, closed: false };
}

/** A scripted fake worker: records everything sent; the test decides when
 * each "detection" finishes by calling channel.settle(). */
function makeChannel(): {
  channel: LatestWinsChannel<Frame>;
  sent: Frame[];
  dropped: Frame[];
} {
  const sent: Frame[] = [];
  const dropped: Frame[] = [];
  const channel = new LatestWinsChannel<Frame>(
    (f) => sent.push(f),
    (f) => {
      f.closed = true;
      dropped.push(f);
    },
  );
  return { channel, sent, dropped };
}

describe('LatestWinsChannel', () => {
  it('sends immediately when idle', () => {
    const { channel, sent } = makeChannel();
    channel.offer(makeFrame(1));
    expect(sent.map((f) => f.id)).toEqual([1]);
    expect(channel.busy).toBe(true);
    expect(channel.hasPending).toBe(false);
  });

  it('parks one pending item while busy and REPLACES it on a newer offer', () => {
    const { channel, sent, dropped } = makeChannel();
    channel.offer(makeFrame(1)); // in flight
    channel.offer(makeFrame(2)); // parked
    channel.offer(makeFrame(3)); // replaces 2
    expect(sent.map((f) => f.id)).toEqual([1]);
    expect(dropped.map((f) => f.id)).toEqual([2]);
    expect(dropped[0]!.closed).toBe(true); // resource released (bitmap.close)
    expect(channel.hasPending).toBe(true);
  });

  it('settle sends the NEWEST pending and stays busy until drained', () => {
    const { channel, sent } = makeChannel();
    channel.offer(makeFrame(1));
    channel.offer(makeFrame(2));
    channel.offer(makeFrame(3));
    channel.settle(); // frame 1 answered -> 3 (newest) goes out, 2 was dropped
    expect(sent.map((f) => f.id)).toEqual([1, 3]);
    expect(channel.busy).toBe(true);
    channel.settle(); // frame 3 answered, nothing pending
    expect(channel.busy).toBe(false);
  });

  it('scripted camera-vs-slow-worker run: latency stays bounded, stale frames drop', () => {
    const { channel, sent, dropped } = makeChannel();
    // Camera delivers frames 1..9; the worker answers after every 3rd offer.
    for (let id = 1; id <= 9; id++) {
      channel.offer(makeFrame(id));
      if (id % 3 === 0) channel.settle();
    }
    channel.settle();
    channel.settle();
    // In flight: 1. While busy 2 dropped for 3; settle sends 3. Then 4
    // dropped for 5... each settle always sends the NEWEST capture: the
    // channel never develops a queue, only ever skips stale frames.
    expect(sent.map((f) => f.id)).toEqual([1, 3, 6, 9]);
    expect(dropped.map((f) => f.id)).toEqual([2, 4, 5, 7, 8]);
    expect(channel.busy).toBe(false);
    // Every dropped frame had its resource released.
    for (const f of dropped) expect(f.closed).toBe(true);
  });

  it('settle on an idle channel is a no-op', () => {
    const { channel, sent } = makeChannel();
    channel.settle();
    expect(sent).toEqual([]);
    expect(channel.busy).toBe(false);
  });

  it('reset drops the pending item and clears the in-flight slot', () => {
    const { channel, sent, dropped } = makeChannel();
    channel.offer(makeFrame(1));
    channel.offer(makeFrame(2));
    channel.reset();
    expect(dropped.map((f) => f.id)).toEqual([2]);
    expect(channel.busy).toBe(false);
    expect(channel.hasPending).toBe(false);
    // A fresh offer after reset flows normally.
    channel.offer(makeFrame(3));
    expect(sent.map((f) => f.id)).toEqual([1, 3]);
  });
});
