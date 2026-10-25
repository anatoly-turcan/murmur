import { audited } from '../../audit/record.ts';
import { run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { deleteEndpointDeliveries } from '../../domain/deliveries.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive, assertRole, loadWebhook } from '../../domain/load.ts';
import { noContent } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';

export function removeWebhook(ctx: Ctx): Result {
  const { parent, webhook, role } = loadWebhook(ctx, ctx.params.id);
  assertLive(parent);
  assertRole(role, 'admin');
  ctx.input();

  return immediate(ctx.db, () => {
    audited(ctx.db, ctx.now, { type: 'webhook', id: webhook.id }, 'delete', () => {
      deleteEndpointDeliveries(ctx.db, webhook.id);
      run(ctx.db, 'DELETE FROM webhook_endpoints WHERE id = ?', webhook.id);
    });
    if (webhook.workspace_id !== null) {
      recordEvent(ctx.db, ctx.now, ctx.me(), { workspaceId: webhook.workspace_id, type: 'webhook.deleted', target: { type: 'webhook', id: webhook.id } });
    }

    return noContent();
  });
}
