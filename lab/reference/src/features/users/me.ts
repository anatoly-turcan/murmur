import { audited } from '../../audit/record.ts';
import { run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { loadUser } from '../../domain/actor.ts';
import { throwIfInvalid } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody } from '../../http/validate.ts';
import { USER_PATCH_FIELDS } from './fields.ts';
import { serializeUser } from './serialize.ts';

export function getMe(ctx: Ctx): Result {
  ctx.input();

  return ok(serializeUser(ctx.me()));
}

export function patchMe(ctx: Ctx): Result {
  const { values, details } = validateBody(ctx.input().body, USER_PATCH_FIELDS);
  throwIfInvalid(details);
  const me = ctx.me();

  return immediate(ctx.db, () => {
    audited(ctx.db, ctx.now, { type: 'user', id: me.id }, 'update', () =>
      run(
        ctx.db,
        'UPDATE users SET name = ?, timezone = ?, digest_enabled = ?, updated_at = ? WHERE id = ?',
        values.name ?? me.name,
        values.timezone ?? me.timezone,
        values.digest_enabled === undefined ? me.digest_enabled : Number(values.digest_enabled),
        ctx.now,
        me.id,
      ),
    );

    return ok(serializeUser(loadUser(ctx.db, me.id)!));
  });
}
