import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Envelope } from 'murmur';

import { devStopPolicy } from '../src/index.ts';
import type {
  CatalogWarningCode,
  Frame,
  LogLine,
  PieceView,
  Snapshot,
  StoredEnvelope,
  Trace,
  TraceNode,
} from '../src/index.ts';

const ts = '2026-10-24T00:00:00.000Z';

const envelope: Envelope = { id: 'e1', name: 'todos.created', traceId: 't1', ts, hop: 0, payload: {} };

const piece: PieceView = {
  name: 'todos/create',
  className: 'CreateTodo',
  kind: 'domain',
  title: 'create',
  summary: null,
  dir: 'pieces/todos/create',
  parent: 'todos',
  depth: 1,
  children: [],
  needs: ['sqlite'],
  emits: ['todos.created'],
  handles: ['todos.create'],
  config: [{ key: 'maxTitle', type: 'number', source: 'default', env: 'MURMUR__TODOS_CREATE__MAXTITLE' }],
  policy: {
    concurrency: 1,
    timeoutMs: 30_000,
    retry: { maxAttempts: 5, baseMs: 200, maxMs: 30_000, jitter: 0.2 },
    requestTimeoutMs: 10_000,
  },
  status: 'running',
  counters: { received: 0, acked: 0, failed: 0, retried: 0, deadLettered: 0, inflight: 0 },
  lastDeliveryAt: null,
  p50Ms: null,
  p95Ms: null,
  hasContextMd: true,
  hasTests: true,
};

const snapshot: Snapshot = {
  app: { name: 'todo-api', root: '/app', transport: 'memory', startedAt: ts, bootDurationMs: 12 },
  pieces: [piece],
  contracts: [],
  capabilities: [{ name: 'sqlite', kind: 'handle', usedBy: ['todos/create'] }],
  warnings: [],
  lastSeq: 0,
};

function label(frame: Frame): string {
  switch (frame.frame) {
    case 'hello':
      return `hello ${frame.snapshot.app.name} from ${frame.replayFrom ?? 'live'}`;
    case 'env':
      return `env ${frame.envelope.name} ${frame.meta.internal}`;
    case 'dev.restart':
      return `restart ${frame.reason.join(',')}`;
    case 'dev.boot':
      return `boot ${frame.durationMs}`;
    case 'dev.boot_failed':
      return `boot failed ${frame.report.errors.length}`;
    case 'dev.child_exit':
      return `exit ${frame.code ?? frame.signal} ${frame.drained}`;
    case 'dev.paused':
    case 'dev.resumed':
      return frame.frame;
    case 'ping':
      return 'ping';
    default:
      return frame satisfies never;
  }
}

describe('@murmur/dev-protocol', () => {
  test('devStopPolicy is the frozen dev shutdown budget', () => {
    assert.deepEqual(devStopPolicy, { graceMs: 2000, forceMs: 500 });
    assert.ok(Object.isFrozen(devStopPolicy));
  });

  test('Frame is a discriminated union over every §6.3 frame', () => {
    const frames: Frame[] = [
      { frame: 'hello', seq: 0, ts, protocol: 1, snapshot, replayFrom: null },
      { frame: 'env', seq: 1, ts, envelope, meta: { piece: 'todos/create', attempt: 1, internal: false } },
      { frame: 'dev.restart', seq: 2, ts, reason: ['pieces/todos/create/piece.ts'] },
      { frame: 'dev.boot', seq: 3, ts, snapshot, durationMs: 40 },
      {
        frame: 'dev.boot_failed',
        seq: 4,
        ts,
        report: { ok: false, pieces: [], errors: [{ phase: 'load', message: 'boom' }], warnings: [] },
      },
      { frame: 'dev.child_exit', seq: 5, ts, code: 0, signal: null, drained: true },
      { frame: 'dev.paused', seq: 6, ts },
      { frame: 'dev.resumed', seq: 7, ts },
      { frame: 'ping', seq: 8, ts },
    ];
    assert.deepEqual(frames.map(label), [
      'hello todo-api from live',
      'env todos.created false',
      'restart pieces/todos/create/piece.ts',
      'boot 40',
      'boot failed 1',
      'exit 0 true',
      'dev.paused',
      'dev.resumed',
      'ping',
    ]);
  });

  test('stored envelopes, trace nodes and log lines carry the §6.3 shapes', () => {
    const stored: StoredEnvelope = { seq: 1, envelope, meta: { internal: false } };
    const node: TraceNode = {
      id: 'e1',
      parentId: null,
      depth: 0,
      envelope,
      deliveries: [
        { piece: 'todos/create', attempt: 1, receivedAt: ts, endedAt: ts, durationMs: 3, outcome: 'acked' },
      ],
    };
    const line: LogLine = { ts, level: 'info', piece: 'todos/create', msg: 'created', traceId: 't1' };
    assert.equal(stored.envelope, node.envelope);
    assert.equal(line.level, 'info');
  });

  test('v0.2 fields are additive: class pieces, contract kinds, routes, dedupe and background roots', () => {
    const edge: PieceView = {
      ...piece,
      name: 'api/rest',
      className: 'RestApi',
      kind: 'edge',
      serves: ['GET /todos/:id'],
      requests: ['todos.GetTodo'],
    };
    const v2: Snapshot = {
      ...snapshot,
      pieces: [piece, edge],
      contracts: [
        {
          name: 'auth.Authenticate',
          kind: 'guard',
          className: 'Authenticate',
          hasReply: true,
          visibility: 'public',
          scope: null,
          file: 'contracts/auth.ts',
          emitters: [],
          requesters: ['(web defaults)'],
          handlers: ['auth'],
          schema: { payload: {}, reply: {} },
        },
      ],
      routes: [
        {
          transport: 'http',
          token: 'web',
          key: 'GET /todos/:id',
          piece: 'api/rest',
          method: 'show',
          guards: ['auth.Authenticate'],
        },
      ],
    };
    const node: TraceNode = {
      id: 'e1',
      parentId: null,
      depth: 0,
      envelope,
      deliveries: [],
      deduped: { count: 1, by: ['api/rest'] },
    };
    const trace: Trace = {
      traceId: 't1',
      root: { seq: 1, envelope, meta: { internal: false } },
      nodes: [node],
      startedAt: ts,
      endedAt: null,
      durationMs: null,
      failed: false,
      maxHop: 0,
      background: { piece: 'api/feed' },
    };
    const codes: CatalogWarningCode[] = [
      'binding-conflict',
      'route-shadowed',
      'route-family-split',
      'guard-never-handled',
      'guard-output-overlap',
    ];
    assert.equal(v2.routes?.[0]?.piece, edge.name);
    assert.equal(trace.nodes[0]?.deduped?.count, 1);
    assert.equal(codes.length, 5);
  });

  test('protocol and frame names are literal types', () => {
    // @ts-expect-error protocol is the literal 1
    const wrongProtocol: Frame = { frame: 'hello', seq: 0, ts, protocol: 2, snapshot, replayFrom: null };
    // @ts-expect-error unknown frame name
    const wrongFrame: Frame = { frame: 'dev.crashed', seq: 0, ts };
    assert.ok(wrongProtocol && wrongFrame);
  });
});
