import { all } from '../../db/sql.ts';
import { assertLive, loadWorkspace } from '../../domain/load.ts';
import type { TaskRow } from '../../domain/rows.ts';
import { q, type QuerySpec } from '../../http/query.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { fold } from '../../text/normalize.ts';
import { serializeTaskFor } from '../tasks/serialize.ts';
import { matchOf, RANK_SQL } from './rank.ts';

export const SEARCH_QUERY: QuerySpec = { q: q.text(2, 100, { required: true }) };

type RankedTask = TaskRow & { rank: number };

export function searchTasks(ctx: Ctx): Result {
  const { workspace } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  const phrase = fold(ctx.input().query.q as string);
  const { limit, after } = ctx.page();
  const [rank, updatedAt, id] = (after ?? [null, null, null]) as [number | null, number | null, number | null];
  const rows = all<RankedTask>(
    ctx.db,
    `SELECT * FROM (
        SELECT t.*, ${RANK_SQL} AS rank FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.workspace_id = ?2 AND t.deleted_at IS NULL AND p.deleted_at IS NULL
      ) WHERE rank IS NOT NULL
        AND (?3 IS NULL OR rank > ?3 OR (rank = ?3 AND (updated_at < ?4 OR (updated_at = ?4 AND id < ?5))))
      ORDER BY rank, updated_at DESC, id DESC LIMIT ?6`,
    phrase,
    workspace.id,
    rank,
    updatedAt,
    id,
    limit + 1,
  );

  return ok(
    ctx.pageOf(
      rows,
      (r) => [r.rank, r.updated_at, r.id],
      (r) => ({ task: serializeTaskFor(ctx, r), match: matchOf(r.rank) }),
    ),
  );
}
