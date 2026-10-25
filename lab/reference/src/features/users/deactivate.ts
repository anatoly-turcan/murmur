import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { all, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { cancelOpenDeliveries } from '../../domain/deliveries.ts';
import type { UserRow } from '../../domain/rows.ts';
import { detail } from '../../http/errors.ts';
import { noContent } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { removeMembership, soleOwner } from '../members/remove.ts';
import { removeFromOrganization } from '../organizations/removal.ts';
import { ORG_MEMBER_SELECT, type OrgMemberRow } from '../organizations/serialize.ts';
import { orgSoleOwner } from '../organizations/store.ts';
import { MEMBER_SELECT, type MemberRow } from '../members/serialize.ts';
import type { Id } from '../../ids/uuid.ts';

type MembershipWithState = MemberRow & { ws_deleted: number };

function ownedWorkspaceIds(db: DatabaseSync, userId: Id): Id[] {
  return all<{ id: Id }>(db, 'SELECT id FROM workspaces WHERE owner_id = ? ORDER BY id', userId).map((r) => r.id);
}

function memberships(db: DatabaseSync, userId: Id): MembershipWithState[] {
  return all<MembershipWithState>(
    db,
    `SELECT x.*, w.deleted_at IS NOT NULL AS ws_deleted FROM (${MEMBER_SELECT} WHERE m.user_id = ?) x
       JOIN workspaces w ON w.id = x.workspace_id ORDER BY x.workspace_id`,
    userId,
  );
}

function ownedOrganizationIds(db: DatabaseSync, userId: Id): Id[] {
  return all<{ id: Id }>(db, 'SELECT id FROM organizations WHERE owner_id = ? ORDER BY id', userId).map((r) => r.id);
}

function assertOwnsNothing(db: DatabaseSync, userId: Id): void {
  const owned = ownedWorkspaceIds(db, userId);
  if (owned.length > 0) {
    throw soleOwner([detail('workspaces', 'sole_owner', { workspace_ids: owned, message: 'Transfer ownership of these workspaces first.' })]);
  }
  const orgs = ownedOrganizationIds(db, userId);
  if (orgs.length > 0) {
    throw orgSoleOwner([detail('organizations', 'sole_owner', { organization_ids: orgs, message: 'Transfer ownership of these organizations first.' })]);
  }
}

function leaveOrganizations(db: DatabaseSync, now: number, user: UserRow): void {
  const rows = all<OrgMemberRow>(db, `${ORG_MEMBER_SELECT} WHERE om.user_id = ? ORDER BY om.organization_id`, user.id);
  for (const member of rows) removeFromOrganization(db, now, user, member);
}

function leaveAll(db: DatabaseSync, now: number, user: UserRow): void {
  for (const membership of memberships(db, user.id)) {
    removeMembership(db, now, user, membership);
    if (membership.ws_deleted) cancelOpenDeliveries(db, membership.workspace_id, now);
  }
}

function activeKeyIds(db: DatabaseSync, userId: Id): Id[] {
  return all<{ id: Id }>(db, 'SELECT id FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY id', userId).map((r) => r.id);
}

function deactivateAccount(db: DatabaseSync, now: number, userId: Id): void {
  for (const id of activeKeyIds(db, userId)) {
    audited(db, now, { type: 'api_key', id }, 'revoke', () => run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', now, id));
  }
  audited(db, now, { type: 'user', id: userId }, 'delete', () => run(db, 'UPDATE users SET deactivated_at = ?, updated_at = ? WHERE id = ?', now, now, userId));
}

export function deactivateMe(ctx: Ctx): Result {
  ctx.input();
  const me = ctx.me();
  immediate(ctx.db, () => {
    assertOwnsNothing(ctx.db, me.id);
    leaveAll(ctx.db, ctx.now, me);
    leaveOrganizations(ctx.db, ctx.now, me);
    deactivateAccount(ctx.db, ctx.now, me.id);
  });

  return noContent();
}
