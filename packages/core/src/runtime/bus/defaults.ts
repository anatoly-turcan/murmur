import type { Clock, Ids } from '../../model/capabilities.ts';
import { MurmurError } from '../../model/errors.ts';
import type { LogLine } from './types.ts';

const SHORT_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function shortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));

  return Array.from(bytes, (byte) => SHORT_ALPHABET[byte % SHORT_ALPHABET.length]).join('');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });

  return promise;
}

export const systemIds: Ids = Object.freeze({ uuid: () => crypto.randomUUID(), short: shortId });

function refuse(operation: string): () => Promise<never> {
  return async () => {
    throw new MurmurError(
      `clock.${operation} needs capabilities.clock.overridable: true in murmur.yaml (test environments only); the system clock cannot be moved`,
      { code: 'clock-not-overridable', retryable: false },
    );
  };
}

export const systemClock: Clock = Object.freeze({
  now: () => Temporal.Now.instant(),
  zonedNow: (tz?: string) => Temporal.Now.zonedDateTimeISO(tz ?? Temporal.Now.timeZoneId()),
  sleep,
  freeze: refuse('freeze'),
  advance: refuse('advance'),
  clear: refuse('clear'),
});

export function consoleSink(line: LogLine): void {
  console.error(JSON.stringify(line));
}
