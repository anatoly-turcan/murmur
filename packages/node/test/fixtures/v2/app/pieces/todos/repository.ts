import type { Sqlite } from '@murmur/node';

import type { Todo } from '../../contracts/todos.ts';

export class TodoRepository {
  private readonly db: Sqlite;

  constructor(db: Sqlite) {
    this.db = db;
  }

  async insert(todo: Todo): Promise<void> {
    await this.db.run('INSERT INTO todos (id, title) VALUES (?, ?)', todo.id, todo.title);
  }

  async find(id: string): Promise<Todo | null> {
    const row = await this.db.get<Todo>('SELECT id, title FROM todos WHERE id = ?', id);

    return row ?? null;
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ total: number }>('SELECT count(*) AS total FROM todos');

    return row?.total ?? 0;
  }
}
