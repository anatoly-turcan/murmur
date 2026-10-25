import type { Trace, TraceNode } from '@murmur/dev-protocol';
import { describe, expect, test } from 'vitest';

import { layoutWaterfall, toPercent } from '../components/waterfall-math.ts';
import { envelope, present } from './fixtures.ts';

const t0 = Date.parse('2026-10-24T10:00:00.000Z');
const at = (ms: number) => new Date(t0 + ms).toISOString();

function node(id: string, parentId: string | null, depth: number, over: Partial<TraceNode> = {}): TraceNode {
  return {
    id,
    parentId,
    depth,
    envelope: envelope({ id, ts: at(depth * 10), ...(parentId ? { causationId: parentId } : {}) }),
    deliveries: [],
    ...over,
  };
}

function trace(nodes: TraceNode[], over: Partial<Trace> = {}): Trace {
  return {
    traceId: 'trace-1',
    root: { seq: 1, envelope: present(nodes[0]).envelope, meta: { internal: false } },
    nodes,
    startedAt: at(0),
    endedAt: at(1000),
    durationMs: 1000,
    failed: false,
    maxHop: 2,
    ...over,
  };
}

const delivery = (
  piece: string,
  attempt: number,
  from: number,
  to: number | null,
  outcome: 'acked' | 'failed' | 'retried' | 'inflight' | 'deadLettered',
  error?: string,
) => ({
  piece,
  attempt,
  receivedAt: at(from),
  endedAt: to === null ? null : at(to),
  durationMs: to === null ? null : to - from,
  outcome,
  ...(error ? { error } : {}),
});

describe('waterfall math', () => {
  const nodes = [
    node('root', null, 0, {
      envelope: envelope({ id: 'root', name: 'todos.create', ts: at(0) }),
      deliveries: [delivery('todos/create', 1, 5, 105, 'acked')],
      reply: { envelopeId: 'reply-1', durationMs: 110, timedOut: false },
    }),
    node('child-b', 'root', 1, {
      envelope: envelope({ id: 'child-b', ts: at(100), causationId: 'root' }),
      deliveries: [
        delivery('billing/sim/rates', 2, 500, 600, 'acked'),
        delivery('billing/sim/rates', 1, 120, 200, 'retried', 'boom'),
      ],
    }),
    node('child-a', 'root', 1, {
      envelope: envelope({ id: 'child-a', ts: at(90), causationId: 'root' }),
      deliveries: [delivery('stats', 1, 95, 99, 'failed', 'nope')],
    }),
    node('grandchild', 'child-b', 2, {
      envelope: envelope({ id: 'grandchild', ts: at(600), causationId: 'child-b' }),
      deliveries: [delivery('audit/record', 1, 610, null, 'inflight')],
    }),
  ];

  test('rows follow causation order (children by time) with group-depth indentation', () => {
    const w = layoutWaterfall(trace(nodes));
    expect(w.rows.map((r) => [r.nodeId, r.piece, r.indent, r.causalDepth])).toEqual([
      ['root', 'todos/create', 1, 0],
      ['child-a', 'stats', 0, 1],
      ['child-b', 'billing/sim/rates', 2, 1],
      ['grandchild', 'audit/record', 1, 2],
    ]);
    expect(w.events).toBe(4);
    expect(w.maxHop).toBe(2);
  });

  test('bars are placed relative to trace start; retries stack with backoff gaps', () => {
    const w = layoutWaterfall(trace(nodes));
    const rates = present(w.rows[2]);
    expect(rates.bars.map((b) => [b.attempt, b.start, b.end, b.outcome])).toEqual([
      [1, 120, 200, 'retried'],
      [2, 500, 600, 'acked'],
    ]);
    expect(rates.gaps).toEqual([{ start: 200, end: 500 }]);
    expect(present(rates.bars[0]).error).toBe('boom');
  });

  test('failures mark the row; inflight bars run to the trace end', () => {
    const w = layoutWaterfall(trace(nodes));
    expect(present(w.rows[1]).failed).toBe(true);
    expect(present(w.rows[2]).failed).toBe(false);
    expect(present(w.rows[3]).bars[0]).toMatchObject({ start: 610, end: 1000, outcome: 'inflight' });
    const open = layoutWaterfall(trace(nodes, { endedAt: null, durationMs: null }), t0 + 2000);
    expect(open.totalMs).toBe(2000);
    expect(present(present(open.rows[3]).bars[0]).end).toBe(2000);
  });

  test('request/reply is a bracket from the request to the reply', () => {
    const w = layoutWaterfall(trace(nodes));
    expect(present(w.rows[0]).reply).toEqual({ start: 0, end: 110, timedOut: false });
    expect(w.rows.slice(1).every((r) => r.reply === undefined)).toBe(true);
  });

  test('guide lines link each row to its causal parent row', () => {
    const w = layoutWaterfall(trace(nodes));
    expect(w.rows.map((r) => r.parentRow)).toEqual([null, 0, 0, 2]);
  });

  test('a node without deliveries still gets one row', () => {
    const w = layoutWaterfall(trace([node('lonely', null, 0)]));
    expect(w.rows).toEqual([
      expect.objectContaining({ nodeId: 'lonely', piece: null, bars: [], gaps: [], indent: 0 }),
    ]);
  });

  test('percent helper clamps and guards a zero total', () => {
    expect(toPercent(250, 1000)).toBe(25);
    expect(toPercent(2000, 1000)).toBe(100);
    expect(toPercent(-5, 1000)).toBe(0);
    expect(toPercent(5, 0)).toBe(0);
  });
});
