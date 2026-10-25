import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent, type Changes } from '../../domain/events.ts';
import { assertLive, assertRole, loadWorkspace } from '../../domain/load.ts';
import type { WorkspaceRow } from '../../domain/rows.ts';
import { slugTaken, workspaceSlugTaken } from '../../domain/slugs.ts';
import { throwIfInvalid, versionConflict } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody, type ValuesOf } from '../../http/validate.ts';
import { slugKey } from '../../text/slug.ts';
import { WORKSPACE_FIELDS } from './fields.ts';
import { serializeWorkspace } from './serialize.ts';
import type { Id } from '../../ids/uuid.ts';

type WorkspacePatch = ValuesOf<typeof WORKSPACE_FIELDS>;

export function assertVersion(ifMatch: number | null, version: number): void {
  if (ifMatch !== null && ifMatch !== version) throw versionConflict(version);
}

export function reloadWorkspace(db: DatabaseSync, id: Id): WorkspaceRow {
  return one<WorkspaceRow>(db, 'SELECT * FROM workspaces WHERE id = ?', id)!;
}

function workspaceChanges(ws: WorkspaceRow, patch: WorkspacePatch): Changes {
  const changes: Changes = {};
  for (const key of ['name', 'slug'] as const) {
    const to = patch[key];
    if (to !== undefined && to !== ws[key]) changes[key] = { from: ws[key], to };
  }

  return changes;
}

function writePatch(db: DatabaseSync, ws: WorkspaceRow, patch: WorkspacePatch, now: number): void {
  const slug = patch.slug ?? ws.slug;
  run(
    db,
    'UPDATE workspaces SET name = ?, slug = ?, slug_key = ?, version = version + 1, updated_at = ? WHERE id = ?',
    patch.name ?? ws.name,
    slug,
    slugKey(slug),
    now,
    ws.id,
  );
}

export function updateWorkspace(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  assertRole(role, 'admin');
  const { body, ifMatch } = ctx.input();
  const { values, details } = validateBody(body, WORKSPACE_FIELDS);
  throwIfInvalid(details);
  const me = ctx.me();

  return immediate(ctx.db, () => {
    const ws = reloadWorkspace(ctx.db, workspace.id);
    assertVersion(ifMatch, ws.version);
    if (values.slug !== undefined && workspaceSlugTaken(ctx.db, values.slug, ws.id)) throw slugTaken();
    audited(ctx.db, ctx.now, { type: 'workspace', id: ws.id }, 'update', () => writePatch(ctx.db, ws, values, ctx.now));
    const changes = workspaceChanges(ws, values);
    recordEvent(ctx.db, ctx.now, me, { workspaceId: ws.id, type: 'workspace.updated', target: { type: 'workspace', id: ws.id }, changes });
    const updated = reloadWorkspace(ctx.db, ws.id);

    return ok(serializeWorkspace(updated, role), updated.version);
  });
}
