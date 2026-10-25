import type { StoredEnvelope, TreeNode } from '@murmur/dev-protocol';

import { percentile, shiftSpark, SPARK_SECONDS, type PieceLive } from './live.ts';
import { ringByTrace, ringItems } from './ring.ts';
import { eventRow, type EventRow } from './rows.ts';
import { memoByVersion } from './store.ts';
import { deliveryFact } from './sys.ts';
import { buildTree } from './tree.ts';

export interface TraceSummary {
  traceId: string;
  root: StoredEnvelope;
  events: number;
  failures: number;
  durationMs: number;
  startedAt: number;
}

export const selectRows = memoByVersion((state): EventRow[] =>
  ringItems(state.ring).map((s) => eventRow(state.ring, s)),
);

export const selectTree = memoByVersion((state): TreeNode[] => buildTree(state.snapshot?.pieces ?? []));

function summarize(traceId: string, items: StoredEnvelope[]): TraceSummary | null {
  const user = items.filter((s) => !s.meta.internal);
  const root = user[0] ?? items[0];

  if (!root) {
    return null;
  }

  const times = items.map((s) => Date.parse(s.envelope.ts));
  const failures = items.filter((s) => {
    const kind = deliveryFact(s)?.kind;

    return kind === 'failed' || kind === 'deadlettered';
  }).length;

  return {
    traceId,
    root,
    events: user.length,
    failures,
    durationMs: Math.max(...times) - Math.min(...times),
    startedAt: Math.min(...times),
  };
}

export const selectTraces = memoByVersion((state): TraceSummary[] =>
  [...state.ring.byTrace.keys()]
    .flatMap((traceId) => summarize(traceId, ringByTrace(state.ring, traceId)) ?? [])
    .filter((t) => t.events > 0)
    .toSorted((a, b) => b.startedAt - a.startedAt),
);

export function sparkline(live: PieceLive | undefined, now: number): number[] {
  if (!live) {
    return Array.from({ length: SPARK_SECONDS }, () => 0);
  }

  return shiftSpark(live.spark, live.sparkSecond, Math.floor(now / 1000));
}

export function p95(live: PieceLive | undefined, fallback: number | null): number | null {
  return percentile(live?.durations ?? [], 95) ?? fallback;
}

export const FAILURE_WINDOW_MS = 10_000;

export function recentlyFailed(live: PieceLive | undefined, now: number): boolean {
  return live?.failedAt !== null && live?.failedAt !== undefined && now - live.failedAt < FAILURE_WINDOW_MS;
}
