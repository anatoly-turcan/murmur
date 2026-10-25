import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive, assertRole, loadWorkspace } from '../../domain/load.ts';
import { atLeast } from '../../domain/roles.ts';
import type { Role, UserRow } from '../../domain/rows.ts';
import { conflict, forbidden, notFound, type ApiError } from '../../http/errors.ts';
import { noContent } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { loadMember, serializeMember, type MemberRow } from './serialize.ts';
import { unassignUserTasks } from './unassign.ts';
import type { Id } from '../../ids/uuid.ts';

export function soleOwner(details: ApiError['details'] = []): ApiError {
  return conflict('sole_owner', 'The workspace owner must transfer ownership first.', details);
}

export function targetMember(ctx: Ctx, workspaceId: Id, userId: Id): MemberRow {
  const member = loadMember(ctx.db, workspaceId, userId);
  if (!member) throw notFound();

  return member;
}

export function assertMayManage(actorRole: Role, targetRole: Role): void {
  if (actorRole !== 'owner' && atLeast(targetRole, 'admin')) throw forbidden();
}

export function removeMembership(db: DatabaseSync, now: number, actor: UserRow, member: MemberRow): void {
  const item = serializeMember(member);
  const ref = { type: 'member', id: member.user_id, parentId: member.workspace_id } as const;
  audited(db, now, ref, 'delete', () => run(db, 'DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?', member.workspace_id, member.user_id));
  recordEvent(db, now, actor, {
    workspaceId: member.workspace_id,
    type: 'member.removed',
    target: { type: 'member', id: member.user_id },
    data: { member: item },
  });
  unassignUserTasks(db, now, actor, member.workspace_id, member.user_id);
}

function memberToRemove(ctx: Ctx, workspaceId: Id, actorRole: Role, userId: Id): MemberRow {
  const leaving = userId === ctx.me().id;
  if (!leaving) assertRole(actorRole, 'admin');
  const member = targetMember(ctx, workspaceId, userId);
  if (!leaving) assertMayManage(actorRole, member.role);

  return member;
}

export function removeMember(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  const member = memberToRemove(ctx, workspace.id, role, ctx.params.user_id);
  ctx.input();
  if (member.role === 'owner') throw soleOwner();
  immediate(ctx.db, () => removeMembership(ctx.db, ctx.now, ctx.me(), member));

  return noContent();
}
