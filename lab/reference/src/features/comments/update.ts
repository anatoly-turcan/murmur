import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent, type Changes } from '../../domain/events.ts';
import { assertLive, assertRole, loadComment } from '../../domain/load.ts';
import type { CommentRow } from '../../domain/rows.ts';
import { forbidden, throwIfInvalid, versionConflict } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { has, validateBody } from '../../http/validate.ts';
import { fold } from '../../text/normalize.ts';
import { COMMENT_FIELDS } from './create.ts';
import { serializeComment } from './serialize.ts';

function writeBody(db: DatabaseSync, comment: CommentRow, body: string | undefined, now: number): CommentRow {
  const text = body ?? comment.body;
  const edited = body === undefined ? comment.edited : 1;
  run(
    db,
    'UPDATE comments SET body = ?, body_fold = ?, edited = ?, version = version + 1, updated_at = ? WHERE id = ?',
    text,
    fold(text),
    edited,
    now,
    comment.id,
  );

  return one<CommentRow>(db, 'SELECT * FROM comments WHERE id = ?', comment.id)!;
}

function bodyChanges(before: CommentRow, after: CommentRow): Changes {
  return before.body === after.body ? {} : { body: { from: before.body, to: after.body } };
}

export function updateComment(ctx: Ctx): Result {
  const { workspace, project, task, comment, role } = loadComment(ctx, ctx.params.id);
  assertLive(workspace, project, task, comment);
  assertRole(role, 'member');
  const me = ctx.me();
  if (comment.author_id !== me.id) throw forbidden();
  const { body, ifMatch } = ctx.input();
  const { values, details } = validateBody(body, COMMENT_FIELDS, {});
  throwIfInvalid(details);
  if (ifMatch !== null && ifMatch !== comment.version) throw versionConflict(comment.version);

  return immediate(ctx.db, () => {
    const ref = { type: 'comment', id: comment.id } as const;
    const updated = audited(ctx.db, ctx.now, ref, 'update', () => writeBody(ctx.db, comment, has(values, 'body') ? values.body : undefined, ctx.now));
    const changes = bodyChanges(comment, updated);
    const item = serializeComment(ctx.db, updated, me);
    recordEvent(ctx.db, ctx.now, me, {
      workspaceId: workspace.id,
      type: 'comment.updated',
      target: { type: 'comment', id: comment.id },
      changes,
      data: { comment: item, task_id: task.id, changes },
    });

    return ok(item, updated.version);
  });
}
