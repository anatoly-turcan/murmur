import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { isAssignable } from '../../domain/access.ts';
import { recordEvent, type ActivityType } from '../../domain/events.ts';
import { assertLive, loadTask } from '../../domain/load.ts';
import { atLeast } from '../../domain/roles.ts';
import type { Role, TaskRow, UserRow } from '../../domain/rows.ts';
import { forbidden } from '../../http/errors.ts';
import { noContent, ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { assertDeleted, assertVersion } from './guards.ts';
import { serializeTaskFor } from './serialize.ts';
import type { Id } from '../../ids/uuid.ts';

function assertCanManage(role: Role, task: TaskRow, userId: Id): void {
  const involved = task.creator_id === userId || task.assignee_id === userId;
  if (!atLeast(role, 'admin') && !(role === 'member' && involved)) throw forbidden();
}

function reload(db: DatabaseSync, id: Id): TaskRow {
  return one<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ?', id)!;
}

function record(ctx: Ctx, me: UserRow, type: ActivityType, task: TaskRow): Record<string, unknown> {
  const body = serializeTaskFor(ctx, task);
  recordEvent(ctx.db, ctx.now, me, { workspaceId: task.workspace_id, type, target: { type: 'task', id: task.id }, data: { task: body } });

  return body;
}

function restoredAssignee(db: DatabaseSync, task: TaskRow): Id | null {
  return task.assignee_id !== null && isAssignable(db, task.workspace_id, task.assignee_id) ? task.assignee_id : null;
}

export function deleteTask(ctx: Ctx): Result {
  const { workspace, project, task, role } = loadTask(ctx, ctx.params.id);
  assertLive(workspace, project, task);
  const me = ctx.me();
  assertCanManage(role, task, me.id);
  assertVersion(ctx.input().ifMatch, task.version);

  return immediate(ctx.db, () => {
    audited(ctx.db, ctx.now, { type: 'task', id: task.id }, 'delete', () =>
      run(ctx.db, 'UPDATE tasks SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?', ctx.now, ctx.now, task.id),
    );
    record(ctx, me, 'task.deleted', reload(ctx.db, task.id));

    return noContent();
  });
}

export function restoreTask(ctx: Ctx): Result {
  const { workspace, project, task, role } = loadTask(ctx, ctx.params.id);
  const me = ctx.me();
  assertCanManage(role, task, me.id);
  assertLive(workspace, project);
  assertDeleted(task);
  ctx.input();

  return immediate(ctx.db, () => {
    audited(ctx.db, ctx.now, { type: 'task', id: task.id }, 'restore', () =>
      run(
        ctx.db,
        'UPDATE tasks SET deleted_at = NULL, assignee_id = ?, version = version + 1, updated_at = ? WHERE id = ?',
        restoredAssignee(ctx.db, task),
        ctx.now,
        task.id,
      ),
    );
    const restored = reload(ctx.db, task.id);

    return ok(record(ctx, me, 'task.restored', restored), restored.version);
  });
}
