import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.ts';
import type { UserRow } from '../src/domain/rows.ts';
import { changesBetween } from '../src/features/tasks/diff.ts';
import { sortOf, taskListSql } from '../src/features/tasks/list-query.ts';

const NOW = Date.parse('2026-05-10T12:00:00Z');
const ME = { id: '1', timezone: 'UTC' } as UserRow;

function seeded(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.exec(`INSERT INTO users (id, email, email_key, name, timezone, created_at, updated_at) VALUES ('1', 'a@x', 'a@x', 'A', 'UTC', 0, 0);
    INSERT INTO workspaces (id, name, slug, slug_key, owner_id, created_at, updated_at) VALUES ('1', 'W', 'w', 'w', '1', 0, 0);
    INSERT INTO projects (id, workspace_id, name, slug, slug_key, creator_id, created_at, updated_at, deleted_at)
      VALUES ('1', '1', 'P', 'p', 'p', '1', 0, 0, NULL), ('2', '1', 'Q', 'q', 'q', '1', 0, 0, 5);`);
  const insert = db.prepare(`INSERT INTO tasks (id, project_id, workspace_id, title, title_fold, status, labels_fold, assignee_id, creator_id,
      due_date, created_at, updated_at, deleted_at) VALUES (?, ?, '1', 't', 't', ?, ?, ?, '1', ?, ?, ?, ?)`);
  insert.run('1', '1', 'open', '["bug"]', '1', '2026-05-01', 10, 10, null);
  insert.run('2', '1', 'done', '["bug","ui"]', null, '2026-05-01', 10, 30, null);
  insert.run('3', '1', 'open', '[]', null, null, 20, 20, null);
  insert.run('4', '1', 'open', '[]', null, '2026-06-01', 20, 20, 7);
  insert.run('5', '2', 'open', '[]', null, null, 30, 30, 7);

  return db;
}

function ids(db: DatabaseSync, query: Record<string, unknown>, after: unknown[] | null = null): number[] {
  const { sql, params } = taskListSql({ scope: { column: 'workspace_id', id: '1' }, query: { sort: 'created_at', ...query }, after, limit: 10, me: ME, now: NOW });

  return db.prepare(sql).all(...params).map((r) => Number(r.id));
}

test('task lists sort with id following the sort direction and due dates nulls last', () => {
  const db = seeded();
  assert.deepEqual(ids(db, {}), [3, 2, 1]);
  assert.deepEqual(ids(db, { sort: 'updated_at' }), [2, 3, 1]);
  assert.deepEqual(ids(db, { sort: 'due_date' }), [1, 2, 3]);
  assert.deepEqual(ids(db, { sort: 'due_date' }, sortOf({ sort: 'due_date' }).keyOf({ id: 1, due_date: '2026-05-01' } as never)), [2, 3]);
});

test('task list filters combine; include_deleted keeps tasks hidden by a deleted project out', () => {
  const db = seeded();
  assert.deepEqual(ids(db, { include_deleted: true }), [4, 3, 2, 1]);
  assert.deepEqual(ids(db, { label: ['BUG'], status: ['open'] }), [1]);
  assert.deepEqual(ids(db, { assignee_id: 'me' }), [1]);
  assert.deepEqual(ids(db, { assignee_id: 'none', overdue: false }), [3, 2]);
  assert.deepEqual(ids(db, { overdue: true }), [1]);
  assert.deepEqual(ids(db, { due_before: '2026-05-01', due_after: '2026-05-01' }), [2, 1]);
});

test('changes list only requested fields whose value changed', () => {
  const before = { title: 'a', labels: ['x'], budget: null };
  const after = { title: 'a', labels: ['x', 'y'], budget: null };
  assert.deepEqual(changesBetween(before, after, ['title', 'labels', 'budget']), { labels: { from: ['x'], to: ['x', 'y'] } });
});
