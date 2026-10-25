import { all } from '../../db/sql.ts';
import { assertLive, assertRole, loadProject, loadWorkspace } from '../../domain/load.ts';
import type { Role, TaskRow } from '../../domain/rows.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { sortOf, taskListSql, type TaskListScope } from './list-query.ts';
import { serializeTaskFor } from './serialize.ts';

function listTasks(ctx: Ctx, role: Role, scope: TaskListScope): Result {
  const { query } = ctx.input();
  if (query.include_deleted === true) assertRole(role, 'admin');
  const { limit, after } = ctx.page();
  const { sql, params } = taskListSql({ scope, query, after, limit, me: ctx.me(), now: ctx.now });
  const rows = all<TaskRow>(ctx.db, sql, ...params);

  return ok(ctx.pageOf(rows, sortOf(query).keyOf, (task) => serializeTaskFor(ctx, task)));
}

export function listProjectTasks(ctx: Ctx): Result {
  const { workspace, project, role } = loadProject(ctx, ctx.params.id);
  assertLive(workspace, project);

  return listTasks(ctx, role, { column: 'project_id', id: project.id });
}

export function listWorkspaceTasks(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);

  return listTasks(ctx, role, { column: 'workspace_id', id: workspace.id });
}
