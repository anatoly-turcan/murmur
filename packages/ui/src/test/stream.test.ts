import type { Frame } from '@murmur/dev-protocol';
import { describe, expect, test } from 'vitest';

import type { ConnectionStatus } from '../store/state.ts';
import {
  connectStream,
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  nextBackoff,
  type EventSourceLike,
} from '../store/stream.ts';
import { present } from './fixtures.ts';

class FakeSource implements EventSourceLike {
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: string): void {
    for (const l of this.listeners.get(type) ?? []) {
      l({ data } as MessageEvent<string>);
    }
  }
}

describe('stream', () => {
  test('backoff doubles from 250 ms and caps at 5 s', () => {
    const steps = [MIN_BACKOFF_MS];
    while (steps.length < 7) {
      steps.push(nextBackoff(present(steps.at(-1))));
    }

    expect(steps).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
    expect(MAX_BACKOFF_MS).toBe(5000);
  });

  test('dispatches frames, reconnects with since=lastSeq and resets backoff on hello', () => {
    const sources: FakeSource[] = [];
    const frames: Frame[] = [];
    const statuses: ConnectionStatus[] = [];
    const delays: number[] = [];
    const timers: (() => void)[] = [];
    let lastSeq: number | null = null;
    const stream = connectStream({
      url: (since) => `/api/events${since === null ? '' : `?since=${since}`}`,
      since: () => lastSeq,
      onFrame: (f) => {
        frames.push(f);

        if (f.frame !== 'hello') {
          lastSeq = f.seq;
        }
      },
      onStatus: (s) => statuses.push(s),
      create: (url) => {
        const s = new FakeSource(url);
        sources.push(s);

        return s;
      },
      schedule: (fn, ms) => {
        delays.push(ms);
        timers.push(fn);
      },
    });
    present(sources[0]).emit('ping', JSON.stringify({ frame: 'ping', seq: 7, ts: 'x' }));
    present(sources[0]).emit('env', 'not json');
    present(sources[0]).emit('error', '');
    expect(present(sources[0]).closed).toBe(true);
    expect(statuses).toEqual(['reconnecting']);
    present(timers.shift())();
    expect(present(sources[1]).url).toBe('/api/events?since=7');
    present(sources[1]).emit('error', '');
    present(timers.shift())();
    present(sources[2]).emit(
      'hello',
      JSON.stringify({ frame: 'hello', seq: 7, ts: 'x', protocol: 1, snapshot: {}, replayFrom: null }),
    );
    present(sources[2]).emit('error', '');
    expect(delays).toEqual([250, 500, 250]);
    expect(frames.map((f) => f.frame)).toEqual(['ping', 'hello']);
    stream.close();
    expect(present(sources[2]).closed).toBe(true);
  });
});
