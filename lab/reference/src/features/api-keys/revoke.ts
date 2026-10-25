import { audited } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import type { ApiKeyRow } from '../../domain/rows.ts';
import { notFound } from '../../http/errors.ts';
import { noContent } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';

export function revokeKey(ctx: Ctx): Result {
  const key = one<ApiKeyRow>(ctx.db, 'SELECT * FROM api_keys WHERE id = ? AND user_id = ?', ctx.params.id, ctx.me().id);
  if (!key) throw notFound();
  ctx.input();
  audited(ctx.db, ctx.now, { type: 'api_key', id: key.id }, 'revoke', () =>
    run(ctx.db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', ctx.now, key.id),
  );

  return noContent();
}
