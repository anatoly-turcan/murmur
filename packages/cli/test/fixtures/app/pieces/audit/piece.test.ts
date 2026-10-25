import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testPiece } from '@murmur/node/testing';

import { AuditRecorded } from '#contracts/audit';
import { TodoCreated } from '#contracts/todos';

import { Audit } from './piece.ts';

test('audit records a created todo', async () => {
  await using t = await testPiece(Audit);
  await t.deliver(TodoCreated, { id: 't1', title: 'milk' });
  assert.deepEqual(
    t.emitted(AuditRecorded).map((e) => e.todoId),
    ['t1'],
  );
});
