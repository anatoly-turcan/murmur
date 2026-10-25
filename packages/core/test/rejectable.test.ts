import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Command,
  etag,
  IfMatch,
  isRejectable,
  isRejection,
  Model,
  Query,
  reject,
  rejectable,
  type OutputOf,
  type Rejection,
} from 'murmur';
import { z } from 'zod';

import { on, setup, until } from './bus-harness.ts';

class Item extends Model({ id: z.string(), version: z.number() }) {}

class Empty extends Model({}) {}

class UpdateItem extends Command({ id: z.string(), ifMatch: IfMatch }, rejectable(Item), {
  name: 'items.update',
}) {}

class DeleteItem extends Command({ id: z.string() }, rejectable(Empty), { name: 'items.delete' }) {}

class FindItem extends Query({ id: z.string() }, rejectable(Item), { name: 'items.find' }) {}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const sameOutput: Same<OutputOf<typeof UpdateItem>, Item | Rejection> = true;

test('rejectable(M) types the output M | Rejection and accepts both at runtime', () => {
  const refused = reject(409, 'The object changed since you read it.', {
    code: 'version_conflict',
    details: [{ path: 'if-match', code: 'stale', current: 3 }],
  });

  assert.equal(sameOutput, true);
  assert.deepEqual(UpdateItem.output.parse({ id: 'i1', version: 2 }), { id: 'i1', version: 2 });
  assert.deepEqual(UpdateItem.output.parse(refused), refused);
  assert.equal(UpdateItem.output.safeParse({ id: 1 }).success, false);
  assert.equal(isRejectable(UpdateItem.output), true);
  assert.equal(isRejectable(Item.schema), false);
});

test('rejectable(Empty) keeps a Rejection instead of stripping it to {}', () => {
  const refused = reject(404, 'The object was not found.');

  assert.deepEqual(DeleteItem.output.parse(refused), refused);
  assert.deepEqual(DeleteItem.output.parse({}), {});
});

test('the JSON Schema of a rejectable output is titled rejectable(Model); an IfMatch input field is representable', () => {
  const { input, output = {} } = UpdateItem.jsonSchema();

  assert.equal(output['title'], 'rejectable(Item)');
  assert.deepEqual(Object.keys(Object(input['properties'])), ['id', 'ifMatch']);
});

test('isRejection narrows a Rejection and refuses a model with extra keys', () => {
  const refused: unknown = reject(404, 'gone');

  assert.equal(isRejection(refused), true);
  assert.equal(isRejection({ id: 'i1', version: 1 }), false);
  assert.equal(isRejection({ status: 404, code: 'x', message: 'y', id: 'i1' }), false);
  assert.equal(isRejection(null), false);
});

test('a returned Rejection is a successful delivery: no retry, no dead letter, the reply is sent', async () => {
  await using h = setup();
  let calls = 0;

  await h.add('store', {
    on: [
      on(UpdateItem, () => {
        calls += 1;

        return reject(404, 'The object was not found.');
      }),
    ],
    policy: { retry: { maxAttempts: 3, baseMs: 1, maxMs: 1, jitter: 0 } },
  });

  const out = await h.bus.request(UpdateItem, { id: 'i1', ifMatch: null });
  await until(() => h.sys('delivery.acked').length === 1);

  assert.equal(isRejection(out), true);
  assert.equal(calls, 1);
  assert.equal(h.sys('delivery.retried').length, 0);
  assert.equal(h.sys('delivery.deadlettered').length, 0);
  assert.equal(h.sys('delivery.acked')[0]?.payload['replied'], true);
  assert.equal(h.sys('request.completed')[0]?.payload['ok'], true);
});

test('a Query answering a Rejection is still deduplicated per trace', async () => {
  await using h = setup();
  let calls = 0;

  await h.add('store', {
    on: [
      on(FindItem, () => {
        calls += 1;

        return reject(410, 'The object is gone.');
      }),
    ],
  });

  await h.add('front', { on: [] });
  const port = h.bus.portFor('front');

  const answers = await h.bus.invoke('front', { transport: 'test', binding: 'probe' }, () =>
    Promise.all([port.request(FindItem, { id: 'i1' }), port.request(FindItem, { id: 'i1' })]),
  );

  assert.equal(calls, 1);
  assert.deepEqual(answers[0], answers[1]);
  assert.equal(isRejection(answers[0]), true);
  assert.equal(h.sys('request.deduped').length, 1);
});

test('IfMatch reads a quoted strong ETag, * and absence; etag() quotes once', () => {
  const header = z.object({ 'if-match': IfMatch });

  assert.equal(header.parse({ 'if-match': '"7"' })['if-match'], '7');
  assert.equal(header.parse({ 'if-match': '*' })['if-match'], '*');
  assert.equal(header.parse({})['if-match'], null);
  assert.equal(header.parse({ 'if-match': '7' })['if-match'], '7');
  assert.equal(header.safeParse({ 'if-match': 'W/"7"' }).success, false);
  assert.equal(etag(7), '"7"');
  assert.equal(etag('"abc"'), '"abc"');
});
