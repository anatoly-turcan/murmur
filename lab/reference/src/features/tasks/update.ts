import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { isAssignable } from '../../domain/access.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive, assertRole, loadTask } from '../../domain/load.ts';
import type { TaskRow, UserRow } from '../../domain/rows.ts';
import { detail, throwIfInvalid, type Detail } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { has, validateBody, type ValuesOf } from '../../http/validate.ts';
import { fold } from '../../text/normalize.ts';
import { budgetColumns, completedAtFor, foldOrNull, labelColumns } from './columns.ts';
import { changesBetween } from './diff.ts';
import { TASK_PATCH_FIELDS } from './fields.ts';
import { assertVersion } from './guards.ts';
import { notifyAssigned } from './notify.ts';
import { serializeTaskFor } from './serialize.ts';
import type { Id } from '../../ids/uuid.ts';

type PatchValues = ValuesOf<typeof TASK_PATCH_FIELDS>;

function isLiveProjectOf(db: DatabaseSync, workspaceId: Id, projectId: Id): boolean {
  return one(db, 'SELECT 1 AS x FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', projectId, workspaceId) !== undefined;
}

function relationDetails(db: DatabaseSync, workspaceId: Id, v: PatchValues): Detail[] {
  const details: Detail[] = [];
  if (typeof v.assignee_id === 'string' && !isAssignable(db, workspaceId, v.assignee_id)) details.push(detail('assignee_id', 'not_assignable'));
  if (v.project_id !== undefined && !isLiveProjectOf(db, workspaceId, v.project_id)) details.push(detail('project_id', 'invalid_project'));

  return details;
}

function patchColumns(v: PatchValues): Partial<TaskRow> {
  return {
    ...(has(v, 'title') ? { title: v.title!, title_fold: fold(v.title!) } : {}),
    ...(has(v, 'description') ? { description: v.description ?? null, description_fold: foldOrNull(v.description ?? null) } : {}),
    ...(has(v, 'status') ? { status: v.status! } : {}),
    ...(has(v, 'labels') ? labelColumns(v.labels!) : {}),
    ...(has(v, 'assignee_id') ? { assignee_id: v.assignee_id ?? null } : {}),
    ...(has(v, 'due_date') ? { due_date: v.due_date ?? null } : {}),
    ...(has(v, 'estimate_minutes') ? { estimate_minutes: v.estimate_minutes ?? null } : {}),
    ...(has(v, 'budget') ? budgetColumns(v.budget ?? null) : {}),
    ...(has(v, 'project_id') ? { project_id: v.project_id! } : {}),
  };
}

function patchedTask(task: TaskRow, v: PatchValues, now: number): TaskRow {
  const next: TaskRow = { ...task, ...patchColumns(v), version: task.version + 1, updated_at: now };

  return { ...next, completed_at: completedAtFor(next.status, task.completed_at, now) };
}

function writeTask(db: DatabaseSync, t: TaskRow): void {
  run(
    db,
    `UPDATE tasks SET project_id = ?, title = ?, title_fold = ?, description = ?, description_fold = ?, status = ?, labels = ?,
       labels_fold = ?, assignee_id = ?, due_date = ?, estimate_minutes = ?, budget_currency = ?, budget_minor = ?, completed_at = ?,
       version = ?, updated_at = ?
     WHERE id = ?`,
    t.project_id,
    t.title,
    t.title_fold,
    t.description,
    t.description_fold,
    t.status,
    t.labels,
    t.labels_fold,
    t.assignee_id,
    t.due_date,
    t.estimate_minutes,
    t.budget_currency,
    t.budget_minor,
    t.completed_at,
    t.version,
    t.updated_at,
    t.id,
  );
}

function recordUpdate(ctx: Ctx, me: UserRow, before: TaskRow, after: TaskRow, fields: string[]): Record<string, unknown> {
  const body = serializeTaskFor(ctx, after);
  const changes = changesBetween(serializeTaskFor(ctx, before), body, fields);
  const eventId = recordEvent(ctx.db, ctx.now, me, {
    workspaceId: after.workspace_id,
    type: 'task.updated',
    target: { type: 'task', id: after.id },
    changes,
    data: { task: body, changes },
  });
  if (changes.assignee_id) notifyAssigned(ctx.db, ctx.now, after, me, eventId);

  return body;
}

export function updateTask(ctx: Ctx): Result {
  const { workspace, project, task, role } = loadTask(ctx, ctx.params.id);
  assertLive(workspace, project, task);
  assertRole(role, 'member');
  const { body, ifMatch } = ctx.input();
  const { values, details } = validateBody(body, TASK_PATCH_FIELDS);
  const me = ctx.me();

  return immediate(ctx.db, () => {
    throwIfInvalid([...details, ...relationDetails(ctx.db, workspace.id, values)]);
    assertVersion(ifMatch, task.version);
    const next = patchedTask(task, values, ctx.now);
    audited(ctx.db, ctx.now, { type: 'task', id: task.id }, 'update', () => writeTask(ctx.db, next));

    return ok(recordUpdate(ctx, me, task, next, Object.keys(values)), next.version);
  });
}
