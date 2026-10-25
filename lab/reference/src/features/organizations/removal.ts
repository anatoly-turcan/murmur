import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { all, run } from '../../db/sql.ts';
import { cancelOpenDeliveries } from '../../domain/deliveries.ts';
import { recordOrgEvent } from '../../domain/org-events.ts';
import type { UserRow } from '../../domain/rows.ts';
import { detail } from '../../http/errors.ts';
import { removeMembership, soleOwner } from '../members/remove.ts';
import { MEMBER_SELECT, type MemberRow } from '../members/serialize.ts';
import { serializeOrgMember, type OrgMemberRow } from './serialize.ts';
import type { Id } from '../../ids/uuid.ts';

type WorkspaceMembership = MemberRow & { ws_deleted: number };

function ownedWorkspaceIds(db: DatabaseSync, organizationId: Id, userId: Id): Id[] {
  return all<{ id: Id }>(db, 'SELECT id FROM workspaces WHERE organization_id = ? AND owner_id = ? ORDER BY id', organizationId, userId).map(
    (r) => r.id,
  );
}

function workspaceMemberships(db: DatabaseSync, organizationId: Id, userId: Id): WorkspaceMembership[] {
  return all<WorkspaceMembership>(
    db,
    `SELECT x.*, w.deleted_at IS NOT NULL AS ws_deleted FROM (${MEMBER_SELECT} WHERE m.user_id = ?) x
       JOIN workspaces w ON w.id = x.workspace_id WHERE w.organization_id = ? ORDER BY x.workspace_id`,
    userId,
    organizationId,
  );
}

export function assertOwnsNoOrgWorkspace(db: DatabaseSync, organizationId: Id, userId: Id): void {
  const owned = ownedWorkspaceIds(db, organizationId, userId);
  if (owned.length === 0) return;

  throw soleOwner([detail('workspaces', 'sole_owner', { workspace_ids: owned, message: 'Transfer ownership of these workspaces first.' })]);
}

export function removeFromOrganization(db: DatabaseSync, now: number, actor: UserRow, member: OrgMemberRow): void {
  for (const membership of workspaceMemberships(db, member.organization_id, member.user_id)) {
    removeMembership(db, now, actor, membership);
    if (membership.ws_deleted) cancelOpenDeliveries(db, membership.workspace_id, now);
  }
  const ref = { type: 'org_member', id: member.user_id, parentId: member.organization_id } as const;
  audited(db, now, ref, 'delete', () => run(db, 'DELETE FROM org_memberships WHERE organization_id = ? AND user_id = ?', member.organization_id, member.user_id));
  recordOrgEvent(db, now, actor, {
    organizationId: member.organization_id,
    type: 'org_member.removed',
    target: { type: 'org_member', id: member.user_id },
    data: { member: serializeOrgMember(member) },
  });
}
