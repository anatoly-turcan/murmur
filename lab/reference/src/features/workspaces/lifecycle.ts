import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { cancelOpenDeliveries } from '../../domain/deliveries.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive, assertRole, loadWorkspace } from '../../domain/load.ts';
import type { UserRow } from '../../domain/rows.ts';
import { slugTaken, workspaceSlugTaken } from '../../domain/slugs.ts';
import { conflict, gone } from '../../http/errors.ts';
import { noContent, ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeWorkspace } from './serialize.ts';
import { assertVersion, reloadWorkspace } from './update.ts';
import type { Id } from '../../ids/uuid.ts';

function setDeletedAt(db: DatabaseSync, id: Id, deletedAt: number | null, now: number): void {
  run(db, 'UPDATE workspaces SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?', deletedAt, now, id);
}

export function softDeleteWorkspace(db: DatabaseSync, now: number, actor: UserRow, workspaceId: Id): void {
  audited(db, now, { type: 'workspace', id: workspaceId }, 'delete', () => setDeletedAt(db, workspaceId, now, now));
  cancelOpenDeliveries(db, workspaceId, now);
  recordEvent(db, now, actor, { workspaceId, type: 'workspace.deleted', target: { type: 'workspace', id: workspaceId } });
}

export function restoreWorkspaceRow(db: DatabaseSync, now: number, actor: UserRow, workspaceId: Id): void {
  audited(db, now, { type: 'workspace', id: workspaceId }, 'restore', () => setDeletedAt(db, workspaceId, null, now));
  recordEvent(db, now, actor, { workspaceId, type: 'workspace.restored', target: { type: 'workspace', id: workspaceId } });
}

function assertOrganizationLive(db: DatabaseSync, organizationId: Id): void {
  const org = one<{ deleted_at: number | null }>(db, 'SELECT deleted_at FROM organizations WHERE id = ?', organizationId);
  if (org?.deleted_at !== null) throw gone();
}

export function deleteWorkspace(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  assertRole(role, 'owner');
  const { ifMatch } = ctx.input();
  immediate(ctx.db, () => {
    assertVersion(ifMatch, reloadWorkspace(ctx.db, workspace.id).version);
    softDeleteWorkspace(ctx.db, ctx.now, ctx.me(), workspace.id);
  });

  return noContent();
}

export function restoreWorkspace(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertRole(role, 'owner');
  ctx.input();

  return immediate(ctx.db, () => {
    const ws = reloadWorkspace(ctx.db, workspace.id);
    if (ws.deleted_at === null) throw conflict('not_deleted', 'The workspace is not deleted.');
    assertOrganizationLive(ctx.db, ws.organization_id);
    if (workspaceSlugTaken(ctx.db, ws.slug, ws.id)) throw slugTaken();
    restoreWorkspaceRow(ctx.db, ctx.now, ctx.me(), ws.id);
    const restored = reloadWorkspace(ctx.db, ws.id);

    return ok(serializeWorkspace(restored, role), restored.version);
  });
}
