import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Envelope } from 'murmur';

import { applyPayloadPolicy } from '../src/dev/payload.ts';

function envelope(name: string, payload: unknown): Envelope {
  return { id: 'id-1', name, traceId: 't-1', ts: '2026-10-24T00:00:00Z', hop: 0, payload };
}

const big = { text: 'x'.repeat(100) };
const cap = { redact: false, capBytes: 32 };

test('a user payload under the cap passes through unchanged', () => {
  const small = envelope('todos.created', { id: 1 });

  assert.deepEqual(applyPayloadPolicy(small, cap).payload, { id: 1 });
});

test('--payload-cap truncates a user payload with a byte-sliced preview', () => {
  const payload = applyPayloadPolicy(envelope('todos.created', big), cap).payload as Record<string, unknown>;

  assert.equal(payload['$truncated'], true);
  assert.equal(payload['bytes'], Buffer.byteLength(JSON.stringify(big)));
  assert.equal(payload['preview'], JSON.stringify(big).slice(0, 32));
});

test('the preview never exceeds the cap in bytes for multi-byte text', () => {
  const payload = applyPayloadPolicy(envelope('todos.created', { text: 'é'.repeat(50) }), cap).payload as {
    preview: string;
  };

  assert.ok(Buffer.byteLength(payload.preview) <= 32, payload.preview);
  assert.ok(!payload.preview.includes('�'));
});

test('--redact replaces user and nested envelope payloads', () => {
  const policy = { redact: true, capBytes: 1024 };
  const user = applyPayloadPolicy(envelope('todos.created', { id: 1 }), policy);
  const dead = applyPayloadPolicy(
    envelope('$sys.delivery.deadlettered', { piece: 'a', envelope: envelope('todos.created', { id: 1 }) }),
    policy,
  );

  assert.deepEqual(user.payload, { $redacted: true, bytes: 8 });
  assert.deepEqual((dead.payload as { envelope: Envelope }).envelope.payload, { $redacted: true, bytes: 8 });
  assert.equal((dead.payload as { piece: string }).piece, 'a');
});

test('--payload-cap truncates nested envelopes and $sys.log fields', () => {
  const dead = applyPayloadPolicy(
    envelope('$sys.delivery.deadlettered', { envelope: envelope('todos.created', big) }),
    cap,
  );
  const log = applyPayloadPolicy(envelope('$sys.log', { level: 'info', msg: 'hi', fields: big }), cap);

  assert.equal(
    ((dead.payload as { envelope: Envelope }).envelope.payload as { $truncated: boolean }).$truncated,
    true,
  );
  assert.equal((log.payload as { fields: { $truncated: boolean } }).fields.$truncated, true);
  assert.equal((log.payload as { msg: string }).msg, 'hi');
});

test('--redact replaces $sys.log fields', () => {
  const log = applyPayloadPolicy(envelope('$sys.log', { level: 'info', msg: 'hi', fields: { id: 1 } }), {
    redact: true,
    capBytes: 1024,
  });

  assert.deepEqual((log.payload as { fields: unknown }).fields, { $redacted: true, bytes: 8 });
});

test('a $sys envelope without nested data is returned as is', () => {
  const started = envelope('$sys.piece.started', { piece: 'a' });

  assert.equal(applyPayloadPolicy(started, cap), started);
});
