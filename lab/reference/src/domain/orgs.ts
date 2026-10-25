import type { DatabaseSync } from 'node:sqlite';
import { one } from '../db/sql.ts';
import { forbidden, notFound } from '../http/errors.ts';
import type { Ctx } from '../http/types.ts';
import type { OrganizationRow, OrgRole, Role } from './rows.ts';
import type { Id } from '../ids/uuid.ts';

export const ORG_ROLES: readonly OrgRole[] = ['org_owner', 'org_admin', 'billing', 'org_member'];
export const ORG_MANAGERS: readonly OrgRole[] = ['org_owner', 'org_admin'];
export const PLAN_MANAGERS: readonly OrgRole[] = ['org_owner', 'billing'];
export const WORKSPACE_CREATORS: readonly OrgRole[] = ['org_owner', 'org_admin', 'org_member'];
export const OWNER_ONLY: readonly OrgRole[] = ['org_owner'];

export interface OrgChain {
  org: OrganizationRow;
  role: OrgRole;
}

export function orgRoleOf(db: DatabaseSync, organizationId: Id, userId: Id): OrgRole | null {
  return (
    one<{ role: OrgRole }>(db, 'SELECT role FROM org_memberships WHERE organization_id = ? AND user_id = ?', organizationId, userId)?.role ?? null
  );
}

export function reloadOrganization(db: DatabaseSync, id: Id): OrganizationRow {
  return one<OrganizationRow>(db, 'SELECT * FROM organizations WHERE id = ?', id)!;
}

export function findMembership(db: DatabaseSync, organizationId: Id, userId: Id): OrgChain | null {
  const row = one<OrganizationRow & { my_role: OrgRole }>(
    db,
    `SELECT o.*, om.role AS my_role FROM organizations o
       JOIN org_memberships om ON om.organization_id = o.id AND om.user_id = ? WHERE o.id = ?`,
    userId,
    organizationId,
  );
  if (!row) return null;
  const { my_role: role, ...org } = row;

  return { org, role };
}

export function loadOrganization(ctx: Ctx, id: Id): OrgChain {
  const chain = findMembership(ctx.db, id, ctx.me().id);
  if (!chain) throw notFound();

  return chain;
}

export function assertOrgRole(role: OrgRole, allowed: readonly OrgRole[]): void {
  if (!allowed.includes(role)) throw forbidden();
}

export function readsEveryWorkspace(role: OrgRole | null): boolean {
  return role !== null && ORG_MANAGERS.includes(role);
}

export function workspaceRoleFor(memberRole: Role | null, orgRole: OrgRole | null): Role | null {
  return memberRole ?? (readsEveryWorkspace(orgRole) ? 'viewer' : null);
}
