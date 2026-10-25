import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idRefs } from '../src/ids/json-refs.ts';
import { createIdGenerator, uuidMillis } from '../src/ids/uuid.ts';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('UUIDv7 carries the given millisecond and sorts in mint order within it', () => {
  const ids = createIdGenerator();
  const ms = Date.parse('2026-05-04T09:15:30.250Z');
  const minted = Array.from({ length: 500 }, () => ids.next(ms));
  for (const id of minted) {
    assert.match(id, UUIDV7);
    assert.equal(uuidMillis(id), ms);
  }
  assert.deepEqual([...minted].sort(), minted);
  assert.equal(new Set(minted).size, minted.length);
});

test('id references name their kind from the field or the enclosing object', () => {
  const doc = { workspace_id: 1, actor: { id: 2 }, data: { task: { id: 3, assignee_id: null }, changes: { assignee_id: { from: 4, to: 5 } } }, items: [{ task_id: 6 }] };
  const refs = idRefs(doc).map((r) => [r.name, r.kind, r.value]);
  assert.deepEqual(refs, [
    ['workspace_id', 'workspace', 1],
    ['actor_id', 'user', 2],
    ['task_id', 'task', 3],
    ['assignee_id', 'user', null],
    ['assignee_id', 'user', 4],
    ['assignee_id', 'user', 5],
    ['task_id', 'task', 6],
  ]);
  assert.equal(idRefs(doc, { arrays: false }).some((r) => r.value === 6), false);
});
