import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testPiece } from '@murmur/node/testing';

import { GetStats } from '#contracts/stats';
import { TodoCompleted, TodoCreated, TodoRemoved } from '#contracts/todos';

import { TodoStats } from './piece.ts';

test('an empty read model counts zero', async () => {
  await using t = await testPiece(TodoStats);
  assert.deepEqual(await t.deliver(GetStats, {}), { total: 0, done: 0 });
});

test('created, completed and removed events move the counts', async () => {
  await using t = await testPiece(TodoStats);
  await t.deliver(TodoCreated, { id: 't1', title: 'milk' });
  await t.deliver(TodoCreated, { id: 't2', title: 'bread' });
  await t.deliver(TodoCompleted, { id: 't1' });
  assert.deepEqual(await t.deliver(GetStats, {}), { total: 2, done: 1 });
  await t.deliver(TodoRemoved, { id: 't1' });
  assert.deepEqual(await t.deliver(GetStats, {}), { total: 1, done: 0 });
});

test('a redelivered event counts once', async () => {
  await using t = await testPiece(TodoStats);
  await t.deliver(TodoCreated, { id: 't1', title: 'milk' }, { envelopeId: 'e1' });
  await t.deliver(TodoCreated, { id: 't1', title: 'milk' }, { envelopeId: 'e1', attempt: 2 });
  await t.deliver(TodoCompleted, { id: 't1' });
  await t.deliver(TodoCompleted, { id: 't1' });
  assert.deepEqual(await t.deliver(GetStats, {}), { total: 1, done: 1 });
});
