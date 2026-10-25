import { all } from '../../db/sql.ts';
import { assertLive } from '../../domain/load.ts';
import { loadOrganization } from '../../domain/orgs.ts';
import type { OrganizationRow } from '../../domain/rows.ts';
import { q, type QuerySpec } from '../../http/query.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeOrganization } from './serialize.ts';

export const ORG_LIST_QUERY: QuerySpec = { include_deleted: q.bool(false) };

export function getOrganization(ctx: Ctx): Result {
  const { org } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  ctx.input();

  return ok(serializeOrganization(org), org.version);
}

export function listOrganizations(ctx: Ctx): Result {
  const { limit, after } = ctx.page();
  const includeDeleted = ctx.input().query.include_deleted === true;
  const rows = all<OrganizationRow>(
    ctx.db,
    `SELECT o.* FROM organizations o
       JOIN org_memberships om ON om.organization_id = o.id AND om.user_id = ?1
      WHERE (o.deleted_at IS NULL OR (?2 = 1 AND o.owner_id = ?1))
        AND (?3 IS NULL OR o.id > ?3)
      ORDER BY o.id LIMIT ?4`,
    ctx.me().id,
    includeDeleted ? 1 : 0,
    (after?.[0] as number | undefined) ?? null,
    limit + 1,
  );

  return ok(ctx.pageOf(rows, (r) => [r.id], serializeOrganization));
}
