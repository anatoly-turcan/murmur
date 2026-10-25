import { all } from '../../db/sql.ts';
import { assertLive, assertRole, loadWorkspace } from '../../domain/load.ts';
import type { WebhookRow } from '../../domain/rows.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeWebhook } from './serialize.ts';

export function listWebhooks(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  assertRole(role, 'admin');
  const { limit, after } = ctx.page();
  const [afterId] = (after ?? [null]) as [number | null];
  const rows = all<WebhookRow>(
    ctx.db,
    'SELECT * FROM webhook_endpoints WHERE workspace_id = ?1 AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?3',
    workspace.id,
    afterId,
    limit + 1,
  );

  return ok(ctx.pageOf(rows, (r) => [r.id], (r) => serializeWebhook(r)));
}
