import type { DatabaseSync } from 'node:sqlite';
import { auditCreated } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive, assertRole, loadWorkspace } from '../../domain/load.ts';
import type { ProjectRow } from '../../domain/rows.ts';
import { chooseSlug, projectSlugTaken } from '../../domain/slugs.ts';
import { throwIfInvalid } from '../../http/errors.ts';
import { created } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody } from '../../http/validate.ts';
import { slugKey } from '../../text/slug.ts';
import { PROJECT_FIELDS } from './fields.ts';
import { serializeProject } from './serialize.ts';
import { newId, type Id } from '../../ids/uuid.ts';

interface NewProject {
  workspaceId: Id;
  name: string;
  slug: string;
  description: string | null;
  creatorId: Id;
}

function insertProject(db: DatabaseSync, p: NewProject, now: number): ProjectRow {
  const id = newId(now);
  run(
    db,
    `INSERT INTO projects (id, workspace_id, name, slug, slug_key, description, creator_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    p.workspaceId,
    p.name,
    p.slug,
    slugKey(p.slug),
    p.description,
    p.creatorId,
    now,
    now,
  );

  return one<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', id)!;
}

export function createProject(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  assertRole(role, 'member');
  const { values, details } = validateBody(ctx.input().body, PROJECT_FIELDS, { required: ['name'] });
  throwIfInvalid(details);
  const me = ctx.me();

  return immediate(ctx.db, () => {
    const slug = chooseSlug(values.slug, values.name!, 'project', (s) => projectSlugTaken(ctx.db, workspace.id, s));
    const project = insertProject(ctx.db, { workspaceId: workspace.id, name: values.name!, slug, description: values.description ?? null, creatorId: me.id }, ctx.now);
    auditCreated(ctx.db, ctx.now, { type: 'project', id: project.id });
    const body = serializeProject(project);
    recordEvent(ctx.db, ctx.now, me, { workspaceId: workspace.id, type: 'project.created', target: { type: 'project', id: project.id }, data: { project: body } });

    return created(body, project.version);
  });
}
