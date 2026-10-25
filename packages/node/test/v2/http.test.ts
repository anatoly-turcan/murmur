import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import { Agent, get as httpGet } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { Sqlite } from '@murmur/node';
import { matchPattern } from 'murmur';

import { GetStreamStats, Tick } from '../fixtures/v2/web/contracts/stream.ts';
import { eventually } from '../helpers.ts';
import {
  ADA,
  bootFailure,
  bootWeb,
  getWithBody,
  JSON_TYPE,
  ROOT,
  sysPayloads,
  type WebApp,
} from './http-helpers.ts';

let app: WebApp;

before(async () => {
  app = await bootWeb({ retry: { maxAttempts: 2, baseMs: 1, maxMs: 5, jitter: 0 } });
});

after(async () => {
  await app[Symbol.asyncDispose]();
});

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

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${app.url}${path}`, init);
}

function textReader(response: Response): ReadableStreamDefaultReader<string> {
  return (response.body ?? new ReadableStream()).pipeThrough(new TextDecoderStream()).getReader();
}

async function streamStats(): Promise<{ clients: number; aborted: number; dropped: number }> {
  return app.runtime.bus.request(GetStreamStats, {});
}

async function readTicksThenAbort(): Promise<string> {
  const before = (await streamStats()).aborted;
  const client = new AbortController();
  const response = await call('/ticks', { headers: ADA, signal: client.signal });
  const text = await readUntil(textReader(response), 'three\n');

  client.abort();
  await eventually(async () => (await streamStats()).aborted === before + 1);

  return text;
}

async function dropUploadMidway(): Promise<void> {
  const { hostname, port } = new URL(app.url);
  const socket = connect(Number(port), hostname);
  await once(socket, 'connect');
  const head = [
    'POST /todos HTTP/1.1',
    `host: ${hostname}`,
    'authorization: Bearer ada',
    'content-length: 100',
  ];

  socket.write(`${head.join('\r\n')}\r\n\r\n{"title":"mi`);
  await delay(50);
  socket.destroy();
  await delay(100);
}

function statusLines(text: string): string[] {
  return text.match(/^HTTP\/1\.1 \d{3}/gm) ?? [];
}

async function readStatusLines(socket: Socket, count: number, signal: AbortSignal): Promise<string[]> {
  let seen = '';

  try {
    for await (const [chunk] of on(socket, 'data', { signal })) {
      seen += String(chunk);

      if (statusLines(seen).length >= count) {
        break;
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  }

  return statusLines(seen);
}

async function oversizedPostThenGetOnOneSocket(): Promise<string[]> {
  const { hostname, port } = new URL(app.url);
  const socket = connect(Number(port), hostname);
  const body = JSON.stringify({ title: 'x'.repeat(1536 * 1024) });
  const post = [
    'POST /todos HTTP/1.1',
    `host: ${hostname}`,
    'authorization: Bearer ada',
    'content-type: application/json',
    `content-length: ${Buffer.byteLength(body)}`,
  ];
  const get = ['GET /nowhere HTTP/1.1', `host: ${hostname}`, 'authorization: Bearer ada'];

  await once(socket, 'connect');
  socket.setEncoding('latin1');
  socket.write(`${post.join('\r\n')}\r\n\r\n${body}${get.join('\r\n')}\r\n\r\n`);

  try {
    return await readStatusLines(socket, 2, AbortSignal.timeout(2_000));
  } finally {
    socket.destroy();
  }
}

async function chunkedUploadStatus(path: string, bytes: number): Promise<string[]> {
  const { hostname, port } = new URL(app.url);
  const socket = connect(Number(port), hostname);
  const head = [
    `POST ${path} HTTP/1.1`,
    `host: ${hostname}`,
    'authorization: Bearer ada',
    'transfer-encoding: chunked',
  ];
  const chunk = 'x'.repeat(64 * 1024);
  socket.on('error', () => {});

  await once(socket, 'connect');
  socket.setEncoding('latin1');
  socket.write(`${head.join('\r\n')}\r\n\r\n`);

  for (let sent = 0; sent < bytes && socket.writable; sent += chunk.length) {
    socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
  }

  try {
    return await readStatusLines(socket, 1, AbortSignal.timeout(2_000));
  } finally {
    socket.destroy();
  }
}

function keepAliveGet(agent: Agent, url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    httpGet(url, { agent }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode ?? 0));
    }).once('error', reject);
  });
}

function bind(port: number): Promise<boolean> {
  const probe = createServer();

  return new Promise((resolve) => {
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function create(title: string): Promise<{ id: string; title: string; done: boolean }> {
  const response = await call('/todos', {
    method: 'POST',
    headers: { ...ADA, ...JSON_TYPE },
    body: JSON.stringify({ title }),
  });

  return (await response.json()) as { id: string; title: string; done: boolean };
}

test('POST /todos answers 201 with location, etag and both trace headers', async () => {
  const response = await call('/todos', {
    method: 'POST',
    headers: { ...ADA, ...JSON_TYPE, 'x-murmur-trace': '0a1b2c3d-0000-4000-8000-000000000001' },
    body: JSON.stringify({ title: 'milk' }),
  });

  const todo = (await response.json()) as { id: string };

  assert.equal(response.status, 201);
  assert.equal(response.headers.get('location'), `/todos/${todo.id}`);
  assert.match(response.headers.get('etag') ?? '', /^"[0-9a-f]{16}"$/);
  assert.equal(response.headers.get('x-murmur-trace'), '0a1b2c3d-0000-4000-8000-000000000001');
  assert.match(
    response.headers.get('traceparent') ?? '',
    /^00-0a1b2c3d000040008000000000000001-[0-9a-f]{16}-01$/,
  );
});

test('GET /todos/:id answers 200 with an etag, 304 for that etag and 404 not_found through req.reply(null)', async () => {
  const todo = await create('bread');
  const first = await call(`/todos/${todo.id}`, { headers: ADA });
  const etag = first.headers.get('etag') ?? '';
  const second = await call(`/todos/${todo.id}`, { headers: { ...ADA, 'if-none-match': etag } });
  const missing = await call('/todos/nope', { headers: ADA });
  const body = (await missing.json()) as { error: { code: string; message: string }; traceId: string };

  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), todo);
  assert.equal(second.status, 304);
  assert.equal(second.headers.get('etag'), etag);
  assert.equal(missing.status, 404);
  assert.deepEqual(body.error, { code: 'not_found', message: 'nothing found at /todos/nope' });
  assert.equal(body.traceId, missing.headers.get('x-murmur-trace'));
});

test('?done=false reaches ListTodos as a boolean through the shorthand', async () => {
  const open = await create('open one');
  const closed = await create('closed one');
  await call(`/todos/${closed.id}/complete`, { method: 'POST', headers: ADA });
  const response = await call('/todos?done=false', { headers: ADA });
  const ids = new Set(((await response.json()) as { id: string }[]).map((todo) => todo.id));

  assert.equal(response.status, 200);
  assert.ok(ids.has(open.id));
  assert.ok(!ids.has(closed.id));
});

test('a GET with a JSON body ignores the body', async () => {
  const closed = await create('done already');
  await call(`/todos/${closed.id}/complete`, { method: 'POST', headers: ADA });

  const response = await getWithBody(
    `${app.url}/todos?done=true`,
    { ...ADA, ...JSON_TYPE },
    '{"done":false}',
  );

  const todos = JSON.parse(response.text) as { done: boolean }[];

  assert.equal(response.status, 200);
  assert.ok(todos.length > 0);
  assert.ok(todos.every((todo) => todo.done));
});

test('a missing bearer answers 401 from a returned Rejection: guard acked, later guards and the edge never ran', async () => {
  const response = await call('/todos/t1');
  const body = (await response.json()) as { error: { code: string; message: string } };
  await eventually(async () => sysPayloads(app.inTrace(response), 'delivery.acked').length === 1);
  const trace = app.inTrace(response);
  const acked = sysPayloads(trace, 'delivery.acked').map((p) => p['name']);

  assert.equal(response.status, 401);
  assert.deepEqual(body.error, { code: 'unauthorized', message: 'missing bearer token' });
  assert.deepEqual(acked, ['auth.Authenticate']);
  assert.equal(trace.filter((e) => e.name === 'auth.RateLimit').length, 0);
  assert.deepEqual(sysPayloads(trace, 'delivery.failed'), []);
  assert.deepEqual(sysPayloads(trace, 'delivery.deadlettered'), []);
  assert.equal(trace.filter((e) => e.name === 'todos.GetTodo').length, 0);
});

test('a guard that throws answers 502 upstream_failed and dead-letters the guard delivery', async () => {
  const response = await call('/admin/whoami', { headers: { ...ROOT, 'x-explode': '1' } });
  const body = (await response.json()) as { error: { code: string; cause?: { message: string } } };
  await eventually(async () => sysPayloads(app.inTrace(response), 'delivery.deadlettered').length === 1);
  const [dead] = sysPayloads(app.inTrace(response), 'delivery.deadlettered');

  assert.equal(response.status, 502);
  assert.equal(body.error.code, 'upstream_failed');
  assert.equal(body.error.cause?.message, 'grant store unavailable');
  assert.equal((dead?.['envelope'] as { name: string } | undefined)?.name, 'grants.RequireAdmin');
  assert.equal(dead?.['piece'], 'grants');
});

test('skip: [Authenticate] runs RateLimit only and the routes row lists it', async () => {
  const response = await call('/stats');
  await eventually(async () => sysPayloads(app.inTrace(response), 'delivery.acked').length >= 2);
  const names = new Set(app.inTrace(response).map((e) => e.name));
  const row = app.runtime.report.catalog.routes?.find((r) => r.key === 'GET /stats');

  assert.equal(response.status, 200);
  assert.ok(names.has('auth.RateLimit'));
  assert.ok(!names.has('auth.Authenticate'));
  assert.deepEqual(row, {
    transport: 'http',
    key: 'GET /stats',
    piece: 'api/rest',
    guards: ['auth.RateLimit'],
  });
});

test('a route guard adds admin to req.auth and refuses without it', async () => {
  const root = await call('/admin/whoami', { headers: ROOT });
  const ada = await call('/admin/whoami', { headers: ADA });
  assert.deepEqual(await root.json(), { userId: 'root', admin: true });
  assert.equal(ada.status, 403);
  assert.equal(((await ada.json()) as { error: { code: string } }).error.code, 'forbidden');
});

test('a fully open route runs no guard and req.auth is undefined', async () => {
  const response = await call('/open');
  assert.deepEqual(await response.json(), { auth: null });
  assert.equal(app.inTrace(response).filter((e) => e.name.startsWith('auth.')).length, 0);
});

test('two pieces on /todos/:id and /todos/:slug fail the boot naming both', async () => {
  const report = await bootFailure('v2/conflict');
  const conflict = report.errors.find((e) => e.code === 'binding-conflict');

  assert.equal(conflict?.phase, 'subscribe');
  assert.equal(conflict?.piece, 'legacy/shadow');
  assert.match(
    conflict?.message ?? '',
    /GET \/todos\/:id \(api\/rest\) overlaps GET \/todos\/:slug \(legacy\/shadow\)/,
  );
});

test('a static route under another piece’s /todos/:id is route-shadowed at boot', async () => {
  const report = await bootFailure('v2/shadow');
  const shadow = report.errors.find((e) => e.code === 'route-shadowed');

  assert.equal(shadow?.piece, 'api/feed');
  assert.match(
    shadow?.message ?? '',
    /GET \/todos\/events \(api\/feed\) sits under GET \/todos\/:id \(api\/rest\)/,
  );
});

test('a guard whose output overlaps another guard’s fails the boot with guard-output-overlap', async () => {
  const report = await bootFailure('v2/overlap');
  const overlap = report.errors.find((e) => e.code === 'guard-output-overlap');

  assert.equal(overlap?.piece, 'bad');
  assert.equal(overlap?.phase, 'load');
  assert.match(overlap?.message ?? '', /Authenticate and Impersonate both put "userId"/);
});

test('shorthand forward: null answers 404 not_found and { status: 204 } sends no body', async () => {
  const todo = await create('to remove');
  const removed = await call(`/todos/${todo.id}`, { method: 'DELETE', headers: ADA });
  const again = await call(`/todos/${todo.id}`, { method: 'DELETE', headers: ADA });

  assert.equal(removed.status, 204);
  assert.equal(await removed.text(), '');
  assert.equal(again.status, 404);
  assert.equal(((await again.json()) as { error: { code: string } }).error.code, 'not_found');
});

test('a ReadableStream response streams three chunks and req.signal fires on client abort', async () => {
  assert.equal(await readTicksThenAbort(), 'one\ntwo\nthree\n');
});

test('enqueue after a cancelled stream does not fail the delivery', async () => {
  await readTicksThenAbort();
  const before = (await streamStats()).dropped;
  await app.runtime.bus.emit(Tick, { n: 1 });
  await eventually(async () => (await streamStats()).dropped > before);
  const failed = sysPayloads(app.tapped, 'delivery.failed').filter((p) => p['name'] === 'stream.Tick');

  assert.deepEqual(failed, []);
});

test('a client that leaves mid-request aborts the entry with ClientDisconnectedError, not a server failure', async () => {
  const client = new AbortController();
  const pending = call('/slow', { headers: ADA, signal: client.signal }).catch(() => undefined);
  const slowEntries = () =>
    sysPayloads(app.tapped, 'ingress.received').filter((p) => p['binding'] === 'GET /slow');
  await eventually(async () => slowEntries().length === 1);
  const traceId = String(slowEntries()[0]?.['traceId']);

  client.abort();
  await pending;

  await eventually(async () =>
    sysPayloads(app.tapped, 'ingress.failed').some((p) => p['traceId'] === traceId),
  );

  const [failure] = sysPayloads(app.tapped, 'ingress.failed').filter((p) => p['traceId'] === traceId);

  assert.equal((failure?.['error'] as { name: string } | undefined)?.name, 'ClientDisconnectedError');
});

test('a client that drops mid-upload logs no error and requests nothing past the guards', async () => {
  const from = app.tapped.length;
  await dropUploadMidway();
  const since = app.tapped.slice(from);

  assert.deepEqual(
    sysPayloads(since, 'log').filter((p) => p['level'] === 'error'),
    [],
  );
  assert.equal(since.filter((e) => e.name === 'todos.CreateTodo').length, 0);
});

test('req.signal fires once the response was sent: HEAD /ticks counts an abort', async () => {
  const before = (await streamStats()).aborted;
  const head = await call('/ticks', { method: 'HEAD', headers: ADA });

  assert.equal(head.status, 200);
  await eventually(async () => (await streamStats()).aborted === before + 1);
});

test('the api/feed edge streams hello, then created after a POST; a gone client fails no delivery', async () => {
  const client = new AbortController();
  const response = await call('/events/todos', { headers: ADA, signal: client.signal });
  const reader = textReader(response);
  const hello = await readUntil(reader, '\n\n');
  await create('fed once');
  const created = await readUntil(reader, 'fed once');

  client.abort();

  const posted = await call('/todos', {
    method: 'POST',
    headers: { ...ADA, ...JSON_TYPE },
    body: JSON.stringify({ title: 'after the client left' }),
  });

  const fedAfter = () =>
    sysPayloads(app.inTrace(posted), 'delivery.acked').filter(
      (p) => p['name'] === 'todos.TodoCreated' && p['piece'] === 'api/feed',
    );
  await eventually(async () => fedAfter().length === 1);
  const failed = sysPayloads(app.tapped, 'delivery.failed').filter((p) => p['name'] === 'todos.TodoCreated');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(hello, 'event: hello\ndata: {"user":"ada"}\n\n');
  assert.match(created, /event: created\ndata: \{.*"title":"fed once"/);
  assert.deepEqual(failed, []);
});

test('stop ends an open SSE stream instead of waiting out the capability stop timeout', async () => {
  const own = await bootWeb();
  const response = await fetch(`${own.url}/events/todos`, { headers: ADA });
  await readUntil(textReader(response), '\n\n');
  const startedAt = performance.now();
  await own[Symbol.asyncDispose]();

  assert.ok(
    performance.now() - startedAt < 1000,
    `stop took ${Math.round(performance.now() - startedAt)} ms`,
  );
});

test('stop frees the port at once while a keep-alive connection is open', async () => {
  const own = await bootWeb();
  const agent = new Agent({ keepAlive: true });

  try {
    assert.equal(await keepAliveGet(agent, `${own.url}/healthz`), 200);
    const startedAt = performance.now();
    await own[Symbol.asyncDispose]();
    const ms = performance.now() - startedAt;

    assert.ok(ms < 1000, `stop waited ${Math.round(ms)} ms on an idle connection`);
    assert.equal(await bind(Number(new URL(own.url).port)), true);
  } finally {
    agent.destroy();
  }
});

test('HEAD mirrors GET without a body; OPTIONS lists the served methods', async () => {
  const todo = await create('head');
  const get = await call(`/todos/${todo.id}`, { headers: ADA });
  const head = await call(`/todos/${todo.id}`, { method: 'HEAD', headers: ADA });
  const options = await call(`/todos/${todo.id}`, { method: 'OPTIONS' });

  assert.equal(head.status, 200);
  assert.equal(head.headers.get('etag'), get.headers.get('etag'));
  assert.equal(await head.text(), '');
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('allow'), 'DELETE, GET, HEAD, OPTIONS');
});

test('a body over maxBodyBytes answers 413 payload_too_large; a raw binding has no limit', async () => {
  const big = JSON.stringify({ title: 'x'.repeat(1024 * 1024) });
  const tooLarge = await call('/todos', { method: 'POST', headers: { ...ADA, ...JSON_TYPE }, body: big });
  const upload = await call('/uploads/photos', { method: 'POST', headers: ADA, body: big });

  assert.equal(tooLarge.status, 413);
  assert.equal(((await tooLarge.json()) as { error: { code: string } }).error.code, 'payload_too_large');
  assert.equal(upload.status, 201);
  assert.deepEqual(await upload.json(), { bucket: 'photos', bytes: Buffer.byteLength(big) });
});

test('req.raw on a JSON route read before the body keeps the maxBodyBytes limit for a chunked upload', async () => {
  assert.deepEqual(await chunkedUploadStatus('/sizes', 5 * 256 * 1024), ['HTTP/1.1 413']);
});

test('an unknown path answers 404 and a wrong method 405, both with the error envelope', async () => {
  const unknown = await call('/nowhere', { headers: ADA });
  const wrong = await call('/stats', { method: 'PUT', headers: ADA });

  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, 'not_found');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'GET, HEAD, OPTIONS');
});

test('an unread request body is drained: 413 then 404 answer on one keep-alive socket', async () => {
  assert.deepEqual(await oversizedPostThenGetOnOneSocket(), ['HTTP/1.1 413', 'HTTP/1.1 404']);
});

test('the tap carries each $ingress.http entry after its $sys.ingress.received record', async () => {
  const response = await call('/todos', { headers: ADA });
  const names = app.inTrace(response).map((e) => e.name);
  const entry = app.inTrace(response).find((e) => matchPattern('$ingress.*', e.name));

  assert.equal(response.status, 200);
  assert.ok(names.indexOf('$ingress.http') > names.indexOf('$sys.ingress.received'));
  assert.deepEqual(entry?.payload, { method: 'GET', path: '/todos', binding: 'GET /todos' });
  assert.equal(entry?.source, 'external:http');
});

test('a domain handler that throws behind POST /todos answers 502 with cause in dev, retries under the request', async () => {
  await using broken = await bootWeb({ retry: { maxAttempts: 3, baseMs: 1, maxMs: 5, jitter: 0 } });
  const db = broken.runtime.capabilities.get('sqlite') as Sqlite;
  await db.exec('DROP TABLE todos');

  const response = await fetch(`${broken.url}/todos`, {
    method: 'POST',
    headers: { ...ADA, ...JSON_TYPE },
    body: JSON.stringify({ title: 'never stored' }),
  });

  const body = (await response.json()) as {
    error: { code: string; message: string; cause?: { message: string } };
  };

  const failed = sysPayloads(broken.inTrace(response), 'delivery.failed').filter(
    (p) => p['name'] === 'todos.CreateTodo',
  );

  assert.equal(response.status, 502);
  assert.equal(body.error.code, 'upstream_failed');
  assert.equal(body.error.message, 'todos.CreateTodo failed');
  assert.match(body.error.cause?.message ?? '', /no such table: todos/);
  assert.deepEqual(
    failed.map((p) => p['attempt']),
    [1, 2, 3],
  );
});
