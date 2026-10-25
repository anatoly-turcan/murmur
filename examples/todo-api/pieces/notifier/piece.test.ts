import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testPiece } from '@murmur/node/testing';

import { NotifyTodo, SweepNotifications } from '#contracts/notifications';

import { Notifier } from './piece.ts';

test('NotifyTodo records the notification once, even when the job runs again', async () => {
  await using t = await testPiece(Notifier, { now: '2026-10-25T12:00:00Z' });
  await t.deliver(NotifyTodo, { id: 't1', title: 'milk' });
  await t.deliver(NotifyTodo, { id: 't1', title: 'milk' }, { attempt: 2 });

  assert.deepEqual(await t.needs.db.all('SELECT todo_id, title, sent_at FROM notifications'), [
    { todo_id: 't1', title: 'milk', sent_at: '2026-10-25T12:00:00Z' },
  ]);
});

test('SweepNotifications deletes notifications older than a day', async () => {
  await using t = await testPiece(Notifier, { now: '2026-10-25T12:00:00Z' });
  await t.deliver(NotifyTodo, { id: 'old', title: 'stale' });
  await t.clock.advance(25 * 60 * 60 * 1000);
  await t.deliver(NotifyTodo, { id: 'new', title: 'fresh' });
  await t.deliver(SweepNotifications, {});
  assert.deepEqual(await t.needs.db.all('SELECT todo_id FROM notifications'), [{ todo_id: 'new' }]);
});
