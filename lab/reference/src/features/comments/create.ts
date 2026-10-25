import type { DatabaseSync } from 'node:sqlite';
import { auditCreated } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { enqueueEmail } from '../../domain/emails.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive, assertRole, loadTask } from '../../domain/load.ts';
import type { CommentRow, TaskRow, UserRow } from '../../domain/rows.ts';
import { throwIfInvalid } from '../../http/errors.ts';
import { created } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { str, validateBody, type FieldSpecs } from '../../http/validate.ts';
import { fold } from '../../text/normalize.ts';
import { serializeComment } from './serialize.ts';
import { newId, type Id } from '../../ids/uuid.ts';

export const COMMENT_FIELDS = { body: str({ max: 10_000 }) } satisfies FieldSpecs;

function insertComment(db: DatabaseSync, task: TaskRow, authorId: Id, text: string, now: number): CommentRow {
  const id = newId(now);
  run(
    db,
    `INSERT INTO comments (id, task_id, workspace_id, author_id, body, body_fold, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    task.id,
    task.workspace_id,
    authorId,
    text,
    fold(text),
    now,
    now,
  );

  return one<CommentRow>(db, 'SELECT * FROM comments WHERE id = ?', id)!;
}

export function commentRecipients(task: TaskRow, authorId: Id): Id[] {
  const ids = [task.assignee_id, task.creator_id].filter((id): id is Id => id !== null && id !== authorId);

  return [...new Set(ids)];
}

function notifyCommented(db: DatabaseSync, now: number, task: TaskRow, comment: CommentRow, author: UserRow): void {
  for (const recipient of commentRecipients(task, author.id)) {
    enqueueEmail(db, now, {
      template: 'comment_added',
      toUserId: recipient,
      subject: `New comment on ${task.title}`,
      dedupeKey: `comment_added:${comment.id}:${recipient}`,
      data: { task_id: task.id, task_title: task.title, comment_id: comment.id, author_name: author.name, body: comment.body },
      requireMemberOf: task.workspace_id,
    });
  }
}

export function createComment(ctx: Ctx): Result {
  const { workspace, project, task, role } = loadTask(ctx, ctx.params.id);
  assertLive(workspace, project, task);
  assertRole(role, 'member');
  const { values, details } = validateBody(ctx.input().body, COMMENT_FIELDS, { required: ['body'] });
  throwIfInvalid(details);
  const me = ctx.me();

  return immediate(ctx.db, () => {
    const comment = insertComment(ctx.db, task, me.id, values.body!, ctx.now);
    auditCreated(ctx.db, ctx.now, { type: 'comment', id: comment.id });
    const item = serializeComment(ctx.db, comment, me);
    recordEvent(ctx.db, ctx.now, me, {
      workspaceId: workspace.id,
      type: 'comment.created',
      target: { type: 'comment', id: comment.id },
      data: { comment: item, task_id: task.id },
    });
    notifyCommented(ctx.db, ctx.now, task, comment, me);

    return created(item, comment.version);
  });
}
