import type { Trace, TraceDelivery, TraceNode } from '@murmur/dev-protocol';

import { compareIds } from '../store/tree.ts';

export interface WaterfallBar {
  piece: string;
  attempt: number;
  start: number;
  end: number;
  outcome: TraceDelivery['outcome'];
  error?: string;
}

export interface WaterfallRow {
  nodeId: string;
  name: string;
  piece: string | null;
  indent: number;
  causalDepth: number;
  parentRow: number | null;
  bars: WaterfallBar[];
  gaps: { start: number; end: number }[];
  reply?: { start: number; end: number; timedOut: boolean; rejected?: number };
  deduped?: { count: number; by: string[] };
  origin?: RowOrigin;
  failed: boolean;
  node: TraceNode;
}

export type RowOrigin = { kind: 'ingress'; piece: string | null } | { kind: 'background'; piece: string };

export interface WaterfallOptions {
  guards?: ReadonlySet<string>;
}

export interface Waterfall {
  startMs: number;
  totalMs: number;
  events: number;
  maxHop: number;
  rows: WaterfallRow[];
}

const FAILED = new Set<TraceDelivery['outcome']>(['failed', 'deadLettered']);

export function toPercent(ms: number, totalMs: number): number {
  if (totalMs <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, (ms / totalMs) * 100));
}

function byTime(a: TraceNode, b: TraceNode): number {
  return Date.parse(a.envelope.ts) - Date.parse(b.envelope.ts) || compareIds(a, b);
}

function guardsFirst(guards: ReadonlySet<string>): (a: TraceNode, b: TraceNode) => number {
  const rank = (node: TraceNode) => (guards.has(node.envelope.name) ? 0 : 1);

  return (a, b) => rank(a) - rank(b) || byTime(a, b);
}

function causationOrder(nodes: TraceNode[], guards: ReadonlySet<string>): TraceNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const children = Map.groupBy(nodes, (n) => (n.parentId && ids.has(n.parentId) ? n.parentId : null));
  const ordered: TraceNode[] = [];
  const order = guardsFirst(guards);
  const walk = (parent: string | null): void => {
    for (const node of (children.get(parent) ?? []).toSorted(order)) {
      ordered.push(node);
      walk(node.id);
    }
  };
  walk(null);

  return ordered;
}

function groupDepth(piece: string | null): number {
  return piece ? piece.split('/').length - 1 : 0;
}

function bar(d: TraceDelivery, startMs: number, endMs: number): WaterfallBar {
  const start = Date.parse(d.receivedAt) - startMs;
  const end = d.endedAt ? Date.parse(d.endedAt) - startMs : endMs;

  return {
    piece: d.piece,
    attempt: d.attempt,
    start,
    end,
    outcome: d.outcome,
    ...errorOf(d),
  };
}

function errorOf(d: TraceDelivery): Pick<WaterfallBar, 'error'> {
  const parts = [d.error, d.reason === undefined ? undefined : `(${d.reason})`].filter(Boolean);
  if (parts.length === 0) {
    return {};
  }

  return { error: parts.join(' ') };
}

function gapsBetween(bars: WaterfallBar[]): { start: number; end: number }[] {
  return bars.slice(1).flatMap((b, i) => {
    const prev = bars[i];

    return prev !== undefined && b.start > prev.end ? [{ start: prev.end, end: b.start }] : [];
  });
}

function lanes(node: TraceNode, origin: RowOrigin | undefined): (string | null)[] {
  const pieces = [...new Set(node.deliveries.map((d) => d.piece))];
  if (pieces.length > 0) {
    return pieces;
  }

  return [origin?.piece ?? null];
}

export function originOf(trace: Trace): RowOrigin | undefined {
  if (trace.background !== undefined) {
    return { kind: 'background', piece: trace.background.piece };
  }

  if (trace.root.envelope.name.startsWith('$ingress.')) {
    return { kind: 'ingress', piece: trace.root.meta.piece ?? null };
  }

  return undefined;
}

function endOf(trace: Trace, startMs: number, nowMs: number): number {
  if (trace.endedAt) {
    return Date.parse(trace.endedAt) - startMs;
  }

  if (trace.durationMs !== null) {
    return trace.durationMs;
  }

  return Math.max(0, nowMs - startMs);
}

interface RowContext {
  startMs: number;
  endMs: number;
  firstRow: Map<string, number>;
  rootId: string;
  origin: RowOrigin | undefined;
}

function replyOf(node: TraceNode, sent: number): Pick<WaterfallRow, 'reply'> {
  if (node.reply === undefined) {
    return {};
  }

  const { durationMs, timedOut, rejected } = node.reply;
  const end = sent + durationMs;

  return { reply: { start: sent, end, timedOut, ...(rejected === undefined ? {} : { rejected }) } };
}

function firstLaneFacts(node: TraceNode, origin: RowOrigin | undefined, sent: number): Partial<WaterfallRow> {
  return {
    ...replyOf(node, sent),
    ...(node.deduped === undefined ? {} : { deduped: node.deduped }),
    ...(origin === undefined ? {} : { origin }),
  };
}

function rowsFor(node: TraceNode, ctx: RowContext): WaterfallRow[] {
  const origin = node.id === ctx.rootId ? ctx.origin : undefined;

  return lanes(node, origin).map((piece, lane) => {
    const bars = node.deliveries
      .filter((d) => d.piece === piece)
      .toSorted((a, b) => a.attempt - b.attempt)
      .map((d) => bar(d, ctx.startMs, ctx.endMs));
    const sent = Date.parse(node.envelope.ts) - ctx.startMs;
    const first = lane === 0 ? firstLaneFacts(node, origin, sent) : {};

    return {
      nodeId: node.id,
      name: node.envelope.name,
      piece,
      indent: groupDepth(piece),
      causalDepth: node.depth,
      parentRow: node.parentId ? (ctx.firstRow.get(node.parentId) ?? null) : null,
      bars,
      gaps: gapsBetween(bars),
      failed: bars.some((b) => FAILED.has(b.outcome)),
      node,
      ...first,
    };
  });
}

export function layoutWaterfall(trace: Trace, nowMs = Date.now(), options: WaterfallOptions = {}): Waterfall {
  const startMs = Date.parse(trace.startedAt);
  const endMs = endOf(trace, startMs, nowMs);
  const ctx: RowContext = {
    startMs,
    endMs,
    firstRow: new Map(),
    rootId: trace.root.envelope.id,
    origin: originOf(trace),
  };
  const rows: WaterfallRow[] = [];

  for (const node of causationOrder(trace.nodes, options.guards ?? new Set())) {
    ctx.firstRow.set(node.id, rows.length);
    rows.push(...rowsFor(node, ctx));
  }

  const furthest = Math.max(endMs, ...rows.flatMap((r) => [...r.bars.map((b) => b.end), r.reply?.end ?? 0]));

  return { startMs, totalMs: Math.max(1, furthest), events: trace.nodes.length, maxHop: trace.maxHop, rows };
}
