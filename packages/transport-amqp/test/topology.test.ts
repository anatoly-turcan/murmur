import assert from 'node:assert/strict';
import { test } from 'node:test';

import { queueName, retryRoute, tierFor } from '../src/topology.ts';

test('groups map to queue names', () => {
  assert.equal(queueName('billing/invoice'), 'murmur.q.billing.invoice');
  assert.equal(queueName('$reply.1f9a2b3c'), 'murmur.reply.1f9a2b3c');
  assert.equal(queueName('$observer.tail.1f9a2b3c'), 'murmur.obs.tail.1f9a2b3c');
});

test('retry delays round up to the next tier and cap at the last', () => {
  assert.deepEqual(
    [1, 250, 251, 1000, 4999, 5001, 90_000].map(tierFor),
    [250, 250, 1000, 1000, 5000, 30_000, 30_000],
  );
});

test('a retry routes to its per-queue tier queue', () => {
  assert.deepEqual(retryRoute('murmur.q.a', 600), {
    tier: 1000,
    queue: 'murmur.retry.murmur.q.a.1000',
    key: 'murmur.q.a.1000',
  });
});
