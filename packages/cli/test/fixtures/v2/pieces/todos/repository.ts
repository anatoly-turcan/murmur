import type { Sqlite } from '@murmur/node/capabilities';

import type { Todo } from '#contracts/todos';

interface TodoRow {
  readonly id: string;
  readonly title: string;
  readonly done: number;
}

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
  readonly announced: boolean;
}

const SELECT = 'SELECT id, title, done FROM todos';

export class TodoRepository {
  private readonly db: Sqlite;

  constructor(db: Sqlite) {
    this.db = db;
  }

  async claim(requestId: string, fresh: FreshTodo): Promise<Claim> {
    return this.db.transaction(async (tx) => {
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
      const row = await tx.get<TodoRow>(`${SELECT} WHERE id = ?`, id);
      const todo = row === undefined ? { id, title: fresh.title, done: false } : toTodo(row);

      return { todo, announced: request?.announced === 1 };
    });
  }

  async markAnnounced(requestId: string): Promise<void> {
    await this.db.run('UPDATE todo_requests SET announced = 1 WHERE envelope_id = ?', requestId);
  }

  async find(id: string): Promise<Todo | null> {
    const row = await this.db.get<TodoRow>(`${SELECT} WHERE id = ?`, id);
    if (row === undefined) {
      return null;
    }

    return toTodo(row);
  }

  async list(done: boolean | undefined): Promise<Todo[]> {
    if (done === undefined) {
      const rows = await this.db.all<TodoRow>(`${SELECT} ORDER BY created_at, rowid`);

      return rows.map(toTodo);
    }

    const flag = Number(done);
    const rows = await this.db.all<TodoRow>(`${SELECT} WHERE done = ? ORDER BY created_at, rowid`, flag);

    return rows.map(toTodo);
  }

  async markDone(id: string): Promise<boolean> {
    const result = await this.db.run('UPDATE todos SET done = 1 WHERE id = ? AND done = 0', id);

    return result.changes > 0;
  }

  async remove(id: string): Promise<Todo | null> {
    const row = await this.db.get<TodoRow>('DELETE FROM todos WHERE id = ? RETURNING id, title, done', id);
    if (row === undefined) {
      return null;
    }

    return toTodo(row);
  }
}

function toTodo(row: TodoRow): Todo {
  return { id: row.id, title: row.title, done: row.done === 1 };
}
