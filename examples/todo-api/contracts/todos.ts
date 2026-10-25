import { Command, Event, Model, Page, Paging, Query, rejectable } from 'murmur';
import { z } from 'zod';

export class Todo extends Model({ id: z.string(), title: z.string(), done: z.boolean() }) {}

export class CreateTodo extends Command({ title: z.string().min(1).max(200) }, Todo) {}

export class CompleteTodo extends Command({ id: z.string() }, Todo.nullable()) {}

export class RemoveTodo extends Command({ id: z.string() }, Todo.nullable()) {}

export class GetTodo extends Query({ id: z.string() }, Todo.nullable()) {}

export class ListTodos extends Query(
  { done: z.boolean().optional(), ...Paging({ max: 100 }) },
  rejectable(Page(Todo)),
) {}

export class SearchTodos extends Query({ q: z.string().min(1).max(200) }, Todo.array()) {}

export class TodoCreated extends Event({ id: z.string(), title: z.string() }) {}

export class TodoCompleted extends Event({ id: z.string() }) {}

export class TodoRemoved extends Event({ id: z.string() }) {}
