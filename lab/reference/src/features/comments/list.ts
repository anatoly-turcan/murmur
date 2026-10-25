import { all } from '../../db/sql.ts';
import { assertLive, assertRole, loadTask } from '../../domain/load.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { COMMENT_SELECT, serializeCommentRow, type CommentWithAuthor } from './serialize.ts';

export function listComments(ctx: Ctx): Result {
  const { workspace, project, task, role } = loadTask(ctx, ctx.params.id);
  assertLive(workspace, project, task);
  const includeDeleted = ctx.input().query.include_deleted === true;
  if (includeDeleted) assertRole(role, 'admin');
  const { limit, after } = ctx.page();
  const [createdAt, id] = (after ?? [null, null]) as [number | null, number | null];
  const rows = all<CommentWithAuthor>(
    ctx.db,
    `${COMMENT_SELECT} WHERE c.task_id = ?1
        AND (?2 = 1 OR c.deleted_at IS NULL)
        AND (?3 IS NULL OR c.created_at > ?3 OR (c.created_at = ?3 AND c.id > ?4))
      ORDER BY c.created_at, c.id LIMIT ?5`,
    task.id,
    includeDeleted ? 1 : 0,
    createdAt,
    id,
    limit + 1,
  );

  return ok(ctx.pageOf(rows, (r) => [r.created_at, r.id], serializeCommentRow));
}
