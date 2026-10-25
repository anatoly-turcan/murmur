import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive, assertRole, loadWorkspace } from '../../domain/load.ts';
import { orgRoleOf } from '../../domain/orgs.ts';
import type { UserRow, WorkspaceRow } from '../../domain/rows.ts';
import { detail, throwIfInvalid } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { id, validateBody, type FieldSpecs } from '../../http/validate.ts';
import { soleOwner } from '../members/remove.ts';
import { loadMember, type MemberRow } from '../members/serialize.ts';
import { serializeWorkspace } from './serialize.ts';
import { reloadWorkspace } from './update.ts';
import type { Id } from '../../ids/uuid.ts';

const TRANSFER_FIELDS = { user_id: id() } satisfies FieldSpecs;

function transferTarget(ctx: Ctx, workspaceId: Id, organizationId: Id): MemberRow {
  const { values, details } = validateBody(ctx.input().body, TRANSFER_FIELDS, { required: ['user_id'] });
  const member = values.user_id === undefined ? undefined : loadMember(ctx.db, workspaceId, values.user_id);
  if (values.user_id !== undefined && !member) details.push(detail('user_id', 'not_member'));
  if (member && !orgRoleOf(ctx.db, organizationId, member.user_id)) {
    details.push(detail('user_id', 'not_org_member', { message: 'A workspace owner must be a member of its organization.' }));
  }
  throwIfInvalid(details);

  return member!;
}

function swapOwner(db: DatabaseSync, ws: WorkspaceRow, newOwnerId: Id, now: number): void {
  run(db, `UPDATE memberships SET role = 'admin' WHERE workspace_id = ? AND user_id = ?`, ws.id, ws.owner_id);
  run(db, `UPDATE memberships SET role = 'owner' WHERE workspace_id = ? AND user_id = ?`, ws.id, newOwnerId);
  run(db, 'UPDATE workspaces SET owner_id = ?, version = version + 1, updated_at = ? WHERE id = ?', newOwnerId, now, ws.id);
}

function auditedSwap(db: DatabaseSync, now: number, ws: WorkspaceRow, newOwnerId: Id): void {
  const asMember = (userId: Id, fn: () => void) => () => audited(db, now, { type: 'member', id: userId, parentId: ws.id }, 'update', fn);
  const swap = () => swapOwner(db, ws, newOwnerId, now);
  audited(db, now, { type: 'workspace', id: ws.id }, 'transfer', asMember(newOwnerId, asMember(ws.owner_id, swap)));
}

function recordTransfer(db: DatabaseSync, now: number, actor: UserRow, ws: WorkspaceRow, target: MemberRow): void {
  recordEvent(db, now, actor, {
    workspaceId: ws.id,
    type: 'ownership.transferred',
    target: { type: 'member', id: target.user_id },
    changes: { role: { from: target.role, to: 'owner' } },
  });
  recordEvent(db, now, actor, {
    workspaceId: ws.id,
    type: 'member.role_changed',
    target: { type: 'member', id: ws.owner_id },
    changes: { role: { from: 'owner', to: 'admin' } },
  });
}

export function transferOwnership(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  assertRole(role, 'owner');
  const target = transferTarget(ctx, workspace.id, workspace.organization_id);
  if (target.role === 'owner') throw soleOwner();

  return immediate(ctx.db, () => {
    const ws = reloadWorkspace(ctx.db, workspace.id);
    auditedSwap(ctx.db, ctx.now, ws, target.user_id);
    recordTransfer(ctx.db, ctx.now, ctx.me(), ws, target);
    const updated = reloadWorkspace(ctx.db, ws.id);

    return ok(serializeWorkspace(updated, 'admin'), updated.version);
  });
}
