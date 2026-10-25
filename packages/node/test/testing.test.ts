import assert from 'node:assert/strict';
import { test } from 'node:test';

import { current } from '@murmur/node';
import { fakeFetch, fakeKv, fakeSqlite, runInContext, testPiece } from '@murmur/node/testing';

test('fakeKv.once rolls back on throw and runs the effect again', async () => {
  const kv = fakeKv();

  await assert.rejects(
    kv.once('a', async () => {
      await kv.set('inside', 1);
      throw new Error('nope');
    }),
  );

  assert.equal(await kv.get('inside'), undefined);
  assert.deepEqual(await kv.once('a', () => 42), { first: true, value: 42 });
  assert.deepEqual(await kv.once('a', () => 43), { first: false });
});

test('fakeFetch answers through the handler', async () => {
  const fetch = fakeFetch((req) => Response.json({ url: req.url, method: req.method }));
  const response = await fetch('https://example.test/x', { method: 'POST' });
  assert.deepEqual(await response.json(), { url: 'https://example.test/x', method: 'POST' });
});

test('testPiece is re-exported', () => {
  assert.equal(typeof testPiece, 'function');
});

test('runInContext runs a capability call inside a delivery run without testPiece', async () => {
  const db = await fakeSqlite();
  await db.exec('CREATE TABLE t (v TEXT)');

  const seen = await runInContext({ piece: 'mailer', traceId: 'trace-mailer' }, async () => {
    await db.transaction(() => db.run('INSERT INTO t VALUES (?)', 'joined'));

    return current();
  });

  assert.equal(seen?.piece, 'mailer');
  assert.equal(seen?.traceId, 'trace-mailer');
  assert.equal(typeof seen?.deliveryId, 'string');
  assert.deepEqual(await db.all('SELECT v FROM t'), [{ v: 'joined' }]);
  assert.equal(current(), undefined);
});
