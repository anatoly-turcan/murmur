import type { DatabaseSync } from 'node:sqlite';
import { one } from '../../db/sql.ts';
import type { Role } from '../../domain/rows.ts';
import { iso } from '../../time/format.ts';
import type { Id } from '../../ids/uuid.ts';

export interface MemberRow {
  workspace_id: Id;
  user_id: Id;
  role: Role;
  joined_at: number;
  name: string;
  email: string;
}

export const MEMBER_SELECT = `SELECT m.workspace_id, m.user_id, m.role, m.joined_at, u.name, u.email
  FROM memberships m JOIN users u ON u.id = m.user_id`;

export function serializeMember(row: MemberRow): Record<string, unknown> {
  return { user: { id: row.user_id, name: row.name, email: row.email }, role: row.role, joined_at: iso(row.joined_at) };
}

export function loadMember(db: DatabaseSync, workspaceId: Id, userId: Id): MemberRow | undefined {
  return one<MemberRow>(db, `${MEMBER_SELECT} WHERE m.workspace_id = ? AND m.user_id = ?`, workspaceId, userId);
}
