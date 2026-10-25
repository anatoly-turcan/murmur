import { one } from '../../db/sql.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { isoOrNull } from '../../time/format.ts';
import { assertOrgAuditor } from './read.ts';

export function auditStats(ctx: Ctx): Result {
  const orgId = assertOrgAuditor(ctx);
  ctx.input();
  const row = one<{ entries: number; oldest: number | null }>(
    ctx.db,
    'SELECT count(*) AS entries, min(occurred_at) AS oldest FROM audit_entries WHERE organization_id = ?',
    orgId,
  )!;

  return ok({ entries: row.entries, oldest: isoOrNull(row.oldest), retention_days: ctx.config.auditRetentionDays });
}
