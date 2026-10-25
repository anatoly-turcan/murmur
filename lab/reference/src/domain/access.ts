import type { DatabaseSync } from 'node:sqlite';
import { one } from '../db/sql.ts';
import { isAssignableRole } from './roles.ts';
import type { Role } from './rows.ts';
import type { Id } from '../ids/uuid.ts';

export function roleOf(db: DatabaseSync, workspaceId: Id, userId: Id): Role | null {
  return one<{ role: Role }>(db, 'SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId)?.role ?? null;
}

export function isMember(db: DatabaseSync, workspaceId: Id, userId: Id): boolean {
  return roleOf(db, workspaceId, userId) !== null;
}

export function isAssignable(db: DatabaseSync, workspaceId: Id, userId: Id): boolean {
  const row = one<{ role: Role }>(
    db,
    `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.user_id = ? AND u.deactivated_at IS NULL`,
    workspaceId,
    userId,
  );

  return isAssignableRole(row?.role ?? null);
}
