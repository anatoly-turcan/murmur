import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive, assertRole, loadProject } from '../../domain/load.ts';
import type { ProjectRow } from '../../domain/rows.ts';
import { projectSlugTaken, slugTaken } from '../../domain/slugs.ts';
import { throwIfInvalid } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { has, validateBody, type ValuesOf } from '../../http/validate.ts';
import { slugKey } from '../../text/slug.ts';
import { changesBetween } from '../tasks/diff.ts';
import { assertVersion } from '../tasks/guards.ts';
import { PROJECT_FIELDS } from './fields.ts';
import { serializeProject } from './serialize.ts';

type ProjectValues = ValuesOf<typeof PROJECT_FIELDS>;

function patchedProject(project: ProjectRow, v: ProjectValues, now: number): ProjectRow {
  return {
    ...project,
    ...(has(v, 'name') ? { name: v.name! } : {}),
    ...(has(v, 'slug') ? { slug: v.slug!, slug_key: slugKey(v.slug!) } : {}),
    ...(has(v, 'description') ? { description: v.description ?? null } : {}),
    version: project.version + 1,
    updated_at: now,
  };
}

function writeProject(db: DatabaseSync, p: ProjectRow): void {
  run(
    db,
    'UPDATE projects SET name = ?, slug = ?, slug_key = ?, description = ?, version = ?, updated_at = ? WHERE id = ?',
    p.name,
    p.slug,
    p.slug_key,
    p.description,
    p.version,
    p.updated_at,
    p.id,
  );
}

export function updateProject(ctx: Ctx): Result {
  const { workspace, project, role } = loadProject(ctx, ctx.params.id);
  assertLive(workspace, project);
  assertRole(role, 'member');
  const { body, ifMatch } = ctx.input();
  const { values, details } = validateBody(body, PROJECT_FIELDS);
  throwIfInvalid(details);
  const me = ctx.me();

  return immediate(ctx.db, () => {
    assertVersion(ifMatch, project.version);
    if (values.slug !== undefined && projectSlugTaken(ctx.db, workspace.id, values.slug, project.id)) throw slugTaken();
    const next = patchedProject(project, values, ctx.now);
    audited(ctx.db, ctx.now, { type: 'project', id: project.id }, 'update', () => writeProject(ctx.db, next));
    const after = serializeProject(next);
    const changes = changesBetween(serializeProject(project), after, Object.keys(values));
    recordEvent(ctx.db, ctx.now, me, {
      workspaceId: workspace.id,
      type: 'project.updated',
      target: { type: 'project', id: project.id },
      changes,
      data: { project: after, changes },
    });

    return ok(after, next.version);
  });
}
