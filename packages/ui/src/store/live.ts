import type { PieceCounters, Snapshot } from '@murmur/dev-protocol';

import type { DeliveryFact } from './sys.ts';

export const SPARK_SECONDS = 60;
const MAX_DURATIONS = 200;

export interface PieceLive {
  counters: PieceCounters;
  spark: number[];
  sparkSecond: number;
  durations: number[];
  failedAt: number | null;
  lastDeliveryAt: number | null;
}

function zeroCounters(): PieceCounters {
  return { received: 0, acked: 0, failed: 0, retried: 0, deadLettered: 0, inflight: 0 };
}

export function emptyLive(counters: PieceCounters = zeroCounters()): PieceLive {
  return {
    counters: { ...counters },
    spark: Array.from({ length: SPARK_SECONDS }, () => 0),
    sparkSecond: 0,
    durations: [],
    failedAt: null,
    lastDeliveryAt: null,
  };
}

export function seedLive(snapshot: Snapshot, previous: Map<string, PieceLive>): Map<string, PieceLive> {
  const next = new Map<string, PieceLive>();
  for (const piece of snapshot.pieces) {
    const before = previous.get(piece.name);
    next.set(piece.name, { ...(before ?? emptyLive()), counters: { ...piece.counters } });
  }

  return next;
}

export function shiftSpark(spark: number[], from: number, to: number): number[] {
  const steps = to - from;
  if (steps <= 0) {
    return spark;
  }

  if (steps >= spark.length) {
    return spark.map(() => 0);
  }

  return [...spark.slice(steps), ...Array.from({ length: steps }, () => 0)];
}

function tick(live: PieceLive, at: number): void {
  const second = Math.floor(at / 1000);
  if (second > live.sparkSecond) {
    live.spark = shiftSpark(live.spark, live.sparkSecond || second, second);
    live.sparkSecond = second;
  }

  const slot = live.spark.length - 1 - (live.sparkSecond - second);
  if (slot >= 0) {
    live.spark[slot] = (live.spark[slot] ?? 0) + 1;
  }
}

function recordDuration(live: PieceLive, durationMs: number | null): void {
  if (durationMs === null) {
    return;
  }

  live.durations.push(durationMs);

  if (live.durations.length > MAX_DURATIONS) {
    live.durations.shift();
  }
}

function settle(live: PieceLive, fact: DeliveryFact): void {
  live.counters.inflight = Math.max(0, live.counters.inflight - 1);
  recordDuration(live, fact.durationMs);
  tick(live, fact.at);
}

export function applyFact(live: PieceLive, fact: DeliveryFact): void {
  const c = live.counters;
  if (fact.kind === 'received') {
    c.received++;
    c.inflight++;
    live.lastDeliveryAt = fact.at;
  } else if (fact.kind === 'acked') {
    c.acked++;
    settle(live, fact);
  } else if (fact.kind === 'failed') {
    c.failed++;
    live.failedAt = fact.at;
    settle(live, fact);
  } else if (fact.kind === 'retried') {
    c.retried++;
  } else if (fact.kind === 'deadlettered') {
    c.deadLettered++;
    live.failedAt = fact.at;
  }
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = values.toSorted((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}
