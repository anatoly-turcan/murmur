import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { all, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { cancelOrganizationDeliveries } from '../../domain/deliveries.ts';
import { assertLive } from '../../domain/load.ts';
import { recordOrgEvent } from '../../domain/org-events.ts';
import { assertOrgRole, loadOrganization, OWNER_ONLY, reloadOrganization } from '../../domain/orgs.ts';
import type { OrganizationRow, UserRow, WorkspaceRow } from '../../domain/rows.ts';
import { slugTaken, workspaceSlugTaken } from '../../domain/slugs.ts';
import { conflict } from '../../http/errors.ts';
import { noContent, ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { restoreWorkspaceRow, softDeleteWorkspace } from '../workspaces/lifecycle.ts';
import { assertVersion } from '../workspaces/update.ts';
import { serializeOrganization } from './serialize.ts';
import { orgSlugTaken } from './store.ts';
import type { Id } from '../../ids/uuid.ts';

function setDeletedAt(db: DatabaseSync, id: Id, deletedAt: number | null, now: number): void {
  run(db, 'UPDATE organizations SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?', deletedAt, now, id);
}

function liveWorkspaceIds(db: DatabaseSync, organizationId: Id): Id[] {
  return all<{ id: Id }>(db, 'SELECT id FROM workspaces WHERE organization_id = ? AND deleted_at IS NULL ORDER BY id', organizationId).map((r) => r.id);
}

function cascadedWorkspaces(db: DatabaseSync, org: OrganizationRow): WorkspaceRow[] {
  return all<WorkspaceRow>(db, 'SELECT * FROM workspaces WHERE organization_id = ? AND deleted_at = ? ORDER BY id', org.id, org.deleted_at);
}

function recordLifecycle(db: DatabaseSync, now: number, actor: UserRow, id: Id, type: 'organization.deleted' | 'organization.restored'): void {
  const data = { organization: serializeOrganization(reloadOrganization(db, id)) };
  recordOrgEvent(db, now, actor, { organizationId: id, type, target: { type: 'organization', id }, data });
}

export function deleteOrganization(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  assertOrgRole(role, OWNER_ONLY);
  const { ifMatch } = ctx.input();
  const me = ctx.me();
  immediate(ctx.db, () => {
    assertVersion(ifMatch, reloadOrganization(ctx.db, org.id).version);
    for (const id of liveWorkspaceIds(ctx.db, org.id)) softDeleteWorkspace(ctx.db, ctx.now, me, id);
    cancelOrganizationDeliveries(ctx.db, org.id, ctx.now);
    audited(ctx.db, ctx.now, { type: 'organization', id: org.id }, 'delete', () => setDeletedAt(ctx.db, org.id, ctx.now, ctx.now));
    recordLifecycle(ctx.db, ctx.now, me, org.id, 'organization.deleted');
  });

  return noContent();
}

export function restoreOrganization(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertOrgRole(role, OWNER_ONLY);
  ctx.input();
  const me = ctx.me();

  return immediate(ctx.db, () => {
    const current = reloadOrganization(ctx.db, org.id);
    if (current.deleted_at === null) throw conflict('not_deleted', 'The organization is not deleted.');
    if (orgSlugTaken(ctx.db, current.slug, current.id)) throw slugTaken();
    const spaces = cascadedWorkspaces(ctx.db, current);
    if (spaces.some((ws) => workspaceSlugTaken(ctx.db, ws.slug, ws.id))) throw slugTaken();
    audited(ctx.db, ctx.now, { type: 'organization', id: current.id }, 'restore', () => setDeletedAt(ctx.db, current.id, null, ctx.now));
    for (const ws of spaces) restoreWorkspaceRow(ctx.db, ctx.now, me, ws.id);
    recordLifecycle(ctx.db, ctx.now, me, current.id, 'organization.restored');
    const restored = reloadOrganization(ctx.db, current.id);

    return ok(serializeOrganization(restored), restored.version);
  });
}
