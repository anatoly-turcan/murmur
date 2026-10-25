import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testPiece } from '@murmur/node/testing';

import { CreateTodo, GetTodo, RemoveTodo } from '#contracts/todos';

import { RestApi } from './piece.ts';

const ada = { userId: 'ada', roles: [], remaining: 9 };

interface ErrorBody {
  readonly error: { readonly code: string };
}

test('GET /todos/:id answers 200 with an etag, then 304 for the same etag', async () => {
  await using t = await testPiece(RestApi, { auth: ada });
  t.respond(GetTodo, (input) => ({ id: input.id, title: 'milk', done: false }));
  const first = await t.fetch(new Request('http://app/todos/t1'));
  const etag = first.headers.get('etag') ?? '';
  const second = await t.fetch(new Request('http://app/todos/t1', { headers: { 'if-none-match': etag } }));

  assert.equal(first.status, 200);
  assert.match(etag, /^"[0-9a-f]{16}"$/);
  assert.equal(second.status, 304);
});

test('DELETE /todos/:id answers 204 when removed and 404 otherwise', async () => {
  await using t = await testPiece(RestApi, { auth: ada });
  t.respond(RemoveTodo, (input) => (input.id === 't1' ? { id: 't1', title: 'milk', done: false } : null));
  const removed = await t.fetch(new Request('http://app/todos/t1', { method: 'DELETE' }));
  const missing = await t.fetch(new Request('http://app/todos/t2', { method: 'DELETE' }));

  assert.equal(removed.status, 204);
  assert.equal(missing.status, 404);
  assert.deepEqual(((await missing.json()) as ErrorBody).error.code, 'not_found');
});

test('POST /todos with an invalid body answers 422 and asks the domain nothing', async () => {
  await using t = await testPiece(RestApi, { auth: ada });
  t.respond(CreateTodo, (input) => ({ id: 't1', title: input.title, done: false }));
  const headers = { 'content-type': 'application/json' };
  const response = await t.fetch(new Request('http://app/todos', { method: 'POST', body: '{}', headers }));
  const body = (await response.json()) as ErrorBody;

  assert.equal(response.status, 422);
  assert.equal(body.error.code, 'validation_failed');
  assert.equal(t.requested(CreateTodo).length, 0);
});
