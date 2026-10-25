import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent, type ActivityType } from '../../domain/events.ts';
import { assertLive, assertRole, loadProject } from '../../domain/load.ts';
import type { ProjectRow, UserRow } from '../../domain/rows.ts';
import { projectSlugTaken, slugTaken } from '../../domain/slugs.ts';
import { noContent, ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { assertDeleted, assertVersion } from '../tasks/guards.ts';
import { serializeProject } from './serialize.ts';
import type { Id } from '../../ids/uuid.ts';

function reload(db: DatabaseSync, id: Id): ProjectRow {
  return one<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', id)!;
}

function record(ctx: Ctx, me: UserRow, type: ActivityType, project: ProjectRow): Record<string, unknown> {
  const body = serializeProject(project);
  recordEvent(ctx.db, ctx.now, me, { workspaceId: project.workspace_id, type, target: { type: 'project', id: project.id }, data: { project: body } });

  return body;
}

export function deleteProject(ctx: Ctx): Result {
  const { workspace, project, role } = loadProject(ctx, ctx.params.id);
  assertLive(workspace, project);
  assertRole(role, 'admin');
  assertVersion(ctx.input().ifMatch, project.version);
  const me = ctx.me();

  return immediate(ctx.db, () => {
    audited(ctx.db, ctx.now, { type: 'project', id: project.id }, 'delete', () =>
      run(ctx.db, 'UPDATE projects SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?', ctx.now, ctx.now, project.id),
    );
    record(ctx, me, 'project.deleted', reload(ctx.db, project.id));

    return noContent();
  });
}

export function restoreProject(ctx: Ctx): Result {
  const { workspace, project, role } = loadProject(ctx, ctx.params.id);
  assertRole(role, 'admin');
  assertLive(workspace);
  assertDeleted(project);
  ctx.input();
  const me = ctx.me();

  return immediate(ctx.db, () => {
    if (projectSlugTaken(ctx.db, workspace.id, project.slug, project.id)) throw slugTaken();
    audited(ctx.db, ctx.now, { type: 'project', id: project.id }, 'restore', () =>
      run(ctx.db, 'UPDATE projects SET deleted_at = NULL, version = version + 1, updated_at = ? WHERE id = ?', ctx.now, project.id),
    );
    const restored = reload(ctx.db, project.id);

    return ok(record(ctx, me, 'project.restored', restored), restored.version);
  });
}
