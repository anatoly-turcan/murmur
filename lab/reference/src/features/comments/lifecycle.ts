import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent, type ActivityType } from '../../domain/events.ts';
import { assertLive, loadComment, type CommentChain } from '../../domain/load.ts';
import { atLeast } from '../../domain/roles.ts';
import type { CommentRow, UserRow } from '../../domain/rows.ts';
import { conflict, forbidden, versionConflict } from '../../http/errors.ts';
import { noContent, ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeComment } from './serialize.ts';

function assertMayModerate(chain: CommentChain, me: UserRow): void {
  const ownsAsMember = chain.role === 'member' && chain.comment.author_id === me.id;
  if (!atLeast(chain.role, 'admin') && !ownsAsMember) throw forbidden();
}

function setDeletedAt(db: DatabaseSync, comment: CommentRow, deletedAt: number | null, now: number): CommentRow {
  run(db, 'UPDATE comments SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?', deletedAt, now, comment.id);

  return one<CommentRow>(db, 'SELECT * FROM comments WHERE id = ?', comment.id)!;
}

function record(ctx: Ctx, chain: CommentChain, me: UserRow, type: ActivityType, item: Record<string, unknown>): void {
  recordEvent(ctx.db, ctx.now, me, {
    workspaceId: chain.workspace.id,
    type,
    target: { type: 'comment', id: chain.comment.id },
    data: { comment: item, task_id: chain.task.id },
  });
}

export function deleteComment(ctx: Ctx): Result {
  const chain = loadComment(ctx, ctx.params.id);
  assertLive(chain.workspace, chain.project, chain.task, chain.comment);
  const me = ctx.me();
  assertMayModerate(chain, me);
  const { ifMatch } = ctx.input();
  if (ifMatch !== null && ifMatch !== chain.comment.version) throw versionConflict(chain.comment.version);

  return immediate(ctx.db, () => {
    const deleted = audited(ctx.db, ctx.now, { type: 'comment', id: chain.comment.id }, 'delete', () => setDeletedAt(ctx.db, chain.comment, ctx.now, ctx.now));
    record(ctx, chain, me, 'comment.deleted', serializeComment(ctx.db, deleted));

    return noContent();
  });
}

export function restoreComment(ctx: Ctx): Result {
  const chain = loadComment(ctx, ctx.params.id);
  assertLive(chain.workspace, chain.project, chain.task);
  const me = ctx.me();
  assertMayModerate(chain, me);
  ctx.input();
  if (chain.comment.deleted_at === null) throw conflict('not_deleted', 'The comment is not deleted.');

  return immediate(ctx.db, () => {
    const restored = audited(ctx.db, ctx.now, { type: 'comment', id: chain.comment.id }, 'restore', () => setDeletedAt(ctx.db, chain.comment, null, ctx.now));
    const item = serializeComment(ctx.db, restored);
    record(ctx, chain, me, 'comment.restored', item);

    return ok(item, restored.version);
  });
}
