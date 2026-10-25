import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sqlite, type Sqlite } from '@murmur/node/capabilities';
import { fakeSqlite } from '@murmur/node/testing';
import { Model } from 'murmur';
import { z } from 'zod';

class Item extends Model({
  id: z.string(),
  done: z.boolean(),
  archived: z.boolean().nullable(),
  labels: z.array(z.string()),
  meta: z.object({ color: z.string() }),
  counts: z.record(z.string(), z.number()),
  note: z.string(),
  rank: z.number(),
}) {}

const SELECT = 'SELECT id, done, archived, labels, meta, counts, note, rank FROM items';

async function items(): Promise<Sqlite> {
  const db = await fakeSqlite();

  await db.exec(
    'CREATE TABLE items (id TEXT PRIMARY KEY, done INTEGER, archived INTEGER, labels TEXT, meta TEXT, counts TEXT, note TEXT, rank INTEGER, created_at TEXT)',
  );

  await db.run(
    'INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'i1',
    1,
    null,
    '["a","b"]',
    '{"color":"red"}',
    '{"x":2}',
    '["not","decoded"]',
    3,
    '2026-10-25',
  );

  await db.run(
    'INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'i2',
    0,
    1,
    '[]',
    '{"color":"blue"}',
    '{}',
    'plain',
    7,
    '2026-10-26',
  );

  return db;
}

test('db.rows decodes integer to boolean and TEXT to array/object/record by the Model, other columns as is', async () => {
  const db = await items();

  assert.deepEqual(await db.rows(Item, `${SELECT} ORDER BY id`), [
    {
      id: 'i1',
      done: true,
      archived: null,
      labels: ['a', 'b'],
      meta: { color: 'red' },
      counts: { x: 2 },
      note: '["not","decoded"]',
      rank: 3,
    },
    {
      id: 'i2',
      done: false,
      archived: true,
      labels: [],
      meta: { color: 'blue' },
      counts: {},
      note: 'plain',
      rank: 7,
    },
  ]);
});

test('db.row returns the decoded model, drops columns the Model lacks, and null when no row matches', async () => {
  const db = await items();
  const item: Item | null = await db.row(Item, 'SELECT *, 1 AS extra FROM items WHERE id = ?', 'i2');

  assert.equal(item?.done, false);
  assert.equal(Object.hasOwn(item ?? {}, 'created_at'), false);
  assert.equal(Object.hasOwn(item ?? {}, 'extra'), false);
  assert.equal(await db.row(Item, `${SELECT} WHERE id = ?`, 'missing'), null);
});

test('a missing column is a decode error naming it and the alias form', async () => {
  const db = await items();

  await assert.rejects(db.row(Item, 'SELECT id, done, archived, labels, meta, counts, rank FROM items'), {
    name: 'SqliteError',
    message:
      'db.row(Item): column "note" is missing from the result; select every field of the Model, aliasing in SQL (SELECT <column> AS note)',
  });
});

test('a value the Model refuses after decoding is an error naming the column', async () => {
  const db = await items();
  await db.run('UPDATE items SET labels = ? WHERE id = ?', 'a,b', 'i1');
  await db.run('UPDATE items SET done = 2 WHERE id = ?', 'i2');

  await assert.rejects(db.row(Item, `${SELECT} WHERE id = ?`, 'i1'), {
    name: 'SqliteError',
    message: /^db\.row\(Item\): column "labels" holds TEXT that is not JSON; store JSON\.stringify\(value\)/,
  });

  await assert.rejects(db.rows(Item, `${SELECT} WHERE id = ?`, 'i2'), {
    name: 'SqliteError',
    message: /^db\.rows\(Item\): column "done" does not fit the Model: /,
  });
});

test('tx.rows and tx.row decode inside a transaction', async () => {
  const db = await items();

  const found = await db.transaction(async (tx) => {
    await tx.run('UPDATE items SET done = 0 WHERE id = ?', 'i1');

    return tx.row(Item, `${SELECT} WHERE id = ?`, 'i1');
  });

  assert.equal(found?.done, false);
});

test('the sqlite sheet teaches db.rows/db.row decoding and the alias rule', () => {
  const sheet = sqlite().docs ?? '';

  assert.match(sheet, /await db\.rows\(Todo, /);
  assert.match(sheet, /await db\.row\(Todo, /);
  assert.match(sheet, /alias in SQL/);
  assert.doesNotMatch(sheet, /map it yourself/);
});
