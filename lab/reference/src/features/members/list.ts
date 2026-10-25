import { all } from '../../db/sql.ts';
import { assertLive, loadWorkspace } from '../../domain/load.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { MEMBER_SELECT, serializeMember, type MemberRow } from './serialize.ts';

export function listMembers(ctx: Ctx): Result {
  const { workspace } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  const { limit, after } = ctx.page();
  const [joined, userId] = (after ?? [null, null]) as [number | null, number | null];
  const rows = all<MemberRow>(
    ctx.db,
    `${MEMBER_SELECT} WHERE m.workspace_id = ?1
        AND (?2 IS NULL OR m.joined_at > ?2 OR (m.joined_at = ?2 AND m.user_id > ?3))
      ORDER BY m.joined_at, m.user_id LIMIT ?4`,
    workspace.id,
    joined,
    userId,
    limit + 1,
  );

  return ok(ctx.pageOf(rows, (r) => [r.joined_at, r.user_id], serializeMember));
}
