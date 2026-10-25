import { auditCreated } from '../../audit/record.ts';
import { scalar } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { detail, throwIfInvalid } from '../../http/errors.ts';
import { created } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { str, validateBody } from '../../http/validate.ts';
import { issueApiKey } from './issue.ts';
import { serializeApiKey } from './serialize.ts';

const MAX_ACTIVE_KEYS = 20;

function activeKeyCount(ctx: Ctx): number {
  return scalar<number>(ctx.db, 'SELECT count(*) FROM api_keys WHERE user_id = ? AND revoked_at IS NULL', ctx.me().id) ?? 0;
}

function assertBelowLimit(ctx: Ctx): void {
  if (activeKeyCount(ctx) < MAX_ACTIVE_KEYS) return;
  throwIfInvalid([detail('', 'too_many_items', { message: `A user may hold at most ${MAX_ACTIVE_KEYS} active keys.` })]);
}

export function createKey(ctx: Ctx): Result {
  const { values, details } = validateBody(ctx.input().body, { name: str({ max: 100 }) }, { required: ['name'] });
  throwIfInvalid(details);

  return immediate(ctx.db, () => {
    assertBelowLimit(ctx);
    const key = issueApiKey(ctx.db, ctx.me().id, values.name!, ctx.now);
    auditCreated(ctx.db, ctx.now, { type: 'api_key', id: key.row.id });

    return created(serializeApiKey(key.row, key.secret));
  });
}
