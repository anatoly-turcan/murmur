import { all } from '../../db/sql.ts';
import { assertLive, assertRole, loadWorkspace } from '../../domain/load.ts';
import type { ProjectRow } from '../../domain/rows.ts';
import { q, type QuerySpec } from '../../http/query.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeProject } from './serialize.ts';

export const PROJECT_LIST_QUERY: QuerySpec = { include_deleted: q.bool(false) };

export function listProjects(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  const includeDeleted = ctx.input().query.include_deleted === true;
  if (includeDeleted) assertRole(role, 'admin');
  const { limit, after } = ctx.page();
  const [slug, id] = (after ?? [null, null]) as [string | null, number | null];
  const rows = all<ProjectRow>(
    ctx.db,
    `SELECT * FROM projects WHERE workspace_id = ?1
        AND (?2 = 1 OR deleted_at IS NULL)
        AND (?3 IS NULL OR (slug, id) > (?3, ?4))
      ORDER BY slug, id LIMIT ?5`,
    workspace.id,
    includeDeleted ? 1 : 0,
    slug,
    id,
    limit + 1,
  );

  return ok(ctx.pageOf(rows, (r) => [r.slug, r.id], serializeProject));
}
