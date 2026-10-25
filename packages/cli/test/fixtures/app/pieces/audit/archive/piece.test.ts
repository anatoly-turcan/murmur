import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testPiece } from '@murmur/node/testing';

import { AuditRecorded } from '#contracts/audit';

import { AuditArchive } from './piece.ts';

test('audit/archive logs the record', async () => {
  await using t = await testPiece(AuditArchive);
  await t.deliver(AuditRecorded, { todoId: 't1' });
  assert.equal(t.log.records.length, 1);
});
