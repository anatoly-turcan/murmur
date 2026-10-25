import type { DatabaseSync } from 'node:sqlite';
import { one } from '../db/sql.ts';
import type { Params, ScopeResolver } from './types.ts';
import type { Id } from '../ids/uuid.ts';

function lookup(sql: string, param: string): ScopeResolver {
  return (db: DatabaseSync, params: Params) => one<{ ws: Id }>(db, sql, params[param])?.ws ?? null;
}

export const byWorkspace = (param = 'id'): ScopeResolver => lookup('SELECT id AS ws FROM workspaces WHERE id = ?', param);
export const byProject = (param = 'id'): ScopeResolver => lookup('SELECT workspace_id AS ws FROM projects WHERE id = ?', param);
export const byTask = (param = 'id'): ScopeResolver => lookup('SELECT workspace_id AS ws FROM tasks WHERE id = ?', param);
export const byComment = (param = 'id'): ScopeResolver => lookup('SELECT workspace_id AS ws FROM comments WHERE id = ?', param);
export const byWebhook = (param = 'id'): ScopeResolver => lookup('SELECT workspace_id AS ws FROM webhook_endpoints WHERE id = ?', param);
