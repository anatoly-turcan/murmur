import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { assertLive, assertRole, loadDelivery } from '../../domain/load.ts';
import type { DeliveryRow } from '../../domain/rows.ts';
import { conflict } from '../../http/errors.ts';
import { accepted } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { moveToEnd } from '../../jobs/queue.ts';
import { serializeDeliveries } from './serialize.ts';

function restartSeries(db: DatabaseSync, delivery: DeliveryRow, now: number): DeliveryRow {
  const job = moveToEnd(db, delivery.job_id, now);
  run(
    db,
    `UPDATE webhook_deliveries SET status = 'pending', series_failures = 0, next_attempt_at = ?, completed_at = NULL WHERE id = ?`,
    job.runAt,
    delivery.id,
  );

  return one<DeliveryRow>(db, 'SELECT * FROM webhook_deliveries WHERE id = ?', delivery.id)!;
}

export function redeliver(ctx: Ctx): Result {
  const { parent, delivery, role } = loadDelivery(ctx, ctx.params.id, ctx.params.delivery_id);
  assertLive(parent);
  assertRole(role, 'admin');
  ctx.input();
  if (delivery.status !== 'dead') throw conflict('not_redeliverable', 'Only a dead delivery can be redelivered.');

  const restarted = audited(ctx.db, ctx.now, { type: 'delivery', id: delivery.id }, 'update', () => restartSeries(ctx.db, delivery, ctx.now));

  return accepted(serializeDeliveries(ctx.db, [restarted])[0]);
}
