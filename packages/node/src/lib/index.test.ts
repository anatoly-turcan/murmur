import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bearer, canonicalJson, cursor, sha256 } from '@murmur/node/lib';
import { isRejection } from 'murmur';
import { z } from 'zod';

const Keyed = z.object({ createdAt: z.string(), id: z.string() });
const Pair = z.tuple([z.string(), z.string()]);

test('bearer reads the token of a Bearer authorization header', () => {
  assert.equal(bearer('Bearer abc'), 'abc');
  assert.equal(bearer('bearer  abc '), 'abc');
  assert.equal(bearer('Basic abc'), null);
  assert.equal(bearer('Bearer'), null);
  assert.equal(bearer(undefined), null);
  assert.equal(bearer(null), null);
});

test('canonicalJson sorts keys at every depth and drops undefined fields', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } }),
    '{"a":{"d":[{"y":2,"z":1}]},"b":1}',
  );
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

test('sha256 is the hex digest of text or bytes', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(new TextEncoder().encode('abc')), sha256('abc'));
});

test('cursor round-trips a position bound to its binding', () => {
  const raw = cursor.encode('todos.ListTodos:done=false', { createdAt: '2026-10-25T10:00:00Z', id: 't1' });

  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(cursor.decode('todos.ListTodos:done=false', raw, Keyed), {
    createdAt: '2026-10-25T10:00:00Z',
    id: 't1',
  });
  assert.equal(cursor.decode('todos.ListTodos:done=false', null, Keyed), null);
});

test('cursor carries a Date or Temporal.Instant position as its JSON string', () => {
  const instant = Temporal.Instant.from('2026-10-25T10:00:00Z');
  const At = z.object({ at: z.string() });

  assert.deepEqual(cursor.decode('b', cursor.encode('b', { at: new Date(0) }), At), {
    at: '1970-01-01T00:00:00.000Z',
  });
  assert.deepEqual(cursor.decode('b', cursor.encode('b', [instant, 'x']), Pair), [
    '2026-10-25T10:00:00Z',
    'x',
  ]);
});

test('a tampered, foreign, garbled or wrongly shaped cursor decodes to a 400 invalid_cursor Rejection', () => {
  const raw = cursor.encode('todos.ListTodos', ['2026-10-25', 't1']);
  const json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { p: unknown; c: string };
  const tampered = Buffer.from(JSON.stringify({ ...json, p: ['2026-10-25', 't9'] })).toString('base64url');

  for (const refused of [
    cursor.decode('todos.ListTodos', tampered, Pair),
    cursor.decode('todos.ListTodos:done=true', raw, Pair),
    cursor.decode('todos.ListTodos', 'not a cursor', Pair),
    cursor.decode('todos.ListTodos', '', Pair),
    cursor.decode('todos.ListTodos', cursor.encode('todos.ListTodos', { a: 1 }), Pair),
    cursor.decode('todos.ListTodos', cursor.encode('todos.ListTodos', ['a', 'b', 'c']), Pair),
  ]) {
    assert.equal(isRejection(refused), true);
    assert.deepEqual(refused, {
      status: 400,
      code: 'invalid_cursor',
      message: 'cursor is not one this list issued; start again without a cursor',
    });
  }
});
