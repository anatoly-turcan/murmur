import { assertLive, assertRole, loadWebhook } from '../../domain/load.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeWebhook } from './serialize.ts';

export function getWebhook(ctx: Ctx): Result {
  const { parent, webhook, role } = loadWebhook(ctx, ctx.params.id);
  assertLive(parent);
  assertRole(role, 'admin');
  ctx.input();

  return ok(serializeWebhook(webhook));
}
