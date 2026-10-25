import { assertLive, assertRole, loadDelivery } from '../../domain/load.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeDeliveries } from './serialize.ts';

export function getDelivery(ctx: Ctx): Result {
  const { parent, delivery, role } = loadDelivery(ctx, ctx.params.id, ctx.params.delivery_id);
  assertLive(parent);
  assertRole(role, 'admin');
  ctx.input();

  return ok(serializeDeliveries(ctx.db, [delivery])[0]);
}
