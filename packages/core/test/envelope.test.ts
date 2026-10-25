import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createEnvelope,
  EnvelopeShapeError,
  parseEnvelope,
  serializeEnvelope,
  type Envelope,
  type RunContext,
} from 'murmur';
import { fakeClock, fakeIds } from 'murmur/testing';

import { envelopeBytes } from '../src/runtime/envelope.ts';

const examples = [
  '{ "id": "7b00c1a4-1e8e-4d2e-9d3e-6a2f0c3b1d55", "name": "billing.invoice.requested", "traceId": "80521f3a-91c2-4b62-8a16-f4a7d9e0c2ab", "correlationId": "c0f1e2d3-4a5b-4c6d-8e9f-0a1b2c3d4e5f", "replyTo": "$reply.1f9a2b3c", "ts": "2026-10-24T03:37:23.197500977Z", "hop": 0, "source": "external:http", "payload": { "customerId": "c1", "lines": [{ "sku": "a", "qty": 1 }] } }',
  '{ "id": "638c7a9e-2b4f-4e1a-b7c3-9d8e7f6a5b4c", "name": "billing.invoice.created", "traceId": "80521f3a-91c2-4b62-8a16-f4a7d9e0c2ab", "causationId": "7b00c1a4-1e8e-4d2e-9d3e-6a2f0c3b1d55", "ts": "2026-10-24T03:37:23.231000120Z", "hop": 1, "source": "billing/invoice", "payload": { "id": "inv-1", "total": 1200 } }',
  '{ "id": "a1b2c3d4-0000-4000-8000-000000000001", "name": "$reply.1f9a2b3c", "traceId": "80521f3a-91c2-4b62-8a16-f4a7d9e0c2ab", "causationId": "7b00c1a4-1e8e-4d2e-9d3e-6a2f0c3b1d55", "correlationId": "c0f1e2d3-4a5b-4c6d-8e9f-0a1b2c3d4e5f", "ts": "2026-10-24T03:37:23.240000000Z", "hop": 1, "source": "billing/invoice", "payload": { "ok": true, "value": { "invoiceId": "inv-1" } } }',
];

const base = JSON.parse(examples[1] ?? '') as Record<string, unknown>;

function withField(key: string, value: unknown): string {
  return JSON.stringify({ ...base, [key]: value });
}

function without(key: string): string {
  const copy = { ...base };
  delete copy[key];

  return JSON.stringify(copy);
}

test('the three §3.7 examples round-trip in table key order', () => {
  for (const json of examples) {
    const parsed = parseEnvelope(json);
    const serialized = serializeEnvelope(parsed);
    assert.equal(serialized, JSON.stringify(JSON.parse(json)));
    assert.deepEqual(parseEnvelope(serialized), parsed);
    assert.deepEqual(parseEnvelope(new TextEncoder().encode(serialized)), parsed);
  }
});

test('parseEnvelope rejects an unknown key', () => {
  assert.throws(() => parseEnvelope(withField('version', 2)), EnvelopeShapeError);
});

test('parseEnvelope accepts a 32-hex traceId and rejects TRACE', () => {
  assert.equal(
    parseEnvelope(withField('traceId', '0af7651916cd43dd8448eb211c80319c')).traceId,
    '0af7651916cd43dd8448eb211c80319c',
  );
  assert.throws(() => parseEnvelope(withField('traceId', 'TRACE')), EnvelopeShapeError);
  assert.throws(() => parseEnvelope(withField('traceId', 'abc')), EnvelopeShapeError);
});

test('parseEnvelope rejects missing fields, wrong types and non-objects', () => {
  for (const key of ['id', 'name', 'traceId', 'ts', 'hop', 'payload']) {
    assert.throws(() => parseEnvelope(without(key)), EnvelopeShapeError, `missing ${key}`);
  }

  const wrong: [string, unknown][] = [
    ['id', 1],
    ['name', null],
    ['hop', -1],
    ['hop', 1.5],
    ['hop', '1'],
    ['ts', 0],
    ['source', 3],
    ['causationId', null],
    ['replyTo', {}],
  ];

  for (const [key, value] of wrong) {
    assert.throws(
      () => parseEnvelope(withField(key, value)),
      EnvelopeShapeError,
      `${key}=${JSON.stringify(value)}`,
    );
  }

  for (const json of ['not json', '[]', 'null', '"x"']) {
    assert.throws(() => parseEnvelope(json), EnvelopeShapeError, json);
  }
});

test('parseEnvelope accepts a null payload and does not check UUID versions', () => {
  const parsed = parseEnvelope(JSON.stringify({ ...base, id: 'not-a-uuid', payload: null }));
  assert.equal(parsed.payload, null);
  assert.equal(parsed.id, 'not-a-uuid');
});

test('createEnvelope builds a root with traceId === id and hop 0', () => {
  const clock = fakeClock('2026-10-24T03:37:23.197500977Z');
  const envelope = createEnvelope({
    name: 'billing.invoice.requested',
    payload: { a: 1 },
    ids: fakeIds(),
    clock,
  });
  assert.deepEqual(envelope, {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'billing.invoice.requested',
    traceId: '00000000-0000-4000-8000-000000000001',
    ts: '2026-10-24T03:37:23.197500977Z',
    hop: 0,
    payload: { a: 1 },
  });
  assert.deepEqual(Object.keys(envelope), ['id', 'name', 'traceId', 'ts', 'hop', 'payload']);
});

test('createEnvelope derives a child from its parent run context', () => {
  const parent: RunContext = {
    traceId: 'trace-0000-aaaa',
    eventId: 'parent-id',
    hop: 3,
    piece: 'billing/invoice',
    signal: new AbortController().signal,
    internal: false,
  };
  const envelope = createEnvelope({
    name: '$reply.1f9a2b3c',
    payload: null,
    parent,
    correlationId: 'corr',
    replyTo: '$reply.abcdefgh',
    source: 'billing/invoice',
    ids: fakeIds(),
    clock: fakeClock(),
  });
  assert.deepEqual(Object.keys(envelope), [
    'id',
    'name',
    'traceId',
    'causationId',
    'correlationId',
    'replyTo',
    'ts',
    'hop',
    'source',
    'payload',
  ]);
  assert.equal(envelope.traceId, 'trace-0000-aaaa');
  assert.equal(envelope.causationId, 'parent-id');
  assert.equal(envelope.hop, 4);
  assert.equal(envelope.source, 'billing/invoice');
});

test('serializeEnvelope applies JSON semantics and rejects what JSON cannot carry', () => {
  const envelope = createEnvelope({
    name: 'a.b',
    payload: { fn: () => 1, url: new URL('https://x.test/p'), keep: 1 },
    ids: fakeIds(),
    clock: fakeClock(),
  });
  assert.deepEqual(parseEnvelope(serializeEnvelope(envelope)).payload, { url: 'https://x.test/p', keep: 1 });
  const bigint = createEnvelope({ name: 'a.b', payload: { n: 1n }, ids: fakeIds(), clock: fakeClock() });
  assert.throws(() => serializeEnvelope(bigint), EnvelopeShapeError);
  const missing = { ...envelope, payload: undefined } satisfies Envelope;
  assert.throws(() => serializeEnvelope(missing), EnvelopeShapeError);
});

test('serializeEnvelope drops keys that are not on the wire', () => {
  const envelope = createEnvelope({ name: 'a.b', payload: 1, ids: fakeIds(), clock: fakeClock() });
  const extra = { ...envelope, extra: true };
  assert.deepEqual(Object.keys(JSON.parse(serializeEnvelope(extra)) as object), [
    'id',
    'name',
    'traceId',
    'ts',
    'hop',
    'payload',
  ]);
});

test('envelopeBytes measures UTF-8 bytes', () => {
  assert.equal(envelopeBytes('{"a":"é"}'), 10);
});
