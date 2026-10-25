import { Handle, Piece } from 'murmur';

import { CreateTodo, type Todo, TodoCreated, TodoRemoved } from '#contracts/todos';
import * as todos from '#contracts/todos';

import { TodoRepository } from './repository.ts';

export class Todos extends Piece({ emits: [TodoCreated] }) {
  private readonly repository = new TodoRepository();

  @Handle(CreateTodo)
  async create(input: CreateTodo): Promise<Todo> {
    const todo = this.repository.insert(input.title);
    await this.emit(TodoRemoved, { id: todo.id });

    return todo;
  }

  @Handle(todos.GetTodo)
  async get(input: todos.GetTodo): Promise<Todo | null> {
    return this.repository.find(input.id);
  }
}
