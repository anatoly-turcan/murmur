import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import { createTestApp, type TestApp } from '@murmur/node/testing';
import type { Envelope } from 'murmur';

const ADA = { authorization: 'Bearer ada' };
const JSON_BODY = { 'content-type': 'application/json' };
const PER_MINUTE = 60;

interface Todo {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

interface TodoPage {
  readonly data: readonly Todo[];
  readonly next_cursor: string | null;
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly issues?: unknown[] };
  readonly traceId: string;
}

async function waitUntil<T>(
  what: string | (() => string),
  probe: () => Promise<T | undefined> | T | undefined,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await probe();

  while (value === undefined) {
    if (Date.now() > deadline) {
      throw new Error(`${typeof what === 'string' ? what : what()} (waited ${ms} ms)`);
    }

    await sleep(25);
    value = await probe();
  }

  return value;
}

function postJson(base: string, path: string, body: unknown, headers = ADA): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...headers, ...JSON_BODY },
    body: JSON.stringify(body),
  });
}

async function createTodo(base: string, title: string): Promise<Todo> {
  const response = await postJson(base, '/todos', { title });

  assert.equal(response.status, 201);

  return (await response.json()) as Todo;
}

async function errorOf(response: Response): Promise<ErrorBody> {
  return (await response.json()) as ErrorBody;
}

function textReader(response: Response): ReadableStreamDefaultReader<string> {
  return (response.body ?? new ReadableStream()).pipeThrough(new TextDecoderStream()).getReader();
}

async function readUntil(
  reader: ReadableStreamDefaultReader<string>,
  marker: string,
  seen = '',
): Promise<string> {
  if (seen.includes(marker)) {
    return seen;
  }

  const { value, done } = await reader.read();
  if (done) {
    return seen;
  }

  return readUntil(reader, marker, seen + value);
}

function sysOf(tapped: readonly Envelope[], name: string, piece: string): Envelope[] {
  return tapped.filter((e) => e.name === `$sys.${name}` && (e.payload as { piece?: string }).piece === piece);
}

interface Stats {
  readonly total: number;
  readonly done: number;
}

async function listedStats(base: string): Promise<Stats> {
  const { data } = (await (await fetch(`${base}/todos?limit=100`, { headers: ADA })).json()) as TodoPage;

  return { total: data.length, done: data.filter((todo) => todo.done).length };
}

async function statsReach(base: string, expected: Stats): Promise<Stats> {
  let last = 'nothing yet';

  return waitUntil(
    () => `GET /stats never answered 200 ${JSON.stringify(expected)}; last ${last}`,
    async () => {
      const response = await fetch(`${base}/stats`);
      const body = (await response.json()) as Stats;
      last = `${response.status} ${JSON.stringify(body)}`;

      return response.status === 200 && isDeepStrictEqual(body, expected) ? body : undefined;
    },
  );
}

async function hitStats(base: string, times: number): Promise<number[]> {
  const responses = await Promise.all(Array.from({ length: times }, () => fetch(`${base}/stats`)));
  await Promise.all(responses.map((response) => response.body?.cancel()));

  return responses.map((response) => response.status);
}
test('todo-api over HTTP: every route of the api preview', { timeout: 60_000 }, async (t) => {
  const tapped: Envelope[] = [];
  const app: TestApp = await createTestApp({ tap: (envelope) => tapped.push(envelope) });
  t.after(() => app.stop());
  const base = app.url;
  const milk = await createTodo(base, 'milk');

  await t.test('POST /todos answers 201 with location, etag and the trace headers', async () => {
    const response = await postJson(base, '/todos', { title: 'buy bread' });
    const todo = (await response.json()) as Todo;

    assert.equal(response.status, 201);
    assert.deepEqual(todo, { id: todo.id, title: 'buy bread', done: false });
    assert.equal(response.headers.get('location'), `/todos/${todo.id}`);
    assert.match(response.headers.get('etag') ?? '', /^"[0-9a-f]{16}"$/);
    assert.match(response.headers.get('x-murmur-trace') ?? '', /^[0-9a-f-]{8,64}$/);
    assert.match(response.headers.get('traceparent') ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  await t.test('POST /todos with an invalid body answers 400 invalid_input with issues', async () => {
    const response = await postJson(base, '/todos', {});
    const body = await errorOf(response);

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'invalid_input');
    assert.ok((body.error.issues ?? []).length > 0);
    assert.equal(body.traceId, response.headers.get('x-murmur-trace'));
  });

  await t.test('GET /todos/:id answers 200 with an etag, then 304 for the same etag', async () => {
    const first = await fetch(`${base}/todos/${milk.id}`, { headers: ADA });
    const etag = first.headers.get('etag') ?? '';
    const second = await fetch(`${base}/todos/${milk.id}`, { headers: { ...ADA, 'if-none-match': etag } });

    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), milk);
    assert.match(etag, /^"[0-9a-f]{16}"$/);
    assert.equal(second.status, 304);
    assert.equal(second.headers.get('etag'), etag);
    assert.equal(await second.text(), '');
  });

  await t.test(
    'GET /todos/:id of an unknown id answers 404 not_found with the id in the message',
    async () => {
      const response = await fetch(`${base}/todos/nope`, { headers: ADA });
      const body = await errorOf(response);

      assert.equal(response.status, 404);
      assert.deepEqual(body.error, { code: 'not_found', message: 'nothing found at /todos/nope' });
      assert.equal(body.traceId, response.headers.get('x-murmur-trace'));
    },
  );

  await t.test('POST /todos/:id/complete answers the done todo; GET /todos?done= filters on it', async () => {
    const walk = await createTodo(base, 'walk dog');
    const completed = await postJson(base, `/todos/${walk.id}/complete`, {});
    const open = await fetch(`${base}/todos?done=false`, { headers: ADA });
    const done = await fetch(`${base}/todos?done=true`, { headers: ADA });
    const all = await fetch(`${base}/todos`, { headers: ADA });

    assert.equal(completed.status, 200);
    assert.deepEqual(await completed.json(), { ...walk, done: true });
    assert.equal(open.status, 200);
    assert.ok(((await open.json()) as TodoPage).data.every((todo) => !todo.done));
    assert.deepEqual(await done.json(), { data: [{ ...walk, done: true }], next_cursor: null });
    assert.equal(((await all.json()) as TodoPage).data.length, 3);
  });

  await t.test(
    'GET /todos pages by ?limit= and next_cursor; a tampered cursor answers 400 invalid_cursor',
    async () => {
      const first = (await (await fetch(`${base}/todos?limit=2`, { headers: ADA })).json()) as TodoPage;
      const rest = await fetch(`${base}/todos?limit=2&cursor=${first.next_cursor ?? ''}`, { headers: ADA });

      const tampered = await fetch(`${base}/todos?cursor=x${(first.next_cursor ?? '').slice(1)}`, {
        headers: ADA,
      });

      assert.equal(first.data.length, 2);
      assert.deepEqual(((await rest.json()) as TodoPage).data.length, 1);
      assert.equal(tampered.status, 400);
      assert.equal((await errorOf(tampered)).error.code, 'invalid_cursor');
    },
  );

  await t.test('POST /todos/:id/complete of an unknown id answers 404 not_found', async () => {
    const response = await postJson(base, '/todos/nope/complete', {});

    assert.equal(response.status, 404);
    assert.equal((await errorOf(response)).error.code, 'not_found');
  });

  await t.test('DELETE /todos/:id answers 204 with no body, then 404 not_found', async () => {
    const doomed = await createTodo(base, 'doomed');
    const removed = await fetch(`${base}/todos/${doomed.id}`, { method: 'DELETE', headers: ADA });
    const again = await fetch(`${base}/todos/${doomed.id}`, { method: 'DELETE', headers: ADA });

    assert.equal(removed.status, 204);
    assert.equal(await removed.text(), '');
    assert.equal(again.status, 404);
    assert.equal((await errorOf(again)).error.code, 'not_found');
  });

  await t.test(
    'POST /todos with an Idempotency-Key replays the first answer; another body answers 422',
    async () => {
      const keyed = { ...ADA, 'idempotency-key': 'e2e-jam' };
      const first = await postJson(base, '/todos', { title: 'jam' }, keyed);
      const todo = (await first.json()) as Todo;
      const replay = await postJson(base, '/todos', { title: 'jam' }, keyed);
      const reused = await postJson(base, '/todos', { title: 'tea' }, keyed);

      assert.equal(first.status, 201);
      assert.equal(replay.status, 201);
      assert.equal(replay.headers.get('idempotent-replayed'), 'true');
      assert.deepEqual(await replay.json(), todo);
      assert.equal(replay.headers.get('location'), `/todos/${todo.id}`);
      assert.notEqual(replay.headers.get('x-murmur-trace'), first.headers.get('x-murmur-trace'));
      assert.equal(reused.status, 422);
      assert.equal((await errorOf(reused)).error.code, 'invalid_input');
    },
  );

  await t.test('a request without a token, or with an unknown one, answers 401 unauthorized', async () => {
    const missing = await fetch(`${base}/todos/${milk.id}`);
    const unknown = await fetch(`${base}/todos`, { headers: { authorization: 'Bearer eve' } });
    const body = await errorOf(missing);

    assert.equal(missing.status, 401);
    assert.deepEqual(body.error, { code: 'unauthorized', message: 'missing bearer token' });
    assert.equal(body.traceId, missing.headers.get('x-murmur-trace'));
    assert.equal(unknown.status, 401);
    assert.equal((await errorOf(unknown)).error.message, 'unknown token');
  });

  await t.test('GET /stats answers without a token and counts the todos', async () => {
    const before = await statsReach(base, await listedStats(base));
    const counted = await createTodo(base, 'count me');
    const completed = await postJson(base, `/todos/${counted.id}/complete`, {});
    const after = await statsReach(base, { total: before.total + 1, done: before.done + 1 });

    assert.equal(completed.status, 200);
    assert.deepEqual(after, { total: before.total + 1, done: before.done + 1 });
  });

  await t.test(
    'GET /stats is rate limited by IP without a token: perMinute calls answer 200, the next 429',
    async () => {
      await app.reset();
      await app.clock.freeze('2030-01-01T12:00:15Z');
      const statuses = await hitStats(base, PER_MINUTE);
      const limited = await fetch(`${base}/stats`);
      const body = await errorOf(limited);
      await app.clock.clear();

      assert.deepEqual(
        statuses,
        Array.from({ length: PER_MINUTE }, () => 200),
      );
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after'), '45');
      assert.deepEqual(body.error, {
        code: 'rate_limited',
        message: 'rate limit exceeded',
        details: { perMinute: PER_MINUTE },
      });
    },
  );

  await t.test(
    'GET /events/todos streams created after a POST; a disconnect leaves no dead letter',
    async () => {
      const client = new AbortController();
      const stream = await fetch(`${base}/events/todos`, { headers: ADA, signal: client.signal });
      const reader = textReader(stream);
      const hello = await readUntil(reader, '\n\n');

      await waitUntil('the stream ingress entry completed while the client is connected', () =>
        sysOf(tapped, 'ingress.completed', 'api/feed').length > 0 ? true : undefined,
      );

      const fresh = await createTodo(base, 'stream me');
      const frames = await readUntil(reader, fresh.id);
      const ackedBefore = sysOf(tapped, 'delivery.acked', 'api/feed').length;

      client.abort();
      await createTodo(base, 'after the client left');

      await waitUntil('api/feed acked the event sent after the client left', () =>
        sysOf(tapped, 'delivery.acked', 'api/feed').length > ackedBefore ? true : undefined,
      );

      assert.equal(stream.headers.get('content-type'), 'text/event-stream');
      assert.equal(hello, 'event: hello\ndata: {"user":"ada"}\n\n');
      assert.match(frames, new RegExp(`event: created\ndata: \\{"id":"${fresh.id}","title":"stream me"\\}`));
      assert.deepEqual(sysOf(tapped, 'delivery.failed', 'api/feed'), []);
      assert.deepEqual(sysOf(tapped, 'delivery.deadlettered', 'api/feed'), []);
    },
  );

  await t.test('POST /todos runs the NotifyTodo job: the notifier records the todo once', async () => {
    const todo = await createTodo(base, 'notify me');

    const row = await waitUntil('app.jobs.drain() ran the NotifyTodo job', async () => {
      await app.jobs.drain();

      return app.db.get<{ title: string }>('SELECT title FROM notifications WHERE todo_id = ?', todo.id);
    });

    const succeeded = sysOf(tapped, 'job.succeeded', 'notifier').map(
      (e) => (e.payload as { contract: string }).contract,
    );

    assert.deepEqual(row, { title: 'notify me' });
    assert.ok(succeeded.includes('notifications.NotifyTodo'), JSON.stringify(succeeded));
  });

  await t.test('GET /events/todos without a token answers 401', async () => {
    const response = await fetch(`${base}/events/todos`);

    assert.equal(response.status, 401);
    assert.equal((await errorOf(response)).error.code, 'unauthorized');
  });
});
