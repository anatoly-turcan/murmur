import { sqlite } from '@murmur/node/capabilities';
import { Handle, Piece } from 'murmur';

import { GetStats, type Stats } from '#contracts/stats';
import { TodoCompleted, TodoCreated, TodoRemoved } from '#contracts/todos';

interface CountRow {
  readonly total: number;
  readonly done: number | null;
}

export class TodoStats extends Piece({ needs: { db: sqlite } }) {
  @Handle(TodoCreated)
  async created(event: TodoCreated): Promise<void> {
    await this.db.run('INSERT OR IGNORE INTO stats_todos (id, done) VALUES (?, 0)', event.id);
  }

  @Handle(TodoCompleted)
  async completed(event: TodoCompleted): Promise<void> {
    await this.db.run('UPDATE stats_todos SET done = 1 WHERE id = ?', event.id);
  }

  @Handle(TodoRemoved)
  async removed(event: TodoRemoved): Promise<void> {
    await this.db.run('DELETE FROM stats_todos WHERE id = ?', event.id);
  }

  @Handle(GetStats)
  async count(): Promise<Stats> {
    const row = await this.db.get<CountRow>('SELECT COUNT(*) AS total, SUM(done) AS done FROM stats_todos');

    return { total: row?.total ?? 0, done: row?.done ?? 0 };
  }
}
