import type { DatabaseSync } from 'node:sqlite';
import { one } from '../db/sql.ts';
import { conflict, type ApiError } from '../http/errors.ts';
import { firstFreeSlug, slugBase, slugKey } from '../text/slug.ts';
import type { Id } from '../ids/uuid.ts';

export function workspaceSlugTaken(db: DatabaseSync, slug: string, exceptId: Id | null = null): boolean {
  return (
    one(db, 'SELECT 1 AS x FROM workspaces WHERE slug_key = ? AND deleted_at IS NULL AND id IS NOT ?', slugKey(slug), exceptId) !==
    undefined
  );
}

export function projectSlugTaken(db: DatabaseSync, workspaceId: Id, slug: string, exceptId: Id | null = null): boolean {
  return (
    one(
      db,
      'SELECT 1 AS x FROM projects WHERE workspace_id = ? AND slug_key = ? AND deleted_at IS NULL AND id IS NOT ?',
      workspaceId,
      slugKey(slug),
      exceptId,
    ) !== undefined
  );
}

export function slugTaken(): ApiError {
  return conflict('slug_taken', 'This slug is already in use.');
}

export function chooseSlug(given: string | undefined, name: string, fallback: string, isTaken: (slug: string) => boolean): string {
  if (given === undefined) return firstFreeSlug(slugBase(name, fallback), isTaken);
  if (isTaken(given)) throw slugTaken();

  return given;
}
