import { all, type SqlValue } from '../../db/sql.ts';
import { assertLive } from '../../domain/load.ts';
import { ORG_EVENT_TYPES, ORG_TARGET_TYPES } from '../../domain/org-events.ts';
import { loadOrganization } from '../../domain/orgs.ts';
import { idListParam, q, type QuerySpec, type QueryValues } from '../../http/query.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { ORG_EVENT_SELECT, serializeOrgEvent, type OrgEventWithActor } from './serialize.ts';

export const ORG_ACTIVITY_QUERY: QuerySpec = {
  type: q.enumList(ORG_EVENT_TYPES),
  actor_id: q.id('user'),
  target_type: q.enumOne(ORG_TARGET_TYPES),
  target_id: q.id('organization', 'user'),
  since: q.timestamp(),
  until: q.timestamp(),
};

function filterParams(query: QueryValues): SqlValue[] {
  const types = query.type as string[] | undefined;

  return [
    types ? JSON.stringify(types) : null,
    (query.actor_id as string | undefined) ?? null,
    (query.target_type as string | undefined) ?? null,
    idListParam(query.target_id),
    (query.since as number | undefined) ?? null,
    (query.until as number | undefined) ?? null,
  ];
}

export function listOrgActivity(ctx: Ctx): Result {
  const { org } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  const { limit, after } = ctx.page();
  const [occurredAt, id] = (after ?? [null, null]) as [number | null, string | null];
  const rows = all<OrgEventWithActor>(
    ctx.db,
    `${ORG_EVENT_SELECT} WHERE e.organization_id = ?1
        AND (?2 IS NULL OR e.type IN (SELECT value FROM json_each(?2)))
        AND (?3 IS NULL OR e.actor_id = ?3)
        AND (?4 IS NULL OR e.target_type = ?4)
        AND (?5 IS NULL OR e.target_id IN (SELECT value FROM json_each(?5)))
        AND (?6 IS NULL OR e.occurred_at >= ?6)
        AND (?7 IS NULL OR e.occurred_at < ?7)
        AND (?8 IS NULL OR e.occurred_at < ?8 OR (e.occurred_at = ?8 AND e.id < ?9))
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?10`,
    org.id,
    ...filterParams(ctx.input().query),
    occurredAt,
id,
    limit + 1,
  );

  return ok(ctx.pageOf(rows, (r) => [r.occurred_at, r.id], serializeOrgEvent));
}
