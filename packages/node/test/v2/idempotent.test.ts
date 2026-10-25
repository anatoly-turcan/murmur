import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRuntime, type Runtime } from '@murmur/node';
import { http, type HttpServer, type Sqlite } from '@murmur/node/capabilities';
import { createTestRuntime, type TestRuntime } from '@murmur/node/testing';
import { Guard, Model, MurmurError } from 'murmur';
import { z } from 'zod';

import { gate } from '../fixtures/v2/idempotent/pieces/api/gate.ts';
import { Orders } from '../fixtures/v2/idempotent/pieces/api/piece.ts';
import { Auth } from '../fixtures/v2/idempotent/pieces/auth/piece.ts';
import { fixture } from '../helpers.ts';

const ADA = { authorization: 'Bearer ada' };
const JSON_TYPE = { 'content-type': 'application/json' };

interface Order {
  readonly item: string;
  readonly seq: number;
}

function ordersRuntime(): Promise<TestRuntime> {
  return createTestRuntime({ pieces: { api: Orders, auth: Auth } });
}

function order(body: unknown, key?: string, headers: Record<string, string> = ADA): Request {
  return new Request('http://app/orders', {
    method: 'POST',
    headers: { ...headers, ...JSON_TYPE, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

test('same key and body replays the stored status, headers and body, with fresh responseHeaders', async () => {
  await using rt = await ordersRuntime();
  const first = await rt.fetch(order({ item: 'milk' }, 'k1'));
  const firstBody = (await first.json()) as Order;
  const second = await rt.fetch(order({ item: 'milk' }, 'k1'));

  assert.equal(first.status, 201);
  assert.equal(first.headers.get('idempotent-replayed'), null);
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(await second.json(), firstBody);
  assert.equal(second.headers.get('location'), first.headers.get('location'));
  assert.equal(second.headers.get('content-type'), first.headers.get('content-type'));
  assert.notEqual(second.headers.get('x-served'), first.headers.get('x-served'));
  assert.notEqual(second.headers.get('x-murmur-trace'), first.headers.get('x-murmur-trace'));
  assert.ok(second.headers.get('x-murmur-trace'));
});

test('the same key with another body answers the configured reused mapping', async () => {
  await using rt = await ordersRuntime();
  await rt.fetch(order({ item: 'milk' }, 'k2'));
  const reused = await rt.fetch(order({ item: 'bread' }, 'k2'));

  assert.equal(reused.status, 422);
  assert.equal(await errorCode(reused), 'key_reused');
});

test('a key is scoped: another user may use the same key', async () => {
  await using rt = await ordersRuntime();
  await rt.fetch(order({ item: 'milk' }, 'shared'));
  const other = await rt.fetch(order({ item: 'bread' }, 'shared', { authorization: 'Bearer bob' }));

  assert.equal(other.status, 201);
  assert.equal(other.headers.get('idempotent-replayed'), null);
});

function cancel(target: string, key: string): Request {
  return new Request(`http://app${target}`, {
    method: 'DELETE',
    headers: { ...ADA, 'idempotency-key': key },
  });
}

test('the same key on another path or query of one route answers reused; the method does not run', async () => {
  await using rt = await ordersRuntime();
  const first = await rt.fetch(cancel('/orders/1?reason=late', 'c1'));
  const replay = await rt.fetch(cancel('/orders/1?reason=late', 'c1'));
  const otherPath = await rt.fetch(cancel('/orders/2?reason=late', 'c1'));
  const otherQuery = await rt.fetch(cancel('/orders/1?reason=dup', 'c1'));

  assert.equal(first.status, 200);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(otherPath.status, 422);
  assert.equal(await errorCode(otherPath), 'key_reused');
  assert.equal(otherQuery.status, 422);
});

test('a 2xx event stream is answered and not kept: a retry runs again', async () => {
  await using rt = await ordersRuntime();
  const ticks = () =>
    new Request('http://app/ticks', { method: 'POST', headers: { ...ADA, 'idempotency-key': 't' } });
  const first = await rt.fetch(ticks());
  const second = await rt.fetch(ticks());

  assert.equal(first.headers.get('content-type'), 'text/event-stream');
  assert.notEqual(await first.text(), await second.text());
  assert.equal(second.headers.get('idempotent-replayed'), null);
});

test('a concurrent second request answers in-progress until the first completes', async () => {
  await using rt = await ordersRuntime();
  gate.open = Promise.withResolvers<void>();
  const first = rt.fetch(order({ item: 'milk', outcome: 'wait' }, 'k3'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await rt.fetch(order({ item: 'milk', outcome: 'wait' }, 'k3'));

  assert.equal(second.status, 409);
  assert.equal(await errorCode(second), 'in_progress');
  gate.open.resolve();
  assert.equal((await first).status, 201);
  const third = await rt.fetch(order({ item: 'milk', outcome: 'wait' }, 'k3'));

  assert.equal(third.status, 201);
  assert.equal(third.headers.get('idempotent-replayed'), 'true');
});

test('a running row past locked_until is reclaimed; the stale first run cannot overwrite it', async () => {
  await using rt = await ordersRuntime();
  gate.open = Promise.withResolvers<void>();
  const crashed = rt.fetch(order({ item: 'milk', outcome: 'wait' }, 'k4'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await rt.clock.advance(31_000);
  const retry = rt.fetch(order({ item: 'milk', outcome: 'wait' }, 'k4'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.open.resolve();
  await crashed;
  const retried = (await (await retry).json()) as Order;
  const replay = await rt.fetch(order({ item: 'milk', outcome: 'wait' }, 'k4'));

  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(await replay.json(), retried);
});

test('a 4xx outcome or a throw leaves no row: the key runs again', async () => {
  await using rt = await ordersRuntime();
  const refused = await rt.fetch(order({ item: 'milk', outcome: 'reject' }, 'k5'));
  const failed = await rt.fetch(order({ item: 'milk', outcome: 'throw' }, 'k6'));
  const afterRefusal = await rt.fetch(order({ item: 'milk' }, 'k5'));
  const afterThrow = await rt.fetch(order({ item: 'milk' }, 'k6'));

  assert.equal(refused.status, 409);
  assert.equal(failed.status, 500);
  assert.equal(afterRefusal.status, 201);
  assert.equal(afterRefusal.headers.get('idempotent-replayed'), null);
  assert.equal(afterThrow.status, 201);
  assert.equal(afterThrow.headers.get('idempotent-replayed'), null);
});

test('without the header the handler runs plainly every time', async () => {
  await using rt = await ordersRuntime();
  const first = (await (await rt.fetch(order({ item: 'milk' }))).json()) as Order;
  const second = (await (await rt.fetch(order({ item: 'milk' }))).json()) as Order;

  assert.equal(second.seq, first.seq + 1);
});

test('a bad key format fails as the headers input part', async () => {
  await using rt = await ordersRuntime();
  const long = await rt.fetch(order({ item: 'milk' }, 'k'.repeat(256)));
  const empty = await rt.fetch(order({ item: 'milk' }, ''));
  const body = (await long.json()) as { error: { code: string; issues: { path: string[] }[] } };

  assert.equal(long.status, 400);
  assert.equal(body.error.code, 'invalid_input');
  assert.deepEqual(body.error.issues[0]?.path, ['idempotency-key']);
  assert.equal(empty.status, 400);
});

async function bootApp(): Promise<Runtime> {
  const runtime = await createRuntime({
    root: fixture('v2/idempotent'),
    signals: false,
    env: {
      MURMUR_LOG_LEVEL: 'error',
      MURMUR__CAP_WEB__TRUST_PROXY: 'true',
      MURMUR__CAP_CLOCK__OVERRIDABLE: 'true',
    },
  });

  await runtime.start();

  return runtime;
}

function signup(base: string, key: string, ip: string, name = 'ada'): Promise<Response> {
  return fetch(`${base}/signup`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'idempotency-key': key, 'x-forwarded-for': ip },
    body: JSON.stringify({ name }),
  });
}

async function keyCount(runtime: Runtime, key: string): Promise<number> {
  const db = runtime.capabilities.get('sqlite') as Sqlite;
  const row = await db.get<{ n: number }>('SELECT count(*) AS n FROM murmur_idempotency WHERE key = ?', key);

  return row?.n ?? 0;
}

test('the runtime keeps rows in murmur_idempotency; an anonymous route scopes by ip; expired rows are swept', async () => {
  const runtime = await bootApp();

  try {
    const base = (runtime.capabilities.get('web') as HttpServer).url;
    const first = await signup(base, 's1', '10.0.0.1');
    const replay = await signup(base, 's1', '10.0.0.1');
    const otherIp = await signup(base, 's1', '10.0.0.2');

    assert.equal(first.status, 201);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(otherIp.status, 201);
    assert.equal(otherIp.headers.get('idempotent-replayed'), null);
    assert.equal(await keyCount(runtime, 's1'), 2);
    await runtime.clock.freeze(runtime.clock.now().add({ milliseconds: 61_000 }));
    await signup(base, 's2', '10.0.0.1');
    assert.equal(await keyCount(runtime, 's1'), 0);
    assert.equal(await keyCount(runtime, 's2'), 1);
  } finally {
    await runtime.stop('test');
  }
});

class Who extends Model({ actor: z.object({ id: z.string() }), keyId: z.string() }) {}

class Identify extends Guard(Who) {}

test('idempotent on GET or on a raw route is a boot error naming the allowed methods', () => {
  const web = http({ guards: [Identify] });

  assert.throws(
    () => web.get('/x', { idempotent: { scope: ['ip'] } }),
    (error: unknown) =>
      error instanceof MurmurError &&
      error.code === 'idempotent-method' &&
      error.message ===
        'route GET /x: `idempotent` applies to POST/PUT/PATCH/DELETE on non-raw routes; drop it or change the method',
  );
  assert.throws(() => web.raw('POST', '/up', { idempotent: { scope: ['ip'] } }), /idempotent/);
});

test('a scope path that does not resolve against the auth type is a boot error listing the available paths', () => {
  const web = http({ guards: [Identify] });

  assert.throws(
    () => web.post('/x', { idempotent: { scope: ['auth.acter.id'] } }),
    (error: unknown) =>
      error instanceof MurmurError &&
      error.code === 'idempotent-scope' &&
      error.message ===
        "route POST /x: scope `auth.acter.id` does not resolve against this route's auth type; available: auth.actor.id, auth.keyId, ip, peer",
  );
  assert.doesNotThrow(() => web.post('/y', { idempotent: { scope: ['auth.actor.id', 'ip'] } }));
});

const Actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string() }),
  z.object({ kind: z.literal('key'), id: z.string(), owner: z.string() }),
]);

class Principal extends Model({ actor: Actor, claims: z.record(z.string(), z.string()) }) {}

class Resolve extends Guard(Principal) {}

test('scope paths descend into unions and stay open below records, as murmur check reads them', () => {
  const web = http({ guards: [Resolve] });

  assert.doesNotThrow(() => web.post('/x', { idempotent: { scope: ['auth.actor.id', 'auth.actor.owner'] } }));
  assert.doesNotThrow(() => web.post('/y', { idempotent: { scope: ['auth.claims.sub'] } }));
  assert.throws(
    () => web.post('/z', { idempotent: { scope: ['auth.actor.name'] } }),
    (error: unknown) =>
      error instanceof MurmurError &&
      error.message ===
        "route POST /z: scope `auth.actor.name` does not resolve against this route's auth type; available: auth.actor.kind, auth.actor.id, auth.actor.owner, auth.claims, ip, peer",
  );
});
