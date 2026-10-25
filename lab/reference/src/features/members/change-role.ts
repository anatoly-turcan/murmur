import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive, assertRole, loadWorkspace } from '../../domain/load.ts';
import type { Role, UserRow } from '../../domain/rows.ts';
import { forbidden, throwIfInvalid } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { oneOf, validateBody, type FieldSpecs } from '../../http/validate.ts';
import { ADDABLE_ROLES } from './add.ts';
import { assertMayManage, soleOwner, targetMember } from './remove.ts';
import { loadMember, serializeMember, type MemberRow } from './serialize.ts';
import { unassignUserTasks } from './unassign.ts';

const ROLE_FIELDS = { role: oneOf(ADDABLE_ROLES) } satisfies FieldSpecs;

function assertMayGrant(actorRole: Role, requested: unknown): void {
  if (actorRole !== 'owner' && requested === 'admin') throw forbidden();
}

export function applyRoleChange(db: DatabaseSync, now: number, actor: UserRow, member: MemberRow, role: Role): MemberRow {
  run(db, 'UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?', role, member.workspace_id, member.user_id);
  const updated = loadMember(db, member.workspace_id, member.user_id)!;
  recordEvent(db, now, actor, {
    workspaceId: member.workspace_id,
    type: 'member.role_changed',
    target: { type: 'member', id: member.user_id },
    changes: { role: { from: member.role, to: role } },
    data: { member: serializeMember(updated) },
  });

  return updated;
}

function changeTo(db: DatabaseSync, now: number, actor: UserRow, member: MemberRow, role: Role | undefined): MemberRow {
  if (role === undefined || role === member.role) return member;
  const updated = applyRoleChange(db, now, actor, member, role);
  if (role === 'viewer') unassignUserTasks(db, now, actor, member.workspace_id, member.user_id);

  return updated;
}

export function changeRole(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  assertRole(role, 'admin');
  const member = targetMember(ctx, workspace.id, ctx.params.user_id);
  assertMayManage(role, member.role);
  const { body } = ctx.input();
  assertMayGrant(role, body.role);
  const { values, details } = validateBody(body, ROLE_FIELDS);
  throwIfInvalid(details);
  if (member.role === 'owner') throw soleOwner();
  const ref = { type: 'member', id: member.user_id, parentId: workspace.id } as const;
  const updated = immediate(ctx.db, () => audited(ctx.db, ctx.now, ref, 'update', () => changeTo(ctx.db, ctx.now, ctx.me(), member, values.role)));

  return ok(serializeMember(updated));
}
