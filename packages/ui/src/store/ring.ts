import type { StoredEnvelope } from '@murmur/dev-protocol';

import { deliveryFact } from './sys.ts';

export interface Ring {
  capacity: number;
  items: StoredEnvelope[];
  head: number;
  bySeq: Map<number, StoredEnvelope>;
  byTrace: Map<string, number[]>;
  byPiece: Map<string, number[]>;
  byRef: Map<string, number[]>;
  newestSeq: number;
  evicted: number;
}

export function createRing(capacity: number): Ring {
  return {
    capacity,
    items: [],
    head: 0,
    bySeq: new Map(),
    byTrace: new Map(),
    byPiece: new Map(),
    byRef: new Map(),
    newestSeq: -1,
    evicted: 0,
  };
}

function keysOf(stored: StoredEnvelope): { trace: string; pieces: string[]; ref: string | null } {
  const pieces = new Set<string>();
  if (stored.envelope.source) {
    pieces.add(stored.envelope.source);
  }

  if (stored.meta.piece) {
    pieces.add(stored.meta.piece);
  }

  return {
    trace: stored.envelope.traceId,
    pieces: [...pieces],
    ref: deliveryFact(stored)?.envelopeId ?? null,
  };
}

function addIndex(index: Map<string, number[]>, key: string, seq: number): void {
  const list = index.get(key);
  if (list) {
    list.push(seq);
  } else {
    index.set(key, [seq]);
  }
}

function dropIndex(index: Map<string, number[]>, key: string, seq: number): void {
  const list = index.get(key);
  if (!list) {
    return;
  }

  if (list[0] === seq) {
    list.shift();
  } else {
    list.splice(list.indexOf(seq), 1);
  }

  if (list.length === 0) {
    index.delete(key);
  }
}

function updateIndexes(ring: Ring, stored: StoredEnvelope, apply: typeof addIndex): void {
  const keys = keysOf(stored);
  apply(ring.byTrace, keys.trace, stored.seq);

  for (const piece of keys.pieces) {
    apply(ring.byPiece, piece, stored.seq);
  }

  if (keys.ref) {
    apply(ring.byRef, keys.ref, stored.seq);
  }
}

function evictOldest(ring: Ring): void {
  const oldest = ring.items[ring.head];
  if (!oldest) {
    return;
  }

  ring.head++;
  ring.evicted++;
  ring.bySeq.delete(oldest.seq);
  updateIndexes(ring, oldest, dropIndex);

  if (ring.head >= ring.capacity) {
    ring.items = ring.items.slice(ring.head);
    ring.head = 0;
  }
}

export function ringSize(ring: Ring): number {
  return ring.items.length - ring.head;
}

export function pushRing(ring: Ring, stored: StoredEnvelope): boolean {
  if (stored.seq <= ring.newestSeq) {
    return false;
  }

  ring.items.push(stored);
  ring.bySeq.set(stored.seq, stored);
  ring.newestSeq = stored.seq;
  updateIndexes(ring, stored, addIndex);

  while (ringSize(ring) > ring.capacity) {
    evictOldest(ring);
  }

  return true;
}

export function ringItems(ring: Ring): StoredEnvelope[] {
  return ring.items.slice(ring.head);
}

function resolve(ring: Ring, seqs: number[] | undefined): StoredEnvelope[] {
  return (seqs ?? []).flatMap((seq) => ring.bySeq.get(seq) ?? []);
}

export function ringByTrace(ring: Ring, traceId: string): StoredEnvelope[] {
  return resolve(ring, ring.byTrace.get(traceId));
}

export function ringByPiece(ring: Ring, piece: string): StoredEnvelope[] {
  return resolve(ring, ring.byPiece.get(piece));
}

export function ringByRef(ring: Ring, envelopeId: string): StoredEnvelope[] {
  return resolve(ring, ring.byRef.get(envelopeId));
}
