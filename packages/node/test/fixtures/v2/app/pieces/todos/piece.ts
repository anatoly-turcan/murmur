import { sqlite } from '@murmur/node/capabilities';
import { Handle, Piece } from 'murmur';

import {
  ArchiveTodo,
  CountTodos,
  CountWrites,
  CreateTodo,
  GetTodo,
  ProbeNesting,
  type Todo,
  TodoArchived,
  TodoCreated,
  WriteRequested,
} from '../../contracts/todos.ts';
import { TodoRepository } from './repository.ts';

export class Todos extends Piece({
  needs: { db: sqlite },
  emits: [TodoCreated],
  policy: { concurrency: 8 },
}) {
  private readonly todos = new TodoRepository(this.db);

  @Handle(CreateTodo)
  async create(input: CreateTodo): Promise<Todo> {
    const todo = { id: this.ids.uuid(), title: input.title };
    await this.todos.insert(todo);
    await this.emit(TodoCreated, todo);

    return todo;
  }

  @Handle(GetTodo)
  async get(input: GetTodo): Promise<Todo | null> {
    return this.todos.find(input.id);
  }

  @Handle(CountTodos)
  async count(): Promise<{ total: number }> {
    return { total: await this.todos.count() };
  }

  @Handle(ArchiveTodo)
  async archive(input: ArchiveTodo): Promise<{ archived: boolean }> {
    await this.emit(TodoArchived, { id: input.id, title: 'archived' });

    return { archived: true };
  }

  @Handle(ProbeNesting)
  async probe(): Promise<{ joined: number; kept: number }> {
    let joined = 0;

    await this.db
      .transaction(async (tx) => {
        await tx.run('INSERT INTO writes (n, phase) VALUES (?, ?)', -1, 'outer');

        await this.db.transaction((inner) =>
          inner.run('INSERT INTO writes (n, phase) VALUES (?, ?)', -2, 'inner'),
        );

        const row = await this.db.get<{ rows: number }>('SELECT count(*) AS rows FROM writes WHERE n < 0');
        joined = row?.rows ?? 0;
        throw new Error('roll back');
      })
      .catch(() => undefined);

    const kept = await this.db.get<{ rows: number }>('SELECT count(*) AS rows FROM writes WHERE n < 0');

    return { joined, kept: kept?.rows ?? 0 };
  }

  @Handle(WriteRequested)
  async write(event: WriteRequested): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('INSERT INTO writes (n, phase) VALUES (?, ?)', event.n, 'before');
      await this.clock.sleep(5);
      await tx.run('INSERT INTO writes (n, phase) VALUES (?, ?)', event.n, 'after');
    });

    await this.db.get('SELECT count(*) AS rows FROM writes');
  }

  @Handle(CountWrites)
  async writes(): Promise<{ rows: number }> {
    const row = await this.db.get<{ rows: number }>('SELECT count(*) AS rows FROM writes WHERE n >= 0');

    return { rows: row?.rows ?? 0 };
  }
}
