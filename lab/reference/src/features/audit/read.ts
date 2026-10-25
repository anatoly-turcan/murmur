import type { DatabaseSync } from 'node:sqlite';
import { one } from '../../db/sql.ts';
import { assertRole, loadWorkspace } from '../../domain/load.ts';
import { assertOrgRole, loadOrganization, orgRoleOf, ORG_MANAGERS, readsEveryWorkspace, workspaceRoleFor } from '../../domain/orgs.ts';
import { atLeast } from '../../domain/roles.ts';
import type { OrgRole, Role } from '../../domain/rows.ts';
import { forbidden, notFound } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import type { Id } from '../../ids/uuid.ts';
import { listAudit } from './query.ts';
import { serializeEntry, type AuditRow } from './serialize.ts';

const MY_ENTRIES = `a.actor_type = 'user' AND a.actor_id = ?
  AND (a.workspace_id IS NULL OR a.workspace_id IN (SELECT workspace_id FROM memberships WHERE user_id = ?))
  AND (a.workspace_id IS NOT NULL OR a.organization_id IS NULL
       OR a.organization_id IN (SELECT organization_id FROM org_memberships WHERE user_id = ?))`;

export function listWorkspaceAudit(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertRole(role, 'admin');

  return ok(listAudit(ctx, { where: 'a.workspace_id = ?', params: [workspace.id] }));
}

export function assertOrgAuditor(ctx: Ctx): Id {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertOrgRole(role, ORG_MANAGERS);

  return org.id;
}

export function listOrganizationAudit(ctx: Ctx): Result {
  const orgId = assertOrgAuditor(ctx);

  return ok(listAudit(ctx, { where: 'a.organization_id = ?', params: [orgId] }));
}

export function listMyAudit(ctx: Ctx): Result {
  const me = ctx.me().id;

  return ok(listAudit(ctx, { where: MY_ENTRIES, params: [me, me, me] }));
}

function workspaceRole(db: DatabaseSync, workspaceId: Id, userId: Id): Role | null {
  const row = one<{ ws_role: Role | null; org_role: OrgRole | null }>(
    db,
    `SELECT m.role AS ws_role, om.role AS org_role FROM workspaces w
       LEFT JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ?1
       LEFT JOIN org_memberships om ON om.organization_id = w.organization_id AND om.user_id = ?1
      WHERE w.id = ?2`,
    userId,
    workspaceId,
  );

  return row ? workspaceRoleFor(row.ws_role, row.org_role) : null;
}

type Visibility = 'visible' | 'forbidden' | 'hidden';

function orgVisibility(db: DatabaseSync, organizationId: Id | null, userId: Id): Visibility {
  const role = organizationId === null ? null : orgRoleOf(db, organizationId, userId);
  if (role === null) return 'hidden';

  return readsEveryWorkspace(role) ? 'visible' : 'forbidden';
}

function visibility(db: DatabaseSync, row: AuditRow, userId: Id): Visibility {
  if (row.workspace_id !== null) {
    if (orgVisibility(db, row.organization_id, userId) === 'visible') return 'visible';
    const role = workspaceRole(db, row.workspace_id, userId);
    if (role === null) return 'hidden';

    return atLeast(role, 'admin') ? 'visible' : 'forbidden';
  }
  if (row.organization_id !== null) return orgVisibility(db, row.organization_id, userId);

  return row.actor_type === 'user' && row.actor_id === userId ? 'visible' : 'hidden';
}

export function getAuditEntry(ctx: Ctx): Result {
  const row = one<AuditRow>(ctx.db, 'SELECT * FROM audit_entries WHERE id = ?', ctx.params.id);
  ctx.input();
  const seen = row ? visibility(ctx.db, row, ctx.me().id) : 'hidden';
  if (seen === 'hidden') throw notFound();
  if (seen === 'forbidden') throw forbidden();

  return ok(serializeEntry(row!));
}
