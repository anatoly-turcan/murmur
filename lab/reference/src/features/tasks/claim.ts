import { audited } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive, assertRole, loadTask } from '../../domain/load.ts';
import type { TaskRow } from '../../domain/rows.ts';
import { conflict, type ApiError } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeTaskFor } from './serialize.ts';
import type { Id } from '../../ids/uuid.ts';

function alreadyAssigned(assigneeId: Id | null): ApiError {
  return conflict('already_assigned', 'The task already has an assignee.', [
    { path: 'assignee_id', code: 'already_assigned', assignee_id: assigneeId },
  ]);
}

export function claimTask(ctx: Ctx): Result {
  const { workspace, project, task, role } = loadTask(ctx, ctx.params.id);
  assertLive(workspace, project, task);
  assertRole(role, 'member');
  ctx.input();
  const me = ctx.me();

  return immediate(ctx.db, () => {
    const claimed = audited(ctx.db, ctx.now, { type: 'task', id: task.id }, 'claim', () =>
      run(ctx.db, 'UPDATE tasks SET assignee_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND assignee_id IS NULL', me.id, ctx.now, task.id),
    );
    const current = one<TaskRow>(ctx.db, 'SELECT * FROM tasks WHERE id = ?', task.id)!;
    if (claimed === 0) throw alreadyAssigned(current.assignee_id);
    const body = serializeTaskFor(ctx, current);
    const changes = { assignee_id: { from: null, to: me.id } };
    recordEvent(ctx.db, ctx.now, me, { workspaceId: workspace.id, type: 'task.updated', target: { type: 'task', id: task.id }, changes, data: { task: body, changes } });

    return ok(body, current.version);
  });
}
