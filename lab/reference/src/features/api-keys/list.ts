import { all } from '../../db/sql.ts';
import type { ApiKeyRow } from '../../domain/rows.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeApiKey } from './serialize.ts';

export function listKeys(ctx: Ctx): Result {
  const { limit, after } = ctx.page();
  const [afterCreated, afterId] = (after ?? [null, null]) as [number | null, number | null];
  const rows = all<ApiKeyRow>(
    ctx.db,
    `SELECT * FROM api_keys WHERE user_id = ?1
       AND (?2 IS NULL OR created_at > ?2 OR (created_at = ?2 AND id > ?3))
     ORDER BY created_at, id LIMIT ?4`,
    ctx.me().id,
    afterCreated,
    afterId,
    limit + 1,
  );

  return ok(ctx.pageOf(rows, (r) => [r.created_at, r.id], (r) => serializeApiKey(r)));
}
