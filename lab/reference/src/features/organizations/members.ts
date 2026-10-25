import type { DatabaseSync } from 'node:sqlite';
import { auditCreated, audited } from '../../audit/record.ts';
import { all, one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { assertLive } from '../../domain/load.ts';
import { recordOrgEvent } from '../../domain/org-events.ts';
import { assertOrgRole, loadOrganization, ORG_MANAGERS, orgRoleOf } from '../../domain/orgs.ts';
import type { OrgRole, UserRow } from '../../domain/rows.ts';
import { conflict, detail, forbidden, notFound, throwIfInvalid } from '../../http/errors.ts';
import { created, noContent, ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody } from '../../http/validate.ts';
import { emailKey } from '../../text/email.ts';
import { ORG_MEMBER_ADD_FIELDS, ORG_ROLE_FIELDS } from './fields.ts';
import { assertOwnsNoOrgWorkspace, removeFromOrganization } from './removal.ts';
import { loadOrgMember, ORG_MEMBER_SELECT, serializeOrgMember, type OrgMemberRow } from './serialize.ts';
import { addOrgMembership, orgSoleOwner } from './store.ts';
import type { Id } from '../../ids/uuid.ts';

function activeUserByEmail(db: DatabaseSync, address: string): UserRow | undefined {
  return one<UserRow>(db, 'SELECT * FROM users WHERE email_key = ? AND deactivated_at IS NULL', emailKey(address));
}

function targetOrgMember(ctx: Ctx, organizationId: Id, userId: Id): OrgMemberRow {
  const member = loadOrgMember(ctx.db, organizationId, userId);
  if (!member) throw notFound();

  return member;
}

function protectOwner(actorRole: OrgRole, target: OrgMemberRow): void {
  if (target.role !== 'org_owner') return;

  throw actorRole === 'org_owner' ? orgSoleOwner() : forbidden();
}

export function listOrgMembers(ctx: Ctx): Result {
  const { org } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  const { limit, after } = ctx.page();
  const [joined, userId] = (after ?? [null, null]) as [number | null, number | null];
  const rows = all<OrgMemberRow>(
    ctx.db,
    `${ORG_MEMBER_SELECT} WHERE om.organization_id = ?1
        AND (?2 IS NULL OR om.joined_at > ?2 OR (om.joined_at = ?2 AND om.user_id > ?3))
      ORDER BY om.joined_at, om.user_id LIMIT ?4`,
    org.id,
    joined,
    userId,
    limit + 1,
  );

  return ok(ctx.pageOf(rows, (r) => [r.joined_at, r.user_id], serializeOrgMember));
}

export function enrollOrgMember(db: DatabaseSync, now: number, actor: UserRow, organizationId: Id, userId: Id, role: OrgRole): Record<string, unknown> {
  addOrgMembership(db, organizationId, userId, role, now);
  auditCreated(db, now, { type: 'org_member', id: userId, parentId: organizationId });
  const item = serializeOrgMember(loadOrgMember(db, organizationId, userId)!);
  recordOrgEvent(db, now, actor, { organizationId, type: 'org_member.added', target: { type: 'org_member', id: userId }, data: { member: item } });

  return item;
}

export function addOrgMember(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  assertOrgRole(role, ORG_MANAGERS);
  const { values, details } = validateBody(ctx.input().body, ORG_MEMBER_ADD_FIELDS, { required: ['email', 'role'] });
  const user = values.email === undefined ? undefined : activeUserByEmail(ctx.db, values.email);
  if (values.email !== undefined && !user) details.push(detail('email', 'user_not_found'));
  throwIfInvalid(details);

  return immediate(ctx.db, () => {
    if (orgRoleOf(ctx.db, org.id, user!.id)) throw conflict('already_member', 'The user is already a member of this organization.');

    return created(enrollOrgMember(ctx.db, ctx.now, ctx.me(), org.id, user!.id, values.role!));
  });
}

function applyRole(ctx: Ctx, member: OrgMemberRow, role: OrgRole | undefined): OrgMemberRow {
  if (role === undefined || role === member.role) return member;
  run(ctx.db, 'UPDATE org_memberships SET role = ? WHERE organization_id = ? AND user_id = ?', role, member.organization_id, member.user_id);
  const updated = loadOrgMember(ctx.db, member.organization_id, member.user_id)!;
  recordOrgEvent(ctx.db, ctx.now, ctx.me(), {
    organizationId: member.organization_id,
    type: 'org_member.role_changed',
    target: { type: 'org_member', id: member.user_id },
    changes: { role: { from: member.role, to: role } },
    data: { member: serializeOrgMember(updated) },
  });

  return updated;
}

export function changeOrgRole(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  assertOrgRole(role, ORG_MANAGERS);
  const member = targetOrgMember(ctx, org.id, ctx.params.user_id);
  protectOwner(role, member);
  const { values, details } = validateBody(ctx.input().body, ORG_ROLE_FIELDS);
  throwIfInvalid(details);

  const ref = { type: 'org_member', id: member.user_id, parentId: org.id } as const;

  return ok(serializeOrgMember(audited(ctx.db, ctx.now, ref, 'update', () => applyRole(ctx, member, values.role))));
}

export function removeOrgMember(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  const leaving = ctx.params.user_id === ctx.me().id;
  if (!leaving) assertOrgRole(role, ORG_MANAGERS);
  const member = targetOrgMember(ctx, org.id, ctx.params.user_id);
  protectOwner(role, member);
  ctx.input();
  immediate(ctx.db, () => {
    assertOwnsNoOrgWorkspace(ctx.db, org.id, member.user_id);
    removeFromOrganization(ctx.db, ctx.now, ctx.me(), member);
  });

  return noContent();
}
