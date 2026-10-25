import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { assertLive } from '../../domain/load.ts';
import { recordOrgEvent } from '../../domain/org-events.ts';
import { assertOrgRole, loadOrganization, OWNER_ONLY, reloadOrganization } from '../../domain/orgs.ts';
import type { OrganizationRow, OrgRole, UserRow } from '../../domain/rows.ts';
import { detail, throwIfInvalid } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody } from '../../http/validate.ts';
import { ORG_TRANSFER_FIELDS } from './fields.ts';
import { loadOrgMember, serializeOrganization, serializeOrgMember, type OrgMemberRow } from './serialize.ts';
import { orgSoleOwner } from './store.ts';
import type { Id } from '../../ids/uuid.ts';

function transferTarget(ctx: Ctx, organizationId: Id): OrgMemberRow {
  const { values, details } = validateBody(ctx.input().body, ORG_TRANSFER_FIELDS, { required: ['user_id'] });
  const member = values.user_id === undefined ? undefined : loadOrgMember(ctx.db, organizationId, values.user_id);
  if (values.user_id !== undefined && !member) {
    details.push(detail('user_id', 'not_member', { message: 'The user is not a member of this organization.' }));
  }
  throwIfInvalid(details);

  return member!;
}

function setRole(db: DatabaseSync, organizationId: Id, userId: Id, role: OrgRole): void {
  run(db, 'UPDATE org_memberships SET role = ? WHERE organization_id = ? AND user_id = ?', role, organizationId, userId);
}

function recordRoleChange(db: DatabaseSync, now: number, actor: UserRow, organizationId: Id, userId: Id, from: OrgRole): void {
  const member = loadOrgMember(db, organizationId, userId)!;
  recordOrgEvent(db, now, actor, {
    organizationId,
    type: 'org_member.role_changed',
    target: { type: 'org_member', id: userId },
    changes: { role: { from, to: member.role } },
    data: { member: serializeOrgMember(member) },
  });
}

function swapOwner(db: DatabaseSync, now: number, actor: UserRow, org: OrganizationRow, target: OrgMemberRow): void {
  setRole(db, org.id, org.owner_id, 'org_admin');
  setRole(db, org.id, target.user_id, 'org_owner');
  run(db, 'UPDATE organizations SET owner_id = ?, version = version + 1, updated_at = ? WHERE id = ?', target.user_id, now, org.id);
  recordRoleChange(db, now, actor, org.id, target.user_id, target.role);
  recordRoleChange(db, now, actor, org.id, org.owner_id, 'org_owner');
}

function auditedSwap(db: DatabaseSync, now: number, actor: UserRow, org: OrganizationRow, target: OrgMemberRow): void {
  const asMember = (userId: Id, fn: () => void) => () => audited(db, now, { type: 'org_member', id: userId, parentId: org.id }, 'update', fn);
  const swap = () => swapOwner(db, now, actor, org, target);
  audited(db, now, { type: 'organization', id: org.id }, 'transfer', asMember(target.user_id, asMember(org.owner_id, swap)));
}

export function transferOrganization(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  assertOrgRole(role, OWNER_ONLY);
  const target = transferTarget(ctx, org.id);
  if (target.role === 'org_owner') throw orgSoleOwner();

  return immediate(ctx.db, () => {
    auditedSwap(ctx.db, ctx.now, ctx.me(), reloadOrganization(ctx.db, org.id), target);
    const updated = reloadOrganization(ctx.db, org.id);

    return ok(serializeOrganization(updated), updated.version);
  });
}
