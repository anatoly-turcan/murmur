import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { fetch as fetchToken, type Sqlite } from '@murmur/node/capabilities';
import { createTestApp, fakeSqlite, testPiece } from '@murmur/node/testing';
import { defineCapability, Piece } from 'murmur';

import { AuditItem, CreateItem, ImportItem, IndexItem } from '../fixtures/v2/testkit/contracts/kit.ts';
import { Items } from '../fixtures/v2/testkit/pieces/items/piece.ts';
import { fixture } from '../helpers.ts';

const root = fixture('v2/testkit');
const ADA = { authorization: 'Bearer ada', 'content-type': 'application/json' };

async function tables(db: Sqlite): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
  );

  return rows.map((row) => row.name);
}

test('testPiece(P) with needs { db, jobs } and no needs argument fakes both and records the enqueues', async () => {
  await using t = await testPiece(Items);
  const item = await t.deliver(CreateItem, { title: 'milk' });

  assert.deepEqual(item, { id: t.ids.issued[0], title: 'milk' });
  assert.deepEqual(t.enqueued(IndexItem), [
    { input: { id: item.id }, options: { dedupeKey: `index:${item.id}` } },
  ]);
  assert.deepEqual(t.enqueued(AuditItem), [{ input: { id: item.id }, options: {} }]);
  assert.deepEqual(await t.needs.db.get('SELECT title, indexed FROM items'), { title: 'milk', indexed: 0 });
});

test('t.runJobs runs the due recorded jobs this piece handles and leaves the others', async () => {
  await using t = await testPiece(Items);
  const item = await t.deliver(CreateItem, { title: 'milk' });
  assert.deepEqual(await t.runJobs(), { ran: 1 });
  assert.deepEqual(await t.needs.db.get('SELECT indexed FROM items WHERE id = ?', item.id), { indexed: 1 });
  assert.deepEqual(await t.needs.jobs.counts(), { pending: 1, running: 0, dead: 0 });
  assert.deepEqual(await t.runJobs(), { ran: 0 });
});

test('an enqueue inside a rolled-back transaction leaves no job', async () => {
  await using t = await testPiece(Items);
  await t.deliver(ImportItem, { id: 'x', title: 'milk' });
  await assert.rejects(t.deliver(ImportItem, { id: 'x', title: 'again' }), /UNIQUE constraint failed/);
  assert.deepEqual(t.enqueued(IndexItem), [{ input: { id: 'x' }, options: {} }]);
  assert.deepEqual(await t.needs.jobs.counts(), { pending: 1, running: 0, dead: 0 });
  assert.deepEqual(await t.runJobs(), { ran: 1 });
});

test('t.reset() forgets emitted events, requests, log and recorded jobs', async () => {
  await using t = await testPiece(Items);
  await t.deliver(CreateItem, { title: 'milk' });
  await t.reset();
  const again = await t.deliver(CreateItem, { title: 'eggs' });

  assert.deepEqual(t.enqueued(IndexItem), [
    { input: { id: again.id }, options: { dedupeKey: `index:${again.id}` } },
  ]);
  assert.deepEqual(await t.needs.jobs.counts(), { pending: 2, running: 0, dead: 0 });
  assert.deepEqual(await t.runJobs(), { ran: 1 });
});

test("a capability's own fake is injected with the test clock when the need is left out", async () => {
  const sent: string[] = [];

  const mailer = defineCapability({
    name: 'mailer',
    start: () => ({ send: async (_to: string) => {} }),
    fake: ({ clock }) => ({
      send: async (to: string) => {
        sent.push(`${to}@${clock.now().toString()}`);
      },
    }),
  });

  class Mailing extends Piece({ needs: { mail: mailer } }) {}

  await using t = await testPiece(Mailing, { now: '2030-01-01T00:00:00Z' });
  await t.needs.mail.send('ada');
  assert.deepEqual(sent, ['ada@2030-01-01T00:00:00Z']);
});

test("the sqlite fake applies the app's migration list, so another piece's schema.sql is there", async () => {
  await using t = await testPiece(Items);
  const explicit = await fakeSqlite({ schema: 'app', root });

  assert.deepEqual(
    (await tables(t.needs.db)).filter((name) => !name.startsWith('murmur_')),
    ['audits', 'items'],
  );

  assert.ok((await tables(explicit)).includes('audits'));
});

test("fakeSqlite({ schema: 'own' }) applies only the piece's schema.sql; a list applies those files", async () => {
  const own = await fakeSqlite({ schema: 'own', root, pieceDir: join(root, 'pieces', 'items') });
  const listed = await fakeSqlite({ schema: ['pieces/audit/schema.sql'], root });
  assert.ok((await tables(own)).includes('items'));
  assert.ok(!(await tables(own)).includes('audits'));
  assert.ok((await tables(listed)).includes('audits'));
  assert.ok(!(await tables(listed)).includes('items'));
});

test('a passed need wins over the fake; a need without a fake names both allowed forms', async () => {
  const db = await fakeSqlite();

  await db.exec(
    'CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL, indexed INTEGER NOT NULL DEFAULT 0)',
  );

  await using t = await testPiece(Items, { needs: { db } });
  await t.deliver(CreateItem, { title: 'milk' });
  const mailer = defineCapability({ name: 'mailer', start: () => ({ send: async () => {} }) });

  class Mailing extends Piece({ needs: { mail: mailer } }) {}

  assert.equal(t.needs.db, db);
  assert.deepEqual(await db.all('SELECT title FROM items'), [{ title: 'milk' }]);

  await assert.rejects(testPiece(Mailing), {
    message:
      'testPiece: Mailing needs mail (mailer), which has no fake; pass it in options.needs ({ needs: { mail: … } }) or give the capability one: defineCapability({ …, fake: ({ clock }) => handle })',
  });
});

test('the fetch fake refuses until a handler is passed', async () => {
  class Caller extends Piece({ needs: { fetch: fetchToken } }) {}

  await using t = await testPiece(Caller);
  await assert.rejects(t.needs.fetch('https://example.com'), /pass needs: \{ fetch: fakeFetch\(/);
});

test('createTestApp() serves the real guards on a temp migrated database', async () => {
  await using app = await createTestApp({ root });
  const anonymous = await app.fetch('/items', { method: 'POST', body: JSON.stringify({ title: 'x' }) });

  const created = await app.fetch('/items', {
    method: 'POST',
    headers: ADA,
    body: JSON.stringify({ title: 'milk' }),
  });

  assert.equal(anonymous.status, 401);
  assert.equal(created.status, 201);
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(await app.db.all('SELECT title FROM items'), [{ title: 'milk' }]);
});

test('app.jobs.drain() runs the job handlers of every piece', async () => {
  await using app = await createTestApp({ root });

  const response = await app.fetch('/items', {
    method: 'POST',
    headers: ADA,
    body: JSON.stringify({ title: 'milk' }),
  });

  const item = (await response.json()) as { id: string };
  assert.deepEqual(await app.jobs.drain(), { ran: 2, failed: 0, dead: 0 });
  assert.deepEqual(await app.db.get('SELECT indexed FROM items'), { indexed: 1 });
  assert.deepEqual(await app.db.all('SELECT item_id FROM audits'), [{ item_id: item.id }]);
});

test('reset() truncates app tables, deletes jobs and kv rows, keeps the murmur_* tables and clears the clock override', async () => {
  await using app = await createTestApp({ root });
  await app.clock.freeze('2030-01-01T00:00:00Z');
  await app.db.exec('CREATE TABLE IF NOT EXISTS murmur_kv (key TEXT PRIMARY KEY, value TEXT)');
  await app.db.run("INSERT INTO murmur_kv (key, value) VALUES ('hits', '3')");
  await app.fetch('/items', { method: 'POST', headers: ADA, body: JSON.stringify({ title: 'milk' }) });
  const before = await tables(app.db);
  const migrations = await app.db.all('SELECT name FROM murmur_migrations');
  await app.reset();
  assert.deepEqual(await tables(app.db), before);
  assert.ok(before.includes('murmur_clock') && before.includes('murmur_jobs'));
  assert.deepEqual(await app.db.all('SELECT name FROM murmur_migrations'), migrations);
  assert.deepEqual(await app.db.all('SELECT * FROM items'), []);
  assert.deepEqual(await app.db.all('SELECT * FROM murmur_kv'), []);
  assert.deepEqual(await app.jobs.counts(), { pending: 0, running: 0, dead: 0 });
  assert.notEqual(app.clock.now().toZonedDateTimeISO('UTC').year, 2030);
});
