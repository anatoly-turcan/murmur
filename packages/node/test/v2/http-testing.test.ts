import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { http } from '@murmur/node/capabilities';
import { createTestRuntime, fakeSqlite, testPiece } from '@murmur/node/testing';

import { Archive } from '../fixtures/v2/routes/archive.ts';
import web from '../fixtures/v2/web/capabilities/web/capability.ts';
import { Authenticate } from '../fixtures/v2/web/contracts/auth.ts';
import { Impersonate, RequireAdmin } from '../fixtures/v2/web/contracts/grants.ts';
import { GetStreamStats } from '../fixtures/v2/web/contracts/stream.ts';
import { CreateTodo, GetTodo, RemoveTodo } from '../fixtures/v2/web/contracts/todos.ts';
import { Extra } from '../fixtures/v2/web/pieces/api/extra/piece.ts';
import { TodosFeed } from '../fixtures/v2/web/pieces/api/feed/piece.ts';
import { RestApi } from '../fixtures/v2/web/pieces/api/rest/piece.ts';
import { Auth } from '../fixtures/v2/web/pieces/auth/piece.ts';
import { Todos } from '../fixtures/v2/web/pieces/todos/piece.ts';

const ada = { userId: 'ada', roles: [], remaining: 9 };

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly issues?: unknown };
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

const SCHEMA = readFileSync(new URL('../fixtures/v2/web/pieces/todos/schema.sql', import.meta.url), 'utf8');

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
  assert.deepEqual((await errorOf(missing)).code, 'not_found');
});

test('POST /todos with an invalid body answers 400 and asks the domain nothing', async () => {
  await using t = await testPiece(RestApi, { auth: ada });
  t.respond(CreateTodo, (input) => ({ id: 't1', title: input.title, done: false }));
  const headers = { 'content-type': 'application/json' };
  const response = await t.fetch(new Request('http://app/todos', { method: 'POST', body: '{}', headers }));
  const error = await errorOf(response);

  assert.equal(response.status, 400);
  assert.equal(error.code, 'invalid_input');
  assert.deepEqual(error.issues, [
    {
      path: ['title'],
      code: 'invalid_type',
      expected: 'string',
      message: 'expected string, received undefined',
    },
  ]);
  assert.equal(error.message, 'title: expected string, received undefined');
  assert.equal(t.requested(CreateTodo).length, 0);
});

test('t.fetch runs no guards, takes auth per call and logs through the piece', async () => {
  await using t = await testPiece(RestApi, { auth: ada });
  t.respond(CreateTodo, (input) => ({ id: 't9', title: input.title, done: false }));
  const headers = { 'content-type': 'application/json' };
  const body = JSON.stringify({ title: 'tea' });

  const response = await t.fetch(new Request('http://app/todos', { method: 'POST', body, headers }), {
    auth: { ...ada, userId: 'grace' },
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get('location'), '/todos/t9');
  assert.deepEqual(t.requested(CreateTodo), [{ title: 'tea' }]);
  assert.deepEqual(t.log.records.find((r) => r.message === 'todo created')?.data, { id: 't9', by: 'grace' });
});

test('the match rule: a static segment beats a :param in the same piece; a /*rest takes the remainder', async () => {
  await using t = await testPiece(Archive, { auth: ada });
  const archive = await t.fetch(new Request('http://app/todos/archive'));
  const show = await t.fetch(new Request('http://app/todos/t1'));
  const file = await t.fetch(new Request('http://app/files/a/b%20c.txt'));
  assert.deepEqual(await archive.json(), { route: 'archive' });
  assert.deepEqual(await show.json(), { route: 'show', id: 't1' });
  assert.deepEqual(await file.json(), { route: 'file', rest: 'a/b c.txt' });
});

test('createTestRuntime.fetch runs the full adapter with guards against class pieces', async () => {
  const db = await fakeSqlite();
  await db.exec(SCHEMA);

  await using rt = await createTestRuntime({
    pieces: { auth: Auth, todos: Todos, 'api/rest': RestApi, 'api/feed': TodosFeed },
    capabilities: { sqlite: db },
    config: { auth: { tokens: { ada: 'ada' }, perMinute: 100 } },
  });

  const anonymous = await rt.fetch(new Request('http://app/todos'));
  const headers = { authorization: 'Bearer ada', 'content-type': 'application/json' };

  const created = await rt.fetch(
    new Request('http://app/todos', { method: 'POST', headers, body: '{"title":"milk"}' }),
  );

  const todo = (await created.json()) as { id: string };
  await rt.idle();

  assert.equal(anonymous.status, 401);
  assert.equal(created.status, 201);
  assert.deepEqual(await rt.request(GetTodo, { id: todo.id }), todo);
  assert.equal(rt.events('auth.Authenticate').length, 2);
  assert.equal(rt.events('$ingress.http').length, 2);
});

async function webRuntime(perMinute = 100) {
  const db = await fakeSqlite();
  await db.exec(SCHEMA);

  return createTestRuntime({
    pieces: { auth: Auth, todos: Todos, 'api/rest': RestApi },
    capabilities: { sqlite: db },
    config: { auth: { tokens: { ada: 'ada' }, perMinute } },
  });
}

test('guards run one at a time in declaration order and the first refusal stops the chain', async () => {
  await using rt = await webRuntime(1);
  const response = await rt.fetch(new Request('http://app/todos'));

  const allowed = await rt.fetch(
    new Request('http://app/todos', { headers: { authorization: 'Bearer ada' } }),
  );

  const limited = await rt.fetch(
    new Request('http://app/todos', { headers: { authorization: 'Bearer ada' } }),
  );

  assert.equal(response.status, 401);
  assert.equal((await errorOf(response)).code, 'unauthorized');
  assert.equal(allowed.status, 200);
  assert.equal(limited.status, 429);
  assert.equal(rt.events('auth.Authenticate').length, 3);
  assert.equal(rt.events('auth.RateLimit').length, 2);
});

test('a client that leaves mid-request gets a bodiless 499 and no error log', async () => {
  await using rt = await webRuntime();
  const client = new AbortController();
  const pending = rt.fetch(
    new Request('http://app/todos', { headers: { authorization: 'Bearer ada' }, signal: client.signal }),
  );
  client.abort();
  const response = await pending;

  assert.equal(response.status, 499);
  assert.equal(await response.text(), '');
  assert.deepEqual(
    rt.log.records.filter((record) => record.level === 'error'),
    [],
  );
});

function stalledUpload(client: AbortController): Request {
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode('{"title":'));
      client.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
    },
  });
  const headers = { authorization: 'Bearer ada', 'content-type': 'application/json' };

  return new Request('http://app/todos', {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
    signal: client.signal,
  });
}

test('a client that leaves mid-upload gets a bodiless 499 and no error log', async () => {
  await using rt = await webRuntime();
  const client = new AbortController();
  const pending = rt.fetch(stalledUpload(client));
  client.abort();
  const response = await pending;

  assert.equal(response.status, 499);
  assert.deepEqual(
    rt.log.records.filter((record) => record.level === 'error'),
    [],
  );
});

test('t.fetch aborts req.signal once the response was sent: after HEAD, and after a read stream is cancelled', async () => {
  await using t = await testPiece(Extra, { auth: ada });
  const abortedNow = async () => (await t.deliver(GetStreamStats, {})).aborted;
  await t.fetch(new Request('http://app/ticks', { method: 'HEAD' }));
  const afterHead = await abortedNow();
  const response = await t.fetch(new Request('http://app/ticks'));
  const reader = (response.body ?? new ReadableStream()).getReader();
  await reader.read();
  await reader.cancel();

  assert.equal(afterHead, 1);
  assert.equal(await abortedNow(), 2);
});

test('HEAD /healthz answers like GET /healthz without a body', async () => {
  await using rt = await webRuntime();
  const head = await rt.fetch(new Request('http://app/healthz', { method: 'HEAD' }));

  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('createTestRuntime refuses pieces whose routes conflict', async () => {
  await assert.rejects(
    createTestRuntime({ pieces: { 'api/rest': RestApi, archive: Archive } }),
    /GET \/todos\/:id is served by both api\/rest and archive/,
  );
});

test('route makers check guards, paths and guard output overlap when called', () => {
  assert.throws(() => web.get('/whoami', { guards: [Impersonate] }), {
    code: 'guard-output-overlap',
    message: /Authenticate and Impersonate both put "userId" on req.auth \(GET \/whoami\)/,
  });
  assert.throws(() => web.get('todos'), /must start with \//);
  assert.throws(() => web.get('/files/*rest'), /wildcard is allowed only last, on web.raw/);
  assert.doesNotThrow(() => web.get('/whoami', { skip: [Authenticate], guards: [Impersonate] }));
  assert.throws(() => web.get('/stray', { skip: [RequireAdmin as never] }), {
    message: 'route GET /stray: skip names RequireAdmin, which is not a default guard of this token',
  });
  assert.throws(() => http({ guards: [CreateTodo as never] }), /takes Guard classes/);
});
