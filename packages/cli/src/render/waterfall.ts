import { callersSharing, type Trace, type TraceDelivery, type TraceNode } from '@murmur/dev-protocol';

import { isIngressName } from '../dev/meta.ts';
import { clockTime, instantMs } from './time.ts';

export interface WaterfallOptions {
  readonly width: number;
  readonly payload: boolean;
}

interface Row {
  readonly label: string;
  readonly meta: string;
  readonly start: number;
  readonly end: number | null;
  readonly note: string;
}

interface Walk {
  readonly trace: Trace;
  readonly origin: number;
  readonly children: ReadonlyMap<string, readonly TraceNode[]>;
  readonly payload: boolean;
}

const LABEL_MAX = 48;

function sinceStart(walk: Walk, ts: string): number {
  return instantMs(ts) - walk.origin;
}

function joined(parts: readonly (string | undefined)[], separator = ' '): string {
  return parts.filter((part) => part !== undefined && part !== '').join(separator);
}

function backoffNote(walk: Walk, start: number, previous: TraceDelivery | undefined): string | undefined {
  if (previous?.endedAt == null) {
    return undefined;
  }

  return `(+${Math.round(start - sinceStart(walk, previous.endedAt))}ms backoff)`;
}

function reasonNote(delivery: TraceDelivery): string | undefined {
  return delivery.reason === undefined ? undefined : `(${delivery.reason})`;
}

function deliveryRow(walk: Walk, delivery: TraceDelivery, previous: TraceDelivery | undefined): Row {
  const start = sinceStart(walk, delivery.receivedAt);
  const outcome = delivery.outcome === 'failed' ? 'FAILED' : delivery.outcome;
  const duration = delivery.durationMs === null ? undefined : `${delivery.durationMs}ms`;

  return {
    label: delivery.piece,
    meta: `attempt ${delivery.attempt}  ${joined([outcome, duration])}`,
    start,
    end: delivery.endedAt === null ? null : sinceStart(walk, delivery.endedAt),
    note: joined([joined([delivery.error, reasonNote(delivery)]), backoffNote(walk, start, previous)], '  '),
  };
}

type Item = { kind: 'row'; row: Row; children: Item[] };

function replyItem(node: TraceNode): Item[] {
  if (node.reply === undefined) {
    return [];
  }

  const label = `reply → ${sourceOf(node)}`;
  const rejected = node.reply.rejected === undefined ? '' : `rejected ${node.reply.rejected} `;
  const note = node.reply.timedOut
    ? `TIMED OUT (${node.reply.durationMs}ms)`
    : `${rejected}(${node.reply.durationMs}ms)`;

  return [{ kind: 'row', row: { label, meta: '', start: 0, end: null, note }, children: [] }];
}

function dedupeMark(node: TraceNode): string {
  if (node.deduped === undefined) {
    return '';
  }

  return ` ×${callersSharing(node.deduped)}`;
}

function dedupeNote(node: TraceNode): string | undefined {
  if (node.deduped === undefined) {
    return undefined;
  }

  return `deduped for ${node.deduped.by.join(', ')}`;
}

function rootLabel(walk: Walk, node: TraceNode, source: string): string {
  const background = walk.trace.background;
  if (background === undefined) {
    return `${node.envelope.name}  (${source})`;
  }

  return `${node.envelope.name}  (background ${background.piece})`;
}

function sourceOf(node: TraceNode): string {
  return (node.envelope.source ?? '—').replace(/^external:/, '');
}

function isRootNode(walk: Walk, node: TraceNode): boolean {
  return node.id === walk.trace.root.envelope.id;
}

function eventLabel(walk: Walk, node: TraceNode): string {
  const name = isRootNode(walk, node) ? rootLabel(walk, node, sourceOf(node)) : node.envelope.name;

  return `${name}${dedupeMark(node)}`;
}

function spanNote(walk: Walk, node: TraceNode): string | undefined {
  const { durationMs } = walk.trace;
  if (!isRootNode(walk, node) || durationMs === null) {
    return undefined;
  }

  return `0–${durationMs}ms`;
}

function payloadNote(walk: Walk, node: TraceNode): string | undefined {
  const ingressRoot = isRootNode(walk, node) && isIngressName(node.envelope.name);
  if (!walk.payload && !ingressRoot) {
    return undefined;
  }

  return JSON.stringify(node.envelope.payload);
}

function eventNote(walk: Walk, node: TraceNode): string {
  return joined([joined([spanNote(walk, node), payloadNote(walk, node)], '  '), dedupeNote(node)]);
}

function eventItem(walk: Walk, node: TraceNode): Item {
  const isRoot = isRootNode(walk, node);
  const children = walk.children.get(node.id) ?? [];
  const deliveries = node.deliveries.toSorted((a, b) => instantMs(a.receivedAt) - instantMs(b.receivedAt));
  const lastOf = (piece: string) => deliveries.findLast((d) => d.piece === piece);
  const nested = (delivery: TraceDelivery) =>
    lastOf(delivery.piece) === delivery
      ? children.filter((child) => child.envelope.source === delivery.piece)
      : [];
  const orphans = children.filter((child) => !deliveries.some((d) => d.piece === child.envelope.source));

  return {
    kind: 'row',
    row: {
      label: eventLabel(walk, node),
      meta: '',
      start: sinceStart(walk, node.envelope.ts),
      end: isRoot ? (walk.trace.durationMs ?? null) : null,
      note: eventNote(walk, node),
    },
    children: [
      ...deliveries.map((delivery, i) => ({
        kind: 'row' as const,
        row: deliveryRow(
          walk,
          delivery,
          deliveries.slice(0, i).findLast((d) => d.piece === delivery.piece),
        ),
        children: nested(delivery).map((child) => eventItem(walk, child)),
      })),
      ...orphans.map((child) => eventItem(walk, child)),
      ...replyItem(node),
    ],
  };
}

interface Line {
  readonly prefix: string;
  readonly row: Row;
}

function flatten(items: readonly Item[], indent: string, top: boolean): Line[] {
  return items.flatMap((item, i) => {
    const last = i === items.length - 1;
    const branch = last ? '└─ ' : '├─ ';
    const carry = last ? '   ' : '│  ';
    const prefix = top ? '' : `${indent}${branch}`;
    const childIndent = top ? '' : `${indent}${carry}`;

    return [{ prefix, row: item.row }, ...flatten(item.children, childIndent, false)];
  });
}

function bar(row: Row, total: number, width: number): string {
  const col = (ms: number) => Math.max(0, Math.min(width - 1, Math.round((ms / total) * (width - 1))));
  if (row.meta === '' && row.end === null) {
    return row.label.startsWith('reply') ? '' : `${' '.repeat(col(row.start))}·`;
  }

  const start = col(row.start);
  const end = Math.max(start + 1, col(row.end ?? total));

  return `${' '.repeat(start)}├${'█'.repeat(Math.max(0, end - start - 1))}┤`;
}

function header(trace: Trace): string {
  const deliveries = trace.nodes.flatMap((node) => node.deliveries);
  const failed = deliveries.filter((d) => d.outcome === 'failed' || d.outcome === 'deadLettered').length;
  const total = trace.durationMs === null ? 'in flight' : `${trace.durationMs} ms`;

  return `trace ${trace.traceId.slice(0, 8)}…  started ${clockTime(trace.startedAt)}  total ${total}  ${trace.nodes.length} events  ${deliveries.length} deliveries  ${failed} failed  max hop ${trace.maxHop}`;
}

function childrenMap(trace: Trace): Map<string, TraceNode[]> {
  return Map.groupBy(
    trace.nodes.filter((node) => node.parentId !== null),
    (node) => node.parentId as string,
  );
}

export function renderWaterfall(trace: Trace, options: WaterfallOptions): string {
  const walk: Walk = {
    trace,
    origin: instantMs(trace.startedAt),
    children: childrenMap(trace),
    payload: options.payload,
  };
  const rootNode = trace.nodes.find((node) => node.id === trace.root.envelope.id);
  const lines = rootNode === undefined ? [] : flatten([eventItem(walk, rootNode)], '', true);
  const labelWidth = Math.min(LABEL_MAX, Math.max(...lines.map((l) => (l.prefix + l.row.label).length)));
  const metaWidth = Math.max(0, ...lines.map((l) => l.row.meta.length));
  const barWidth = Math.max(10, options.width - labelWidth - metaWidth - 4);
  const total = Math.max(1, trace.durationMs ?? Math.max(...lines.map((l) => l.row.end ?? l.row.start)));
  const body = lines.map(({ prefix, row }) =>
    [
      `${(prefix + row.label).padEnd(labelWidth)}`,
      row.meta.padEnd(metaWidth),
      bar(row, total, barWidth),
      row.note,
    ]
      .join('  ')
      .trimEnd(),
  );

  return [header(trace), '', ...body].join('\n');
}
