import { all } from '../../db/sql.ts';
import { assertLive } from '../../domain/load.ts';
import { loadOrganization, workspaceRoleFor } from '../../domain/orgs.ts';
import type { Role, WorkspaceRow } from '../../domain/rows.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeWorkspace } from '../workspaces/serialize.ts';

type Row = WorkspaceRow & { my_role: Role | null };

export function listOrgWorkspaces(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  ctx.input();
  const { limit, after } = ctx.page();
  const rows = all<Row>(
    ctx.db,
    `SELECT w.*, m.role AS my_role FROM workspaces w
       LEFT JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ?1
      WHERE w.organization_id = ?2 AND w.deleted_at IS NULL AND (?3 IS NULL OR w.id > ?3)
      ORDER BY w.id LIMIT ?4`,
    ctx.me().id,
    org.id,
    (after?.[0] as number | undefined) ?? null,
    limit + 1,
  );

  return ok(ctx.pageOf(rows, (r) => [r.id], (r) => serializeWorkspace(r, workspaceRoleFor(r.my_role, role))));
}
