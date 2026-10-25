import { sqlite } from '@murmur/node/capabilities';
import { Handle, Piece, reject, type Delivery, type Rejection } from 'murmur';

import {
  CompleteTodo,
  CreateTodo,
  GetTodo,
  ListTodos,
  RemoveTodo,
  type Todo,
  TodoCompleted,
  TodoCreated,
  TodoRemoved,
} from '#contracts/todos';

import { TodoRepository } from './repository.ts';

export class Todos extends Piece({
  needs: { db: sqlite },
  emits: [TodoCreated, TodoCompleted, TodoRemoved],
}) {
  private readonly todos = new TodoRepository(this.db);

  @Handle(CreateTodo)
  async create(input: CreateTodo, delivery: Delivery): Promise<Todo> {
    const fresh = { id: this.ids.uuid(), title: input.title, createdAt: this.clock.now().toString() };
    const claim = await this.todos.claim(delivery.envelope.id, fresh);

    if (!claim.announced) {
      await this.emit(TodoCreated, { id: claim.todo.id, title: claim.todo.title });
      await this.todos.markAnnounced(delivery.envelope.id);
    }

    return claim.todo;
  }

  @Handle(GetTodo)
  async get(input: GetTodo): Promise<Todo | null> {
    return this.todos.find(input.id);
  }

  @Handle(ListTodos)
  async list(input: ListTodos): Promise<Todo[]> {
    return this.todos.list(input.done);
  }

  @Handle(CompleteTodo)
  async complete(input: CompleteTodo): Promise<Todo | Rejection> {
    const changed = await this.todos.markDone(input.id);
    const todo = await this.todos.find(input.id);

    if (todo === null) {
      return reject(404, `todo ${input.id} not found`);
    }

    if (changed) {
      await this.emit(TodoCompleted, { id: todo.id });
    }

    return todo;
  }

  @Handle(RemoveTodo)
  async remove(input: RemoveTodo): Promise<Todo | null> {
    const removed = await this.todos.remove(input.id);
    if (removed === null) {
      return null;
    }

    await this.emit(TodoRemoved, { id: removed.id });

    return removed;
  }
}
