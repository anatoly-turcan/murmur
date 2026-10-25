import type { DatabaseSync } from 'node:sqlite';
import { auditCreated } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { isMember } from '../../domain/access.ts';
import { enqueueEmail } from '../../domain/emails.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertMemberCapacity } from '../../domain/plans.ts';
import { assertLive, assertRole, loadWorkspace } from '../../domain/load.ts';
import type { Role, UserRow, WorkspaceRow } from '../../domain/rows.ts';
import { conflict, detail, forbidden, throwIfInvalid } from '../../http/errors.ts';
import { created } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { email, oneOf, validateBody, type FieldSpecs } from '../../http/validate.ts';
import { emailKey } from '../../text/email.ts';
import { loadMember, serializeMember } from './serialize.ts';
import type { Id } from '../../ids/uuid.ts';

export const ADDABLE_ROLES = ['admin', 'member', 'viewer'] as const;

const MEMBER_ADD_FIELDS = { email: email(), role: oneOf(ADDABLE_ROLES) } satisfies FieldSpecs;

function activeUserByEmail(db: DatabaseSync, address: string): UserRow | undefined {
  return one<UserRow>(db, 'SELECT * FROM users WHERE email_key = ? AND deactivated_at IS NULL', emailKey(address));
}

function assertMayAdd(actorRole: Role, requested: unknown): void {
  assertRole(actorRole, 'admin');
  if (actorRole !== 'owner' && requested === 'admin') throw forbidden();
}

function notifyAdded(db: DatabaseSync, now: number, ws: WorkspaceRow, user: UserRow, role: Role, actor: UserRow, eventId: Id): void {
  enqueueEmail(db, now, {
    template: 'member_added',
    toUserId: user.id,
    subject: `You were added to ${ws.name}`,
    dedupeKey: `member_added:${ws.id}:${user.id}:${eventId}`,
    data: { workspace_id: ws.id, workspace_name: ws.name, role, actor_name: actor.name },
  });
}

export function addMember(ctx: Ctx): Result {
  const { workspace, role: actorRole } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  const { body } = ctx.input();
  assertMayAdd(actorRole, body.role);
  const { values, details } = validateBody(body, MEMBER_ADD_FIELDS, { required: ['email', 'role'] });
  const user = values.email === undefined ? undefined : activeUserByEmail(ctx.db, values.email);
  if (values.email !== undefined && !user) details.push(detail('email', 'user_not_found'));
  throwIfInvalid(details);
  const me = ctx.me();

  return immediate(ctx.db, () => {
    if (isMember(ctx.db, workspace.id, user!.id)) throw conflict('already_member', 'The user is already a member of this workspace.');
    assertMemberCapacity(ctx.db, workspace.id);
    run(ctx.db, 'INSERT INTO memberships (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', workspace.id, user!.id, values.role!, ctx.now);
    auditCreated(ctx.db, ctx.now, { type: 'member', id: user!.id, parentId: workspace.id });
    const item = serializeMember(loadMember(ctx.db, workspace.id, user!.id)!);
    const eventId = recordEvent(ctx.db, ctx.now, me, {
      workspaceId: workspace.id,
      type: 'member.added',
      target: { type: 'member', id: user!.id },
      data: { member: item },
    });
    notifyAdded(ctx.db, ctx.now, workspace, user!, values.role!, me, eventId);

    return created(item);
  });
}
