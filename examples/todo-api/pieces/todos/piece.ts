import { jobs, type Sqlite, sqlite } from '@murmur/node/capabilities';
import { cursor } from '@murmur/node/lib';
import { Handle, isRejection, Piece, type Delivery, type PageOf, type Rejection } from 'murmur';

import { NotifyTodo } from '#contracts/notifications';
import {
  CompleteTodo,
  CreateTodo,
  GetTodo,
  ListTodos,
  RemoveTodo,
  SearchTodos,
  type Todo,
  TodoCompleted,
  TodoCreated,
  TodoRemoved,
} from '#contracts/todos';

import {
  type Claim,
  claimTodo,
  findTodo,
  type FreshTodo,
  listTodos,
  markAnnounced,
  markDone,
  removeTodo,
  searchTodos,
  TodoPosition,
} from './repository.ts';

export class Todos extends Piece({
  needs: { db: sqlite, jobs },
  emits: [TodoCreated, TodoCompleted, TodoRemoved],
}) {
  @Handle(CreateTodo)
  async create(input: CreateTodo, delivery: Delivery): Promise<Todo> {
    const fresh = { id: this.ids.uuid(), title: input.title, createdAt: this.clock.now().toString() };
    const claim = await this.db.transaction(async (tx) => this.#claim(tx, delivery.envelope.id, fresh));

    if (!claim.announced) {
      await this.emit(TodoCreated, { id: claim.todo.id, title: claim.todo.title });
      await markAnnounced(this.db, delivery.envelope.id);
    }

    return claim.todo;
  }

  async #claim(tx: Sqlite, requestId: string, fresh: FreshTodo): Promise<Claim> {
    const claim = await claimTodo(tx, requestId, fresh);
    if (claim.created) {
      await this.jobs.enqueue(
        NotifyTodo,
        { id: claim.todo.id, title: claim.todo.title },
        { dedupeKey: `notify:${claim.todo.id}` },
      );
    }

    return claim;
  }

  @Handle(GetTodo)
  async get(input: GetTodo): Promise<Todo | null> {
    return findTodo(this.db, input.id);
  }

  @Handle(ListTodos)
  async list(input: ListTodos): Promise<PageOf<Todo> | Rejection> {
    const binding = `todos.ListTodos:${input.done ?? 'all'}`;
    const after = cursor.decode(binding, input.cursor, TodoPosition);

    if (isRejection(after)) {
      return after;
    }

    const slice = await listTodos(this.db, { done: input.done, limit: input.limit, after });

    return {
      data: slice.todos,
      next_cursor: slice.next === null ? null : cursor.encode(binding, slice.next),
    };
  }

  @Handle(SearchTodos)
  async search(input: SearchTodos): Promise<Todo[]> {
    return searchTodos(this.db, input.q);
  }

  @Handle(CompleteTodo)
  async complete(input: CompleteTodo): Promise<Todo | null> {
    const changed = await markDone(this.db, input.id);
    const todo = await findTodo(this.db, input.id);

    if (todo === null) {
      return null;
    }

    if (changed) {
      await this.emit(TodoCompleted, { id: todo.id });
    }

    return todo;
  }

  @Handle(RemoveTodo)
  async remove(input: RemoveTodo): Promise<Todo | null> {
    const removed = await removeTodo(this.db, input.id);
    if (removed === null) {
      return null;
    }

    await this.emit(TodoRemoved, { id: removed.id });

    return removed;
  }
}
