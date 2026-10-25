import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testPiece } from '@murmur/node/testing';

import { Authenticate, RateLimit } from '#contracts/auth';

import { Auth } from './piece.ts';

const config = { tokens: { ada: 'ada', root: 'root' }, perMinute: 2 };

function guardInput(headers: Record<string, string>, prior: Record<string, unknown> = {}) {
  return {
    transport: 'http',
    operation: 'GET /todos',
    headers,
    params: {},
    peer: '10.0.0.9',
    ip: '10.0.0.9',
    prior,
  };
}

test('a known bearer token is the principal; root carries the admin role', async () => {
  await using t = await testPiece(Auth, { config });

  assert.deepEqual(await t.deliver(Authenticate, guardInput({ authorization: 'Bearer ada' })), {
    userId: 'ada',
    roles: [],
  });

  assert.deepEqual(await t.deliver(Authenticate, guardInput({ authorization: 'Bearer root' })), {
    userId: 'root',
    roles: ['admin'],
  });
});

test('a missing or unknown token is refused with 401, not thrown', async () => {
  await using t = await testPiece(Auth, { config });
  const missing = await t.deliver(Authenticate, guardInput({}));
  const unknown = await t.deliver(Authenticate, guardInput({ authorization: 'Bearer eve' }));

  assert.deepEqual(missing, { status: 401, code: 'unauthorized', message: 'missing bearer token' });
  assert.deepEqual(unknown, { status: 401, code: 'unauthorized', message: 'unknown token' });
});

test('the rate limit counts per user within a minute window and refuses with 429 and retry-after past perMinute', async () => {
  await using t = await testPiece(Auth, { config });
  const ada = guardInput({}, { userId: 'ada', roles: [] });

  assert.deepEqual(await t.deliver(RateLimit, ada), { remaining: 1 });
  assert.deepEqual(await t.deliver(RateLimit, ada), { remaining: 0 });

  assert.deepEqual(await t.deliver(RateLimit, ada), {
    status: 429,
    code: 'rate_limited',
    message: 'rate limit exceeded',
    details: { perMinute: 2 },
    headers: { 'retry-after': '60' },
  });

  assert.deepEqual(await t.deliver(RateLimit, guardInput({}, { userId: 'root', roles: ['admin'] })), {
    remaining: 1,
  });

  assert.deepEqual(await t.deliver(RateLimit, guardInput({})), { remaining: 1 });
  await t.clock.advance(15_000);
  const refused = await t.deliver(RateLimit, ada);

  assert.deepEqual('headers' in refused ? refused.headers : null, { 'retry-after': '45' });
  await t.clock.advance(45_000);
  assert.deepEqual(await t.deliver(RateLimit, ada), { remaining: 1 });
});
