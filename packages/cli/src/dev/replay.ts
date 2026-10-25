import type { EnvelopesPage, StoredEnvelope } from '@murmur/dev-protocol';

import { matchesEnv, type EnvFilter } from './filter.ts';

export interface ReplayBuffer {
  push(stored: StoredEnvelope): void;
  oldestSeq(): number | null;
  since(seq: number): StoredEnvelope[];
  page(filter: EnvFilter, limit: number, before: number | null): EnvelopesPage;
  byTrace(traceId: string): StoredEnvelope[];
  byPiece(piece: string, limit: number): StoredEnvelope[];
  traceIds(prefix: string): string[];
}

function indexPush(index: Map<string, number[]>, key: string | undefined, seq: number): void {
  if (key === undefined) {
    return;
  }

  const list = index.get(key);
  if (list === undefined) {
    index.set(key, [seq]);
  } else {
    list.push(seq);
  }
}

function indexDrop(index: Map<string, number[]>, key: string | undefined, seq: number): void {
  if (key === undefined) {
    return;
  }

  const list = index.get(key);
  if (list?.[0] === seq) {
    list.shift();
  }

  if (list?.length === 0) {
    index.delete(key);
  }
}

export function createReplay(capacity: number): ReplayBuffer {
  const items = new Map<number, StoredEnvelope>();
  const traces = new Map<string, number[]>();
  const pieces = new Map<string, number[]>();
  const lookup = (seqs: readonly number[] | undefined) => (seqs ?? []).flatMap((seq) => items.get(seq) ?? []);

  const evict = () => {
    const [seq, oldest] = items.entries().next().value as [number, StoredEnvelope];
    items.delete(seq);
    indexDrop(traces, oldest.envelope.traceId, seq);
    indexDrop(pieces, oldest.meta.piece, seq);
  };

  return {
    push: (stored) => {
      items.set(stored.seq, stored);
      indexPush(traces, stored.envelope.traceId, stored.seq);
      indexPush(pieces, stored.meta.piece, stored.seq);

      while (items.size > capacity) {
        evict();
      }
    },
    oldestSeq: () => (items.keys().next().value as number | undefined) ?? null,
    since: (seq) => [...items.values()].filter((stored) => stored.seq > seq),
    page: (filter, limit, before) => {
      const matching = [...items.values()].filter(
        (stored) => (before === null || stored.seq < before) && matchesEnv(stored, filter),
      );
      const page = matching.slice(-limit);

      return { items: page, nextBefore: matching.length > page.length ? (page[0]?.seq ?? null) : null };
    },
    byTrace: (traceId) => lookup(traces.get(traceId)),
    byPiece: (piece, limit) => lookup(pieces.get(piece)).slice(-limit),
    traceIds: (prefix) => [...traces.keys()].filter((id) => id.startsWith(prefix)),
  };
}
