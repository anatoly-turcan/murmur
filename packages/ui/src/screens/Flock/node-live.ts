import type { PieceView } from '@murmur/dev-protocol';

import type { NodeLive } from '../../components/Graph.tsx';
import type { PlacedNode } from '../../graph/layout.ts';
import type { PieceLive } from '../../store/live.ts';
import { p95, recentlyFailed, sparkline } from '../../store/selectors.ts';

export interface NodeLiveInput {
  live: Map<string, PieceLive>;
  pieces: Map<string, PieceView>;
  cleared: Record<string, number>;
  now: number;
}

function sum(values: number[][]): number[] {
  return values.reduce((acc, v) => acc.map((x, i) => x + (v[i] ?? 0)), values[0]?.map(() => 0) ?? []);
}

export function nodeLive(node: PlacedNode, input: NodeLiveInput): NodeLive {
  const members = node.members;
  const lives = members.map((m) => input.live.get(m));
  const dead = members.reduce(
    (n, m, i) => n + (lives[i]?.counters.deadLettered ?? input.pieces.get(m)?.counters.deadLettered ?? 0),
    0,
  );
  const p95s = members.flatMap((m, i) => p95(lives[i], input.pieces.get(m)?.p95Ms ?? null) ?? []);

  return {
    spark: sum(lives.map((l) => sparkline(l, input.now))),
    inflight: lives.reduce((n, l) => n + (l?.counters.inflight ?? 0), 0),
    p95: p95s.length ? Math.max(...p95s) : null,
    failed:
      lives.some((l) => recentlyFailed(l, input.now)) ||
      members.some((m) => input.pieces.get(m)?.status === 'failed'),
    deadLettered: Math.max(0, dead - (input.cleared[node.id] ?? 0)),
  };
}
