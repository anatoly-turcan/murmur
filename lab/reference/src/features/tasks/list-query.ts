import type { SqlValue } from '../../db/sql.ts';
import type { TaskRow, UserRow } from '../../domain/rows.ts';
import { q, type QuerySpec, type QueryValues } from '../../http/query.ts';
import { fold } from '../../text/normalize.ts';
import { localDate } from '../../time/zones.ts';
import { TASK_STATUSES } from './fields.ts';
import type { Id } from '../../ids/uuid.ts';

const TASK_SORTS = ['created_at', 'updated_at', 'due_date'] as const;
type TaskSort = (typeof TASK_SORTS)[number];

const COMMON_QUERY: QuerySpec = {
  status: q.enumList(TASK_STATUSES),
  assignee_id: q.idOr(['me', 'none'] as const, 'user'),
  label: q.repeat(1, 40),
  due_before: q.date(),
  due_after: q.date(),
  overdue: q.bool(),
  sort: q.enumOne(TASK_SORTS, 'created_at'),
  include_deleted: q.bool(false),
};

export const PROJECT_TASKS_QUERY: QuerySpec = COMMON_QUERY;

export const WORKSPACE_TASKS_QUERY: QuerySpec = { ...COMMON_QUERY, project_id: q.id('project') };

export interface TaskListScope {
  column: 'project_id' | 'workspace_id';
  id: Id;
}

export interface TaskListRequest {
  scope: TaskListScope;
  query: QueryValues;
  after: unknown[] | null;
  limit: number;
  me: UserRow;
  now: number;
}

interface SortSpec {
  order: string;
  keyset: string;
  keyOf(row: TaskRow): unknown[];
}

const SORTS: Record<TaskSort, SortSpec> = {
  created_at: {
    order: 't.created_at DESC, t.id DESC',
    keyset: '(t.created_at, t.id) < (?, ?)',
    keyOf: (r) => [r.created_at, r.id],
  },
  updated_at: {
    order: 't.updated_at DESC, t.id DESC',
    keyset: '(t.updated_at, t.id) < (?, ?)',
    keyOf: (r) => [r.updated_at, r.id],
  },
  due_date: {
    order: 't.due_date IS NULL, t.due_date, t.id',
    keyset: "(t.due_date IS NULL, COALESCE(t.due_date, ''), t.id) > (?, ?, ?)",
    keyOf: (r) => [r.due_date === null ? 1 : 0, r.due_date ?? '', r.id],
  },
};

const OVERDUE = "(t.status <> 'done' AND t.due_date IS NOT NULL AND t.due_date < ?)";

class Conditions {
  readonly clauses: string[] = [];
  readonly params: SqlValue[] = [];

  add(clause: string, ...params: SqlValue[]): void {
    this.clauses.push(clause);
    this.params.push(...params);
  }
}

function assigneeCondition(where: Conditions, value: unknown, me: UserRow): void {
  if (value === undefined) return;
  if (value === 'none') where.add('t.assignee_id IS NULL');
  else where.add('t.assignee_id = ?', value === 'me' ? me.id : (value as number));
}

function overdueCondition(where: Conditions, value: unknown, me: UserRow, now: number): void {
  if (value === undefined) return;
  where.add(value === true ? OVERDUE : `NOT ${OVERDUE}`, localDate(now, me.timezone));
}

function filterConditions(req: TaskListRequest): Conditions {
  const { query } = req;
  const where = new Conditions();
  where.add(`t.${req.scope.column} = ?`, req.scope.id);
  where.add('p.deleted_at IS NULL');
  if (query.include_deleted !== true) where.add('t.deleted_at IS NULL');
  if (query.project_id !== undefined) where.add('t.project_id = ?', query.project_id as number);
  if (query.status !== undefined) where.add('t.status IN (SELECT value FROM json_each(?))', JSON.stringify(query.status));
  assigneeCondition(where, query.assignee_id, req.me);
  for (const label of (query.label as string[] | undefined) ?? []) {
    where.add('EXISTS (SELECT 1 FROM json_each(t.labels_fold) WHERE value = ?)', fold(label));
  }
  if (query.due_before !== undefined) where.add('t.due_date <= ?', query.due_before as string);
  if (query.due_after !== undefined) where.add('t.due_date >= ?', query.due_after as string);
  overdueCondition(where, query.overdue, req.me, req.now);

  return where;
}

export function sortOf(query: QueryValues): SortSpec {
  return SORTS[query.sort as TaskSort];
}

export function taskListSql(req: TaskListRequest): { sql: string; params: SqlValue[] } {
  const where = filterConditions(req);
  const sort = sortOf(req.query);
  if (req.after) where.add(sort.keyset, ...(req.after as SqlValue[]));
  const sql = `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE ${where.clauses.join(' AND ')} ORDER BY ${sort.order} LIMIT ?`;

  return { sql, params: [...where.params, req.limit + 1] };
}
