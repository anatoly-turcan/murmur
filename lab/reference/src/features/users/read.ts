import { one } from '../../db/sql.ts';
import type { UserRow } from '../../domain/rows.ts';
import { notFound } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializePublicUser } from './serialize.ts';
import type { Id } from '../../ids/uuid.ts';

function visibleUser(ctx: Ctx, id: Id): UserRow | undefined {
  const me = ctx.me();
  if (id === me.id) return me;

  return one<UserRow>(
    ctx.db,
    `SELECT u.* FROM users u WHERE u.id = ? AND u.deactivated_at IS NULL AND EXISTS (
       SELECT 1 FROM memberships a
         JOIN memberships b ON b.workspace_id = a.workspace_id AND b.user_id = ?
         JOIN workspaces w ON w.id = a.workspace_id AND w.deleted_at IS NULL
        WHERE a.user_id = u.id)`,
id,
    me.id,
  );
}

export function getUser(ctx: Ctx): Result {
  const user = visibleUser(ctx, ctx.params.id);
  if (!user) throw notFound();
  ctx.input();

  return ok(serializePublicUser(user));
}
