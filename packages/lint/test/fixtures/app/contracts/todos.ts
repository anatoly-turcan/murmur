import { Command, Event, Model, Query } from 'murmur';
import { z } from 'zod';

export class Todo extends Model({ id: z.string(), title: z.string(), done: z.boolean() }) {}

export class CreateTodo extends Command({ title: z.string().min(1) }, Todo) {}

export class GetTodo extends Query({ id: z.string() }, Todo.nullable()) {}

export class TodoCreated extends Event({ id: z.string(), title: z.string() }) {}

export class TodoRemoved extends Event({ id: z.string() }) {}
