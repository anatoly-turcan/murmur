import { nanoid } from 'nanoid';

import type { Todo } from '#contracts/todos';

const blank: Todo = { id: '', title: '', done: false };

type Row = typeof blank;

export class TodoRepository {
  private readonly rows = new Map<string, Row>();

  insert(title: string): Todo {
    const todo = { ...blank, id: nanoid(), title };
    this.rows.set(todo.id, todo);

    return todo;
  }

  find(id: string): Todo | null {
    return this.rows.get(id) ?? null;
  }

  label(todo: Todo): string {
    return todo.title === '' ? (todo.done ? 'done' : 'untitled') : 'open';
  }
}
