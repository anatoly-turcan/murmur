import { all } from '../../db/sql.ts';
import { assertLive, assertRole, loadWebhook } from '../../domain/load.ts';
import type { DeliveryRow } from '../../domain/rows.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeDeliveries } from './serialize.ts';

export const DELIVERY_STATUSES = ['pending', 'in_progress', 'succeeded', 'dead', 'cancelled'] as const;

export function listDeliveries(ctx: Ctx): Result {
  const { parent, webhook, role } = loadWebhook(ctx, ctx.params.id);
  assertLive(parent);
  assertRole(role, 'admin');
  const { limit, after } = ctx.page();
  const statuses = (ctx.input().query.status as string[] | undefined) ?? null;
  const [createdAt, id] = (after ?? [null, null]) as [number | null, number | null];
  const rows = all<DeliveryRow>(
    ctx.db,
    `SELECT * FROM webhook_deliveries WHERE webhook_id = ?1
        AND (?2 IS NULL OR status IN (SELECT value FROM json_each(?2)))
        AND (?3 IS NULL OR created_at < ?3 OR (created_at = ?3 AND id < ?4))
      ORDER BY created_at DESC, id DESC LIMIT ?5`,
    webhook.id,
    statuses ? JSON.stringify(statuses) : null,
    createdAt,
    id,
    limit + 1,
  );
  const page = ctx.pageOf(rows, (r) => [r.created_at, r.id]);

  return ok({ data: serializeDeliveries(ctx.db, page.data), next_cursor: page.next_cursor });
}
