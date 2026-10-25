import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Frame, Snapshot, StoredEnvelope } from '@murmur/dev-protocol';

import { instantMs } from '../render/time.ts';
import { filterOf, matchesEnv } from './filter.ts';
import type { ReplayBuffer } from './replay.ts';
import { parseSince, type Since } from './since.ts';
import type { SseHub } from './sse.ts';

export interface EventSource {
  readonly hub: SseHub;
  readonly replay: ReplayBuffer;
  snapshot(): Snapshot;
  lastSeq(): number;
}

const ALWAYS = new Set<Frame['frame']>(['hello', 'ping']);

function frameFilter(query: URLSearchParams): (frame: Frame) => boolean {
  const kinds = new Set((query.get('kinds') ?? '').split(',').filter((kind) => kind !== ''));
  const envFilter = filterOf(query);

  return (frame) => {
    if (ALWAYS.has(frame.frame)) {
      return true;
    }

    if (kinds.size > 0 && !kinds.has(frame.frame)) {
      return false;
    }

    return frame.frame !== 'env' || matchesEnv(frame, envFilter);
  };
}

function replayed(
  replay: ReplayBuffer,
  since: Since | null,
): { items: StoredEnvelope[]; from: number | null } {
  if (since === null) {
    return { items: [], from: null };
  }

  if (since.kind === 'age') {
    const cutoff = Date.now() - since.ms;
    const items = replay.since(-1).filter((stored) => instantMs(stored.envelope.ts) >= cutoff);

    return { items, from: items[0]?.seq ?? null };
  }

  const oldest = replay.oldestSeq() ?? since.seq + 1;

  return { items: replay.since(since.seq), from: Math.max(since.seq + 1, oldest) };
}

function envFrame(stored: StoredEnvelope): Frame {
  return {
    frame: 'env',
    seq: stored.seq,
    ts: stored.envelope.ts,
    envelope: stored.envelope,
    meta: stored.meta,
  };
}

export function openEventStream(
  source: EventSource,
  req: IncomingMessage,
  res: ServerResponse,
  headers: Record<string, string>,
  query: URLSearchParams,
): void {
  const lastEventId = req.headers['last-event-id'];
  const since = parseSince(query.get('since') ?? (typeof lastEventId === 'string' ? lastEventId : null));
  const snapshot = source.snapshot();
  const accepts = frameFilter(query);
  const { items, from } = replayed(source.replay, since);
  const write = source.hub.open(res, headers, accepts);
  const ts = new Date().toISOString();
  write({ frame: 'hello', seq: source.lastSeq(), ts, protocol: 1, snapshot, replayFrom: from });

  for (const frame of items.map(envFrame)) {
    if (accepts(frame)) {
      write(frame);
    }
  }
}
