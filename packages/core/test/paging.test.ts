import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type InputOf,
  isRejection,
  Model,
  type OutputOf,
  Page,
  Paging,
  Query,
  reject,
  rejectable,
} from 'murmur';
import { z } from 'zod';

class Item extends Model({ id: z.string() }) {}

class ListItems extends Query({ tag: z.string().optional(), ...Paging() }, Page(Item), {
  name: 'items.list',
}) {}

class ListShort extends Query(
  { ...Paging({ max: 50, default: 10 }) },
  Page(Item, { cursorField: 'nextCursor' }),
  { name: 'items.short' },
) {}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const sameOutput: Same<OutputOf<typeof ListShort>, { data: Item[]; nextCursor: string | null }> = true;

const sameInput: Same<
  InputOf<typeof ListItems>,
  { tag?: string | undefined; limit?: number | undefined; cursor?: string | null | undefined }
> = true;

test('Paging() defaults to limit 20 of at most 100 and a null cursor', () => {
  assert.equal(sameInput, true);
  assert.deepEqual(ListItems.input.parse({}), { limit: 20, cursor: null });
  assert.deepEqual(ListItems.input.parse({ limit: 100, cursor: 'abc' }), { limit: 100, cursor: 'abc' });
  assert.equal(ListItems.input.safeParse({ limit: 101 }).success, false);
  assert.equal(ListItems.input.safeParse({ limit: 0 }).success, false);
  assert.equal(ListItems.input.safeParse({ limit: 1.5 }).success, false);
});

test('Paging({ max, default }) takes the app bounds', () => {
  assert.deepEqual(ListShort.input.parse({}), { limit: 10, cursor: null });
  assert.equal(ListShort.input.safeParse({ limit: 51 }).success, false);
});

test('Paging() refuses a default above max, naming the allowed form', () => {
  assert.throws(
    () => Paging({ max: 10, default: 20 }),
    /Paging\(\{ max: 10, default: 20 \}\): .*Paging\(\{ max: 100, default: 20 \}\)/,
  );
  assert.throws(() => Paging({ max: 0 }), /positive integers/);
});

test('Page(Model) is { data, next_cursor } and the cursor field is renamable', () => {
  assert.equal(sameOutput, true);
  assert.deepEqual(ListItems.output.parse({ data: [{ id: 'a' }], next_cursor: null }), {
    data: [{ id: 'a' }],
    next_cursor: null,
  });
  assert.equal(ListItems.output.safeParse({ data: [{ id: 'a' }] }).success, false);
  assert.deepEqual(ListShort.output.parse({ data: [], nextCursor: 'x' }), { data: [], nextCursor: 'x' });
  assert.equal(ListShort.jsonSchema().output?.['title'], 'Page(Item)');
});

test('rejectable(Page(Model)) lets a list refuse a bad cursor and keeps the Page title', () => {
  class Listing extends Query({ ...Paging() }, rejectable(Page(Item)), { name: 'items.listing' }) {}

  const refused = reject(400, 'bad cursor', { code: 'invalid_cursor' });

  assert.equal(isRejection(Listing.output.parse(refused)), true);
  assert.deepEqual(Listing.output.parse({ data: [], next_cursor: null }), { data: [], next_cursor: null });
  assert.equal(Listing.jsonSchema().output?.['title'], 'rejectable(Page(Item))');
});
