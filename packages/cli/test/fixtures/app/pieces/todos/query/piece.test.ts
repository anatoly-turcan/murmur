import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testPiece } from '@murmur/node/testing';

import { TodoListRequested } from '#contracts/todos';

import { TodoQuery } from './piece.ts';

test('todos/query lists nothing yet', async () => {
  await using t = await testPiece(TodoQuery);
  assert.deepEqual(await t.deliver(TodoListRequested, {}), { items: [] });
});
