import type { DatabaseSync } from 'node:sqlite';
import { actorRef, actorRefById } from '../../domain/actor.ts';
import type { CommentRow, UserRow } from '../../domain/rows.ts';
import { iso, isoOrNull } from '../../time/format.ts';
import type { Id } from '../../ids/uuid.ts';

export interface CommentWithAuthor extends CommentRow {
  author_name: string;
  author_deactivated_at: number | null;
}

export const COMMENT_SELECT = `SELECT c.*, u.name AS author_name, u.deactivated_at AS author_deactivated_at
  FROM comments c JOIN users u ON u.id = c.author_id`;

function body(c: CommentRow, author: { id: Id; name: string; deleted: boolean }): Record<string, unknown> {
  return {
    id: c.id,
    task_id: c.task_id,
    workspace_id: c.workspace_id,
    author,
    body: c.body,
    edited: c.edited === 1,
    version: c.version,
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
    deleted_at: isoOrNull(c.deleted_at),
  };
}

export function serializeCommentRow(c: CommentWithAuthor): Record<string, unknown> {
  return body(c, actorRef({ id: c.author_id, name: c.author_name, deactivated_at: c.author_deactivated_at }));
}

export function serializeComment(db: DatabaseSync, c: CommentRow, author?: UserRow): Record<string, unknown> {
  return body(c, author ? actorRef(author) : actorRefById(db, c.author_id));
}
