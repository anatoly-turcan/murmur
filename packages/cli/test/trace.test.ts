import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StoredEnvelope } from '@murmur/dev-protocol';
import type { Envelope } from 'murmur';

import { buildTrace } from '../src/dev/trace.ts';
import { renderWaterfall } from '../src/render/waterfall.ts';

const TS = '2026-10-24T00:00:00.000Z';
const LATER = '2026-10-24T00:00:00.002Z';

function envelope(id: string, name: string, payload: unknown, extra: Partial<Envelope> = {}): Envelope {
  return { id, name, traceId: 't1', ts: TS, hop: 1, payload, ...extra };
}

function stored(items: readonly Envelope[]): StoredEnvelope[] {
  return items.map((e, seq) => ({ seq, envelope: e, meta: { internal: e.name.startsWith('$sys.') } }));
}

function guardRequest(id: string, name: string): Envelope {
  return envelope(
    id,
    name,
    {},
    { source: 'api/rest', causationId: 'in1', correlationId: `c-${id}`, replyTo: '$reply.x' },
  );
}

function delivered(id: string): Envelope[] {
  return [
    envelope(`r-${id}`, '$sys.delivery.received', {
      deliveryId: `d-${id}`,
      envelopeId: id,
      piece: 'auth',
      attempt: 1,
      at: TS,
    }),
    envelope(`a-${id}`, '$sys.delivery.acked', { deliveryId: `d-${id}`, at: LATER, durationMs: 2 }),
  ];
}

function reply(id: string, value: unknown): Envelope {
  return envelope(`re-${id}`, '$reply.x', { ok: true, value }, { correlationId: `c-${id}`, ts: LATER });
}

const ingress = envelope(
  'in1',
  '$ingress.http',
  { method: 'GET', path: '/todos/t1', binding: 'GET /todos/:id' },
  { hop: 0, source: 'external:http' },
);

const anonymousGet = stored([
  envelope('s1', '$sys.ingress.received', {
    piece: 'api/rest',
    transport: 'http',
    binding: 'GET /todos/:id',
    traceId: 't1',
    envelope: ingress,
  }),
  guardRequest('g1', 'auth.Authenticate'),
  guardRequest('g2', 'auth.RateLimit'),
  ...delivered('g1'),
  ...delivered('g2'),
  reply('g1', { status: 401, code: 'unauthorized', message: 'missing bearer token' }),
  reply('g2', { remaining: 59 }),
]);

test('an ingress entry is the trace root and its guard requests are its children', () => {
  const trace = buildTrace(anonymousGet);

  assert.equal(trace?.root.envelope.name, '$ingress.http');
  assert.deepEqual(
    trace?.nodes.map((node) => [node.envelope.name, node.parentId]),
    [
      ['$ingress.http', null],
      ['auth.Authenticate', 'in1'],
      ['auth.RateLimit', 'in1'],
    ],
  );
});

test('a tapped ingress entry is used as is and not synthesised a second time from ingress.received', () => {
  const [received, ...rest] = anonymousGet;
  const tapped = { seq: 0.5, envelope: ingress, meta: { internal: false, piece: 'external:http' } };
  const trace = buildTrace([received as StoredEnvelope, tapped, ...rest]);
  const synthesised = buildTrace(anonymousGet);

  assert.equal(trace?.nodes.filter((node) => node.id === 'in1').length, 1);
  assert.deepEqual(trace?.root, tapped);
  assert.equal(synthesised?.root.meta.piece, 'external:http');
});

test('a guard reply that is a Rejection carries its status; a model reply does not', () => {
  const trace = buildTrace(anonymousGet);
  const replies = trace?.nodes.map((node) => node.reply?.rejected);

  assert.deepEqual(replies, [undefined, 401, undefined]);
});

test('the waterfall prints the ingress payload on the root and rejected 401 on the refused guard', () => {
  const trace = buildTrace(anonymousGet);
  assert.ok(trace !== null);
  const text = renderWaterfall(trace, { width: 120, payload: false });

  assert.match(text, /^\$ingress\.http {2}\(http\).*"binding":"GET \/todos\/:id"/m);
  assert.match(text, /reply → api\/rest\s+rejected 401 \(2ms\)/);
  assert.equal(text.match(/rejected/g)?.length, 1);
});

function queryRequest(id: string): Envelope {
  return envelope(
    id,
    'todos.GetTodo',
    { id: 't1' },
    { source: 'api/rest', causationId: 'in1', correlationId: `c-${id}`, replyTo: '$reply.x' },
  );
}

function dedupedRecord(id: string): Envelope {
  return envelope(id, '$sys.request.deduped', {
    traceId: 't1',
    key: 'todos.GetTodo {"id":"t1"}',
    byPiece: 'api/rest',
    firstEnvelopeId: 'q1',
  });
}

test('a deduplicated query node counts the suppressed callers and the waterfall prints ×N', () => {
  const items = stored([ingress, queryRequest('q1'), dedupedRecord('dd1'), dedupedRecord('dd2')]);
  const trace = buildTrace(items);
  assert.ok(trace !== null);
  const text = renderWaterfall(trace, { width: 120, payload: false });

  assert.deepEqual(trace.nodes.find((node) => node.id === 'q1')?.deduped, { count: 2, by: ['api/rest'] });
  assert.equal(trace.nodes.find((node) => node.id === 'in1')?.deduped, undefined);
  assert.match(text, /todos\.GetTodo ×3.*deduped for api\/rest/);
});

test('a background emit labels the trace root with its piece', () => {
  const event = envelope('ev1', 'todos.TodoCreated', { id: 't1' }, { hop: 0, source: 'api/feed' });
  const background = envelope('bg1', '$sys.emit.background', {
    piece: 'api/feed',
    contract: 'todos.TodoCreated',
  });
  const trace = buildTrace(stored([background, event]));
  assert.ok(trace !== null);

  assert.deepEqual(trace.background, { piece: 'api/feed' });
  assert.match(
    renderWaterfall(trace, { width: 120, payload: false }),
    /^todos\.TodoCreated {2}\(background api\/feed\)/m,
  );
  assert.equal(buildTrace(anonymousGet)?.background, undefined);
});

test('a dead letter carries the reason of the failure into the trace and the waterfall note', () => {
  const error = { name: 'Error', message: 'requester gone' };
  const command = envelope(
    'c1',
    'todos.CreateTodo',
    {},
    { source: 'api/rest', correlationId: 'c-c1', hop: 0 },
  );
  const items = stored([
    command,
    envelope('r1', '$sys.delivery.received', {
      deliveryId: 'd1',
      envelopeId: 'c1',
      piece: 'todos',
      attempt: 1,
      at: TS,
    }),
    envelope('f1', '$sys.delivery.failed', {
      deliveryId: 'd1',
      at: LATER,
      attempt: 1,
      durationMs: 2,
      error,
      willRetry: false,
      phase: 'handler',
      reason: 'requester-gone',
    }),
    envelope('x1', '$sys.delivery.deadlettered', {
      deliveryId: 'd1',
      envelope: command,
      piece: 'todos',
      attempts: 1,
      error,
      phase: 'handler',
      at: LATER,
    }),
  ]);
  const trace = buildTrace(items);
  const delivery = trace?.nodes[0]?.deliveries[0];

  assert.deepEqual([delivery?.outcome, delivery?.reason], ['deadLettered', 'requester-gone']);
  assert.ok(trace);
  assert.match(
    renderWaterfall(trace, { width: 120, payload: false }),
    /Error: requester gone \(requester-gone\)/,
  );
});
