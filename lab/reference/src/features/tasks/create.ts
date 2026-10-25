import type { DatabaseSync } from 'node:sqlite';
import { auditCreated } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { isAssignable } from '../../domain/access.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive, assertRole, loadProject } from '../../domain/load.ts';
import type { ProjectRow, TaskRow } from '../../domain/rows.ts';
import { detail, throwIfInvalid } from '../../http/errors.ts';
import { created } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody, type ValuesOf } from '../../http/validate.ts';
import { fold } from '../../text/normalize.ts';
import { budgetColumns, completedAtFor, foldOrNull, labelColumns } from './columns.ts';
import { TASK_CREATE_FIELDS } from './fields.ts';
import { notifyAssigned } from './notify.ts';
import { serializeTaskFor } from './serialize.ts';
import { newId, type Id } from '../../ids/uuid.ts';

type TaskValues = ValuesOf<typeof TASK_CREATE_FIELDS>;

function insertTask(db: DatabaseSync, project: ProjectRow, v: TaskValues, creatorId: Id, now: number): TaskRow {
  const status = v.status ?? 'open';
  const description = v.description ?? null;
  const labels = labelColumns(v.labels ?? []);
  const budget = budgetColumns(v.budget ?? null);
  const id = newId(now);
  run(
    db,
    `INSERT INTO tasks (id, project_id, workspace_id, title, title_fold, description, description_fold, status, labels, labels_fold,
       assignee_id, creator_id, due_date, estimate_minutes, budget_currency, budget_minor, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    project.id,
    project.workspace_id,
    v.title!,
    fold(v.title!),
    description,
    foldOrNull(description),
    status,
    labels.labels,
    labels.labels_fold,
    v.assignee_id ?? null,
    creatorId,
    v.due_date ?? null,
    v.estimate_minutes ?? null,
    budget.budget_currency,
    budget.budget_minor,
    completedAtFor(status, null, now),
    now,
    now,
  );

  return one<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ?', id)!;
}

export function createTask(ctx: Ctx): Result {
  const { workspace, project, role } = loadProject(ctx, ctx.params.id);
  assertLive(workspace, project);
  assertRole(role, 'member');
  const { values, details } = validateBody(ctx.input().body, TASK_CREATE_FIELDS, { required: ['title'] });
  const me = ctx.me();

  return immediate(ctx.db, () => {
    if (typeof values.assignee_id === 'string' && !isAssignable(ctx.db, workspace.id, values.assignee_id)) {
      details.push(detail('assignee_id', 'not_assignable'));
    }
    throwIfInvalid(details);
    const task = insertTask(ctx.db, project, values, me.id, ctx.now);
    auditCreated(ctx.db, ctx.now, { type: 'task', id: task.id });
    const body = serializeTaskFor(ctx, task);
    const eventId = recordEvent(ctx.db, ctx.now, me, { workspaceId: workspace.id, type: 'task.created', target: { type: 'task', id: task.id }, data: { task: body } });
    notifyAssigned(ctx.db, ctx.now, task, me, eventId);

    return created(body, task.version);
  });
}
