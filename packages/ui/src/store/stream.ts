import type { Frame, FrameName } from '@murmur/dev-protocol';

import type { ConnectionStatus } from './state.ts';

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface StreamOptions {
  url: (since: number | null) => string;
  since: () => number | null;
  onFrame: (frame: Frame) => void;
  onStatus: (status: ConnectionStatus) => void;
  create?: (url: string) => EventSourceLike;
  schedule?: (fn: () => void, ms: number) => unknown;
}

export const FRAME_NAMES: readonly FrameName[] = [
  'hello',
  'env',
  'dev.restart',
  'dev.boot',
  'dev.boot_failed',
  'dev.child_exit',
  'dev.paused',
  'dev.resumed',
  'ping',
];

export const MIN_BACKOFF_MS = 250;
export const MAX_BACKOFF_MS = 5000;

export function nextBackoff(current: number): number {
  return Math.min(MAX_BACKOFF_MS, current * 2);
}

function parseFrame(event: MessageEvent<string>): Frame | null {
  try {
    return JSON.parse(event.data) as Frame;
  } catch {
    return null;
  }
}

export function connectStream(options: StreamOptions): { close: () => void } {
  const create = options.create ?? ((url: string) => new EventSource(url) as EventSourceLike);
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let source: EventSourceLike | null = null;
  let backoff = MIN_BACKOFF_MS;
  let closed = false;

  const open = (): void => {
    if (closed) {
      return;
    }

    source = create(options.url(options.since()));

    for (const name of FRAME_NAMES) {
      source.addEventListener(name, (event) => {
        const frame = parseFrame(event);
        if (!frame) {
          return;
        }

        if (frame.frame === 'hello') {
          backoff = MIN_BACKOFF_MS;
        }

        options.onFrame(frame);
      });
    }

    source.addEventListener('error', () => {
      source?.close();
      source = null;

      if (closed) {
        return;
      }

      options.onStatus('reconnecting');
      schedule(open, backoff);
      backoff = nextBackoff(backoff);
    });
  };
  open();

  return {
    close: () => {
      closed = true;
      source?.close();
    },
  };
}
