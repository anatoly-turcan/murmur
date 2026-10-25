import { scalar } from '../../db/sql.ts';
import { assertLive } from '../../domain/load.ts';
import { assertOrgRole, loadOrganization, PLAN_MANAGERS } from '../../domain/orgs.ts';
import { limitsOf } from '../../domain/plans.ts';
import { organizationRequestCount } from '../../http/rate-limit.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';

export function getUsage(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  assertOrgRole(role, PLAN_MANAGERS);
  ctx.input();

  return ok({
    workspaces: scalar<number>(ctx.db, 'SELECT count(*) FROM workspaces WHERE organization_id = ? AND deleted_at IS NULL', org.id) ?? 0,
    members: scalar<number>(ctx.db, 'SELECT count(*) FROM org_memberships WHERE organization_id = ?', org.id) ?? 0,
    api_requests_last_minute: organizationRequestCount(ctx.db, org.id, ctx.now),
    limits: limitsOf(org.plan),
  });
}
