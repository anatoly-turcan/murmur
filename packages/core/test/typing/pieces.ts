import { Handle, Piece, reject, Serve, type Delivery, type Rejection } from 'murmur';
import { z } from 'zod';

import { Authenticate, type Principal, type Quota, RateLimit } from '../fixtures/v2/contracts/auth.ts';
import {
  CompleteTodo,
  CreateTodo,
  GetTodo,
  ListTodos,
  type Todo,
  TodoCreated,
  TodoRemoved,
} from '../fixtures/v2/contracts/todos.ts';
import web, { open, sqlite, type Db, type WebRequest } from './capabilities.ts';
import type { HttpRequest } from './http.ts';

class TodoRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async find(id: string): Promise<Todo | null> {
    const row = await this.db.get<Todo>('SELECT id, title, done FROM todos WHERE id = ?', id);

    return row ?? null;
  }
}

export class Todos extends Piece({
  needs: { db: sqlite },
  emits: [TodoCreated, TodoRemoved],
}) {
  private readonly todos = new TodoRepository(this.db);

  @Handle(CreateTodo)
  async create(input: CreateTodo, delivery: Delivery): Promise<Todo> {
    const todo = { id: this.ids.uuid(), title: input.title, done: false };

    await this.db.run(
      'INSERT INTO todos VALUES (?, ?, ?)',
      todo.id,
      delivery.envelope.id,
      this.clock.now().toString(),
    );

    await this.emit(TodoCreated, { id: todo.id, title: todo.title });

    return todo;
  }

  @Handle(GetTodo)
  async get(input: GetTodo) {
    return this.todos.find(input.id);
  }

  @Handle(ListTodos)
  async list(input: ListTodos) {
    const done = input.done ?? false;

    return done ? [] : [{ id: '1', title: 'milk', done }];
  }

  @Handle(CompleteTodo)
  async complete(input: CompleteTodo): Promise<Todo | null> {
    const todo = await this.todos.find(input.id);
    if (todo === null) {
      return null;
    }

    await this.emit(TodoRemoved, { id: todo.id });

    return { ...todo, done: true };
  }
}

export class Auth extends Piece({
  config: {
    tokens: z.record(z.string(), z.string()),
    perMinute: z.number().int().positive().default(60),
  },
}) {
  @Handle(Authenticate)
  async authenticate(input: Authenticate): Promise<Principal | Rejection> {
    const userId = this.config.tokens[input.headers['authorization'] ?? ''];
    if (userId === undefined) {
      return reject(401, 'x');
    }

    return { userId, roles: [] };
  }

  @Handle(RateLimit)
  async limit(input: RateLimit) {
    if (input.operation === 'GET /blocked') {
      return reject(429, 'rate limit exceeded', { details: { perMinute: this.config.perMinute } });
    }

    const remaining: number = this.config.perMinute;

    return { remaining };
  }
}

@Serve(web.get('/todos'), ListTodos)
@Serve(web.post('/todos/:id/complete'), CompleteTodo)
@Serve(web.get('/todos/:id/again', { skip: [Authenticate] }), GetTodo)
export class RestApi extends Piece() {
  @Serve(web.post('/todos'))
  async create(req: WebRequest) {
    const { body } = await req.read({ body: CreateTodo.input });
    const todo = await this.request(CreateTodo, body);
    this.log.info('todo created', { id: todo.id, by: req.auth.userId, remaining: req.auth.remaining });

    return Response.json(todo, { status: 201 });
  }

  @Serve(web.get('/todos/:id'))
  async show(req: WebRequest, delivery: Delivery) {
    const { params } = await req.read({ params: { id: z.string() } });
    const todo = await this.request(GetTodo, { id: params.id });
    this.log.info('todo shown', { trace: delivery.envelope.id });

    return req.reply(todo, { etag: (found) => found.id });
  }

  @Serve(web.get('/stats', { skip: [Authenticate] }))
  stats(req: HttpRequest<Quota>) {
    return { remaining: req.auth.remaining };
  }

  @Serve(open.get('/health'))
  health(req: HttpRequest) {
    return { ok: true, auth: req.auth ?? null };
  }

  @Serve(web.delete('/todos/:id'))
  remove() {
    return undefined;
  }
}

export class TodosFeed extends Piece() {
  private readonly clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  @Serve(web.get('/events/todos'))
  stream(req: WebRequest) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.clients.add(controller);
        req.signal.addEventListener('abort', () => {
          this.clients.delete(controller);
        });
      },
    });

    return new Response(body);
  }

  @Handle(TodoCreated)
  created(event: TodoCreated): void {
    this.log.info('created', { id: event.id, clients: this.clients.size });
  }
}

export class Empty extends Piece() {
  async onStart(): Promise<void> {
    this.log.info('started');
  }
}
