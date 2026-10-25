import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTestRuntime } from '@murmur/node/testing';

import web from '../fixtures/v2/admission/capabilities/web/capability.ts';
import { Authenticate, ResolveTarget } from '../fixtures/v2/admission/contracts/access.ts';
import { Access } from '../fixtures/v2/admission/pieces/access/piece.ts';
import { Items } from '../fixtures/v2/admission/pieces/items/piece.ts';
import { Store } from '../fixtures/v2/admission/pieces/store/piece.ts';

const ADA = { authorization: 'Bearer ada' };

function admissionRuntime(limit = 100) {
  return createTestRuntime({
    pieces: { access: Access, items: Items, store: Store },
    config: { access: { limit } },
  });
}

function guardNames(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith('access.'));
}

test('guards run in declaration order and a rejection stops the chain', async () => {
  await using rt = await admissionRuntime();
  const refused = await rt.fetch(new Request('http://app/items/7'));
  const refusedGuards = guardNames(rt.events('access.*').map((e) => e.name));
  const allowed = await rt.fetch(new Request('http://app/items/7', { headers: ADA }));
  const allGuards = guardNames(rt.events('access.*').map((e) => e.name)).slice(refusedGuards.length);

  assert.equal(refused.status, 401);
  assert.deepEqual(refusedGuards, ['access.Authenticate']);
  assert.equal(allowed.status, 200);
  assert.deepEqual(allGuards, ['access.Authenticate', 'access.ResolveTarget', 'access.RateLimit']);
});

test('prior carries the outputs of the guards a guard lists, and meta arrives with defaults', async () => {
  await using rt = await admissionRuntime();

  const response = await rt.fetch(
    new Request('http://app/items/7/notes', {
      method: 'POST',
      headers: { ...ADA, 'content-type': 'application/json' },
      body: '{"a":1}',
    }),
  );

  assert.equal(response.status, 200);

  assert.deepEqual(await response.json(), {
    auth: { userId: 'ada', role: 'viewer', target: 'note:7:ada', remaining: 99, bucket: 'ada' },
    body: { a: 1 },
  });
});

test('each guard request carries only the meta keys its own shape declares', async () => {
  await using rt = await admissionRuntime();
  await rt.fetch(new Request('http://app/items/7', { headers: ADA }));
  const metaOf = (name: string) =>
    (rt.events(name).at(-1)?.payload as { meta?: Record<string, unknown> } | undefined)?.meta;

  assert.deepEqual(metaOf('access.ResolveTarget'), { target: 'item', param: 'id', role: 'member' });
  assert.deepEqual(metaOf('access.Authenticate'), {});
  assert.deepEqual(metaOf('access.RateLimit'), {});
});

test('an optional guard sees undefined in prior when the route skips it', async () => {
  await using rt = await admissionRuntime();
  const open = await rt.fetch(new Request('http://app/public', { headers: ADA }));
  const known = await rt.fetch(new Request('http://app/whoami', { headers: ADA }));
  assert.deepEqual(await open.json(), { remaining: 99, bucket: 'ip:127.0.0.1' });
  assert.deepEqual(await known.json(), { userId: 'ada', remaining: 99, bucket: 'ada' });
});

test('a route meta key no kept guard reads fails at boot and lists the allowed keys', () => {
  assert.throws(() => web.get('/typo/:id', { meta: { rol: 'member' } }), {
    code: 'guard-meta-unknown',
    message:
      'route GET /typo/:id: meta key `rol` is read by no kept guard; the kept guards accept target, param, role',
  });
  assert.throws(() => web.get('/open', { skip: [Authenticate, ResolveTarget], meta: { role: 'member' } }), {
    code: 'guard-meta-unknown',
    message: 'route GET /open: meta key `role` is read by no kept guard; the kept guards accept no meta keys',
  });
  // @ts-expect-error meta.role is typed by ResolveTarget's meta shape: 'viewer' | 'member'
  assert.throws(() => web.get('/bad/:id', { meta: { role: 'owner' } }), {
    code: 'guard-meta-invalid',
  });
});

test('a route that skips a guard another kept guard lists in after fails at boot', () => {
  assert.throws(() => web.get('/orphan/:id', { skip: [Authenticate] }), {
    code: 'guard-order',
    message:
      "route GET /orphan/:id skips Authenticate but keeps ResolveTarget, whose `after` names Authenticate; skip ResolveTarget too, or declare Authenticate in ResolveTarget's `optional`",
  });
});

test('a 429 with Retry-After from a guard rejection reaches the client', async () => {
  await using rt = await admissionRuntime(1);
  const first = await rt.fetch(new Request('http://app/whoami', { headers: ADA }));
  const limited = await rt.fetch(new Request('http://app/whoami', { headers: ADA }));
  const body = (await limited.json()) as { error: { code: string } };

  assert.equal(first.status, 200);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(body.error.code, 'rate_limited');
});

test('an oversize body with a bad credential gets 401, not 413; with the credential it gets 413', async () => {
  await using rt = await admissionRuntime();
  const body = JSON.stringify({ note: 'x'.repeat(64) });
  const anonymous = await rt.fetch(new Request('http://app/items/7/notes', { method: 'POST', body }));

  const known = await rt.fetch(
    new Request('http://app/items/7/notes', { method: 'POST', body, headers: ADA }),
  );

  assert.equal(anonymous.status, 401);
  assert.equal(known.status, 413);
});

test('responseHeaders apply after admission, on a 404 and on a 200, not on a guard refusal', async () => {
  await using rt = await admissionRuntime();
  const found = await rt.fetch(new Request('http://app/items/7', { headers: ADA }));
  const missing = await rt.fetch(new Request('http://app/items/missing', { headers: ADA }));
  const refused = await rt.fetch(new Request('http://app/items/7'));

  assert.equal(found.status, 200);
  assert.equal(found.headers.get('x-rate-remaining'), '99');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-rate-remaining'), '98');
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('x-rate-remaining'), null);
});

test('one access log line per request carries method, path, status, ms, traceId and the log(auth) fields', async () => {
  await using rt = await admissionRuntime();
  const ok = await rt.fetch(new Request('http://app/items/7', { headers: ADA }));
  const refused = await rt.fetch(new Request('http://app/items/7'));
  const lines = rt.log.records.filter((record) => record.message === 'access');

  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map(({ data }) => Object.assign({}, data, { ms: typeof data?.['ms'] })),
    [
      {
        method: 'GET',
        path: '/items/7',
        status: 200,
        ms: 'number',
        traceId: ok.headers.get('x-murmur-trace'),
        user: 'ada',
      },
      {
        method: 'GET',
        path: '/items/7',
        status: 401,
        ms: 'number',
        traceId: refused.headers.get('x-murmur-trace'),
        user: null,
      },
    ],
  );
});
