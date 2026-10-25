import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { all, one, run } from '../../db/sql.ts';
import { recordEvent } from '../../domain/events.ts';
import type { TaskRow, UserRow } from '../../domain/rows.ts';
import { serializeTask } from '../tasks/serialize.ts';
import type { Id } from '../../ids/uuid.ts';

function assignedLiveTasks(db: DatabaseSync, workspaceId: Id, userId: Id): TaskRow[] {
  return all<TaskRow>(
    db,
    'SELECT * FROM tasks WHERE workspace_id = ? AND assignee_id = ? AND deleted_at IS NULL ORDER BY id',
    workspaceId,
    userId,
  );
}

function clearAssignee(db: DatabaseSync, taskId: Id, now: number): TaskRow {
  run(db, 'UPDATE tasks SET assignee_id = NULL, version = version + 1, updated_at = ? WHERE id = ?', now, taskId);

  return one<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ?', taskId)!;
}

export function unassignUserTasks(db: DatabaseSync, now: number, actor: UserRow, workspaceId: Id, userId: Id): number {
  const tasks = assignedLiveTasks(db, workspaceId, userId);
  for (const task of tasks) {
    const updated = audited(db, now, { type: 'task', id: task.id }, 'update', () => clearAssignee(db, task.id, now));
    const changes = { assignee_id: { from: userId, to: null } };
    recordEvent(db, now, actor, {
      workspaceId,
      type: 'task.updated',
      target: { type: 'task', id: task.id },
      changes,
      data: { task: serializeTask(updated, actor.timezone, now), changes },
    });
  }

  return tasks.length;
}
