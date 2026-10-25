import { Command, Event, Model, Query } from 'murmur';
import { z } from 'zod';

export class Todo extends Model({ id: z.string(), title: z.string() }) {}

export class TodoCreateRequested extends Command({ title: z.string() }, Todo, {
  name: 'todos.create.requested',
}) {}

export class TodoCreated extends Event({ id: z.string(), title: z.string() }, { name: 'todos.created' }) {}

export class TodoListRequested extends Query({}, { items: Todo.array() }, { name: 'todos.list.requested' }) {}
