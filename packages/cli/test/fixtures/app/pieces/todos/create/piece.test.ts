import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeSqlite, testPiece } from '@murmur/node/testing';

import { TodoCreated, TodoCreateRequested } from '#contracts/todos';

import { TodoCreator } from './piece.ts';

test('todos/create replies with the new todo and emits todos.created', async () => {
  await using t = await testPiece(TodoCreator, {
    needs: { db: await fakeSqlite() },
    config: { prefix: 'fx' },
  });

  const reply = await t.deliver(TodoCreateRequested, { title: 'milk' });
  assert.equal(reply.title, 'milk');
  assert.equal(t.emitted(TodoCreated).length, 1);
});
