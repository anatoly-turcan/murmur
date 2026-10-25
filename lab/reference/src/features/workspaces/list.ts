import { all } from '../../db/sql.ts';
import type { Role, WorkspaceRow } from '../../domain/rows.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeWorkspace } from './serialize.ts';

type Row = WorkspaceRow & { my_role: Role };

export function listWorkspaces(ctx: Ctx): Result {
  const { limit, after } = ctx.page();
  const includeDeleted = ctx.input().query.include_deleted === true;
  const me = ctx.me().id;
  const rows = all<Row>(
    ctx.db,
    `SELECT w.*, m.role AS my_role FROM workspaces w
       JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ?1
      WHERE (w.deleted_at IS NULL OR (?2 = 1 AND w.owner_id = ?1))
        AND (?3 IS NULL OR w.id > ?3)
      ORDER BY w.id LIMIT ?4`,
    me,
    includeDeleted ? 1 : 0,
    (after?.[0] as number | undefined) ?? null,
    limit + 1,
  );

  return ok(ctx.pageOf(rows, (r) => [r.id], (r) => serializeWorkspace(r, r.my_role)));
}
