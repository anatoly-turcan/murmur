import type { Sqlite } from '@murmur/node/capabilities';
import { Model } from 'murmur';
import { z } from 'zod';

import { Todo } from '#contracts/todos';

class PositionedTodo extends Model({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  created_at: z.string(),
  seq: z.number().int(),
}) {}

interface RequestRow {
  readonly todo_id: string;
  readonly announced: number;
}

export interface FreshTodo {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
}

export interface Claim {
  readonly todo: Todo;
  readonly created: boolean;
  readonly announced: boolean;
}

const SELECT = 'SELECT id, title, done FROM todos';

export function claimTodo(db: Sqlite, requestId: string, fresh: FreshTodo): Promise<Claim> {
  return db.transaction(async (tx) => {
    const claimed = await tx.run(
      'INSERT OR IGNORE INTO todo_requests (envelope_id, todo_id) VALUES (?, ?)',
      requestId,
      fresh.id,
    );

    if (claimed.changes > 0) {
      await tx.insert('todos', { id: fresh.id, title: fresh.title, done: 0, created_at: fresh.createdAt });
    }

    const request = await tx.get<RequestRow>(
      'SELECT todo_id, announced FROM todo_requests WHERE envelope_id = ?',
      requestId,
    );

    const id = request?.todo_id ?? fresh.id;
    const todo = await findTodo(tx, id);

    return {
      todo: todo ?? { id, title: fresh.title, done: false },
      created: claimed.changes > 0,
      announced: request?.announced === 1,
    };
  });
}

export async function markAnnounced(db: Sqlite, requestId: string): Promise<void> {
  await db.run('UPDATE todo_requests SET announced = 1 WHERE envelope_id = ?', requestId);
}

export function findTodo(db: Sqlite, id: string): Promise<Todo | null> {
  return db.row(Todo, `${SELECT} WHERE id = ?`, id);
}

export const TodoPosition = z.tuple([z.string(), z.number().int()]);
export type TodoPosition = readonly [createdAt: string, seq: number];

export interface ListQuery {
  readonly done: boolean | undefined;
  readonly limit: number;
  readonly after: TodoPosition | null;
}

export interface TodoSlice {
  readonly todos: Todo[];
  readonly next: TodoPosition | null;
}

function listFilter(query: ListQuery): { where: string; params: (string | number)[] } {
  const clauses = [
    ...(query.done === undefined ? [] : ['done = ?']),
    ...(query.after === null ? [] : ['(created_at, rowid) > (?, ?)']),
  ];
  const params = [...(query.done === undefined ? [] : [Number(query.done)]), ...(query.after ?? [])];

  return { where: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`, params };
}

export async function listTodos(db: Sqlite, query: ListQuery): Promise<TodoSlice> {
  const { where, params } = listFilter(query);

  const rows = await db.rows(
    PositionedTodo,
    `SELECT id, title, done, created_at, rowid AS seq FROM todos${where} ORDER BY created_at, rowid LIMIT ?`,
    ...params,
    query.limit + 1,
  );

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);

  return {
    todos: page.map(({ id, title, done }) => ({ id, title, done })),
    next: rows.length > query.limit && last !== undefined ? [last.created_at, last.seq] : null,
  };
}

export function searchTodos(db: Sqlite, q: string): Promise<Todo[]> {
  return db.rows(Todo, `${SELECT} WHERE instr(lower(title), lower(?)) > 0 ORDER BY created_at, rowid`, q);
}

export async function markDone(db: Sqlite, id: string): Promise<boolean> {
  const result = await db.run('UPDATE todos SET done = 1 WHERE id = ? AND done = 0', id);

  return result.changes > 0;
}

export function removeTodo(db: Sqlite, id: string): Promise<Todo | null> {
  return db.row(Todo, 'DELETE FROM todos WHERE id = ? RETURNING id, title, done', id);
}
