import { Command, Event, Model, Query } from 'murmur';
import { z } from 'zod';

export class Todo extends Model({ id: z.string(), title: z.string() }) {}

export class CreateTodo extends Command({ title: z.string().min(1) }, Todo) {}

export class GetTodo extends Query({ id: z.string() }, Todo.nullable()) {}

export class CountTodos extends Query({}, { total: z.number() }) {}

export class ArchiveTodo extends Command({ id: z.string() }, { archived: z.boolean() }) {}

export class ProbeNesting extends Command({}, { joined: z.number(), kept: z.number() }) {}

export class WriteRequested extends Event({ n: z.number() }) {}

export class CountWrites extends Query({}, { rows: z.number() }) {}

export class TodoCreated extends Event({ id: z.string(), title: z.string() }) {}

export class TodoArchived extends Event({ id: z.string(), title: z.string() }) {}
