# murmur 0.3.0 — API preview

The todo example (`examples/todo-api`) in full, followed by how failures look, one page on how to read a piece and the
style rules. Every code block below is the file in the example app (a test keeps them equal), so it compiles, passes
`murmur check` and runs. Read the code the way you would debug it: top to bottom, one file at a time, no hidden `ctx`,
no `typeof`, no second idiom for anything. The technical spec behind this surface is `.agents/docs/spec.md` in the
murmur repository.

```
examples/todo-api/
  murmur.config.ts  murmur.yaml  package.json
  capabilities/web/capability.ts   the configured http token: default guards, error codes, the WebRequest type
  contracts/todos.ts  contracts/stats.ts  contracts/auth.ts  contracts/notifications.ts
  lib/etag.ts              shared pure code (`#lib/etag`): the ETag of a todo
  pieces/todos/            domain: the one writer of the todos table (piece, repository, schema.sql, tests)
  pieces/stats/            domain: a read model counting todos
  pieces/auth/             guards: who is calling, how often
  pieces/notifier/         jobs: runs the NotifyTodo job todos enqueues, sweeps every minute (the worker process)
  pieces/api/rest/         edge: REST over the domain (/todos family and /stats; status, headers, ETag, 404, 204)
  pieces/api/feed/         edge: SSE stream over the same domain events (/events family)
```

## Contracts

`contracts/todos.ts`

```ts
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
```

Wire names are derived: `todos.CreateTodo`, `todos.TodoCreated`. `CreateTodo` is the value you request, the type of the
handler's input, and the owner of `CreateTodo.input` / `CreateTodo.output` / `CreateTodo.jsonSchema()`. Every contract
that can meet "not found" says so the same way, `Todo.nullable()`, so every such route can share the same `null → 404`.
A list spreads `...Paging({ max })` into its input (`limit`, default 20, and `cursor: string | null`) and answers
`Page(Todo)`, `{ data, next_cursor }`; `rejectable(...)` lets it return the 400 `invalid_cursor` of a bad cursor.

`contracts/stats.ts`

```ts
import { Model, Query } from 'murmur';
import { z } from 'zod';

export class Stats extends Model({ total: z.number(), done: z.number() }) {}

export class GetStats extends Query({}, Stats) {}
```

`contracts/auth.ts`

```ts
import { Guard, Model } from 'murmur';
import { z } from 'zod';

export class Principal extends Model({ userId: z.string(), roles: z.array(z.string()) }) {}

export class Quota extends Model({ remaining: z.number() }) {}

export class Authenticate extends Guard(Principal) {}

export class RateLimit extends Guard(Quota, { optional: [Authenticate] }) {}
```

A guard is a request contract with a fixed input (`{ transport, operation, headers, params, peer, ip, meta, prior }`)
and the output `Principal | Rejection`: the handler either returns the model, which lands on `req.auth`, or returns
`reject(status, message)`, which becomes the response. Nothing is thrown for a refusal. `optional: [Authenticate]`
makes `Authenticate` run first when a route keeps it, so `RateLimit` reads `input.prior.userId` (`string | undefined`).

Edges add guards with `guards`, drop them with `skip`, and fill a guard's `meta` shape with `meta`, all on the route.

`contracts/notifications.ts`

```ts
import { Command } from 'murmur';
import { z } from 'zod';

export class NotifyTodo extends Command({ id: z.string(), title: z.string() }, {}) {}

export class SweepNotifications extends Command({}, {}) {}
```

A job is an ordinary Command: `todos` enqueues `NotifyTodo` with `this.jobs.enqueue(...)` and `notifier` handles it. A
Command whose output is `{}` lets the handler return nothing.

## App definition

`capabilities/web/capability.ts`

```ts
import { http, type RequestOf } from '@murmur/node/capabilities';

import { Authenticate, RateLimit } from '#contracts/auth';

const web = http({
  guards: [Authenticate, RateLimit],
  log: (auth) => ({ user: auth.userId ?? null }),
});

export default web;

export type WebRequest = RequestOf<typeof web>;
```

This is the one place that knows the app's default guards, in the order they run. `log(auth)` adds `user` to the
one `access { method, path, status, ms, traceId }` line the token writes per request. Pieces import `web` for bindings and `WebRequest` for the
request parameter; nothing is generated, and the one `typeof` of the app lives here, outside piece code.

`murmur.config.ts`

```ts
import { defineApp } from '@murmur/node';
import { sqlite } from '@murmur/node/capabilities';
import { createMemoryTransport } from '@murmur/transport-memory';

export default defineApp({
  name: 'todo-api',
  transport: () => createMemoryTransport(),
  capabilities: [sqlite],
  processes: {
    api: { pieces: ['api/**', 'auth', 'todos', 'stats'], jobs: false },
    worker: { pieces: ['notifier'] },
  },
});
```

`package.json` (the three aliases)

```json
{
  "imports": {
    "#contracts/*": "./contracts/*.ts",
    "#capabilities/*": "./capabilities/*/capability.ts",
    "#lib/*": "./lib/*.ts"
  }
}
```

`lib/` holds shared pure code (`lib/etag.ts` below), imported as `#lib/etag` from any piece, capability or test: no I/O
modules, no `#capabilities`, no top-level `let` (lint `lib-pure`). `murmur ctx lib/etag` prints its signatures and tests.

`murmur.yaml`

```yaml
pieces:
  auth:
    tokens:
      ada: ada
      root: root
    perMinute: 60
capabilities:
  sqlite:
    path: '${DATABASE_PATH:-./todo.db}'
  web:
    port: ${PORT:-3000}
```

There is no root `schema.sql`: each piece carries the DDL of the tables it owns, and `capabilities.sqlite.migrations`
defaults to `pieces/**/schema.sql` then `migrations/*.sql`. Boot applies that list; `pnpm exec murmur migrate` applies
the same list without starting the app (a deploy step).

Run it with `pnpm exec murmur start api` and `pnpm exec murmur start worker`: each pid is a runtime, SIGTERM drains it
and exits 0 (`murmur start` with no name loads every piece). The two processes share `todo.db` (WAL, `BEGIN
IMMEDIATE`, `busyTimeoutMs` 5000); `processes` names which pieces each one constructs, by piece id. `api` claims no
jobs (`jobs: false`); `worker` serves no route, so the `web` token opens no port there
(`capabilities.web.healthz: true` keeps `/healthz`). A piece that serves the
literal path `GET /healthz` replaces the built-in answer, and `req.peer` / `req.ip` (`capabilities.web.trustProxy: true`
behind your proxy) name the caller.

## Domain piece: `pieces/todos/`

`pieces/todos/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todo_requests (
  envelope_id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL,
  announced INTEGER NOT NULL DEFAULT 0
);
```

`pieces/todos/piece.ts`

```ts
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
```

`CreateTodo` writes the todo, its `todo_requests` claim and the `NotifyTodo` job in one `this.db.transaction(async (tx)
=> …)`: a rollback leaves no todo and no job, and `this.jobs.enqueue` joins the transaction of the same delivery. The
job crosses to the `worker` process through `murmur_jobs`; `TodoCreated` stays in this process on the memory transport.

`pieces/todos/repository.ts`

```ts
import type { Sqlite } from '@murmur/node/capabilities';
import { Model } from 'murmur';
import { z } from 'zod';

import { Todo } from '#contracts/todos';

class PositionedTodo extends Model({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  created_at: z.string(),
  seq: z.number().int(),
}) {}

interface RequestRow {
  readonly todo_id: string;
  readonly announced: number;
}

export interface FreshTodo {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
}

export interface Claim {
  readonly todo: Todo;
  readonly created: boolean;
  readonly announced: boolean;
}

const SELECT = 'SELECT id, title, done FROM todos';

export function claimTodo(db: Sqlite, requestId: string, fresh: FreshTodo): Promise<Claim> {
  return db.transaction(async (tx) => {
    const claimed = await tx.run(
      'INSERT OR IGNORE INTO todo_requests (envelope_id, todo_id) VALUES (?, ?)',
      requestId,
      fresh.id,
    );

    if (claimed.changes > 0) {
      await tx.insert('todos', { id: fresh.id, title: fresh.title, done: 0, created_at: fresh.createdAt });
    }

    const request = await tx.get<RequestRow>(
      'SELECT todo_id, announced FROM todo_requests WHERE envelope_id = ?',
      requestId,
    );

    const id = request?.todo_id ?? fresh.id;
    const todo = await findTodo(tx, id);

    return {
      todo: todo ?? { id, title: fresh.title, done: false },
      created: claimed.changes > 0,
      announced: request?.announced === 1,
    };
  });
}

export async function markAnnounced(db: Sqlite, requestId: string): Promise<void> {
  await db.run('UPDATE todo_requests SET announced = 1 WHERE envelope_id = ?', requestId);
}

export function findTodo(db: Sqlite, id: string): Promise<Todo | null> {
  return db.row(Todo, `${SELECT} WHERE id = ?`, id);
}

export const TodoPosition = z.tuple([z.string(), z.number().int()]);
export type TodoPosition = readonly [createdAt: string, seq: number];

export interface ListQuery {
  readonly done: boolean | undefined;
  readonly limit: number;
  readonly after: TodoPosition | null;
}

export interface TodoSlice {
  readonly todos: Todo[];
  readonly next: TodoPosition | null;
}

function listFilter(query: ListQuery): { where: string; params: (string | number)[] } {
  const clauses = [
    ...(query.done === undefined ? [] : ['done = ?']),
    ...(query.after === null ? [] : ['(created_at, rowid) > (?, ?)']),
  ];
  const params = [...(query.done === undefined ? [] : [Number(query.done)]), ...(query.after ?? [])];

  return { where: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`, params };
}

export async function listTodos(db: Sqlite, query: ListQuery): Promise<TodoSlice> {
  const { where, params } = listFilter(query);

  const rows = await db.rows(
    PositionedTodo,
    `SELECT id, title, done, created_at, rowid AS seq FROM todos${where} ORDER BY created_at, rowid LIMIT ?`,
    ...params,
    query.limit + 1,
  );

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);

  return {
    todos: page.map(({ id, title, done }) => ({ id, title, done })),
    next: rows.length > query.limit && last !== undefined ? [last.created_at, last.seq] : null,
  };
}

export function searchTodos(db: Sqlite, q: string): Promise<Todo[]> {
  return db.rows(Todo, `${SELECT} WHERE instr(lower(title), lower(?)) > 0 ORDER BY created_at, rowid`, q);
}

export async function markDone(db: Sqlite, id: string): Promise<boolean> {
  const result = await db.run('UPDATE todos SET done = 1 WHERE id = ? AND done = 0', id);

  return result.changes > 0;
}

export function removeTodo(db: Sqlite, id: string): Promise<Todo | null> {
  return db.row(Todo, 'DELETE FROM todos WHERE id = ? RETURNING id, title, done', id);
}
```

`pieces/todos/context.md`

```markdown
---
title: Todos
summary: The one writer of the todos table — creates, reads, completes and removes todos, announcing each change.
---

# todos

## What

The one store of todos. Answers `CreateTodo`, `GetTodo`, `ListTodos`, `SearchTodos`, `CompleteTodo`, `RemoveTodo` and announces
`TodoCreated`, `TodoCompleted`, `TodoRemoved`; each new todo also enqueues one `NotifyTodo` job (run by `notifier` in
the `worker` process). Knows no transport: `api/rest` turns HTTP into these contracts.

## Why

The one writer of the `todos` table (another piece may read it if its context.md declares it). Create, read, complete
and remove change together (same rows, same mapping), so they live together; the read model (`stats`) and the edges
stay outside.

## Handles / Emits / Requests

Handles: todos.CreateTodo, todos.GetTodo, todos.ListTodos, todos.SearchTodos, todos.CompleteTodo, todos.RemoveTodo
Emits: todos.TodoCreated, todos.TodoCompleted, todos.TodoRemoved
Requests: none

## Needs

Needs: db=sqlite, jobs=jobs
Storage: `todos`, `todo_requests` (`./schema.sql`)

## Invariants

- `id` is a uuid from `this.ids`; `done` starts false; `created_at` is `Temporal.Instant.toString()`.
- `TodoCreated` is emitted only after the row is committed.
- The `NotifyTodo` job (`dedupeKey: notify:<id>`) is enqueued inside the insert's transaction: no todo, no job; a
  redelivered `CreateTodo` enqueues nothing. Events stay in this process on the memory transport, the job crosses to
  `worker` through `murmur_jobs`.
- A redelivered `CreateTodo` (same envelope id) inserts nothing, emits nothing and replies the same todo. How:
  `todo_requests` maps the envelope id to the todo id (`INSERT OR IGNORE`, one transaction with the todo insert);
  `announced` turns 1 after the emit, so a retry after a failed emit announces once more.
- Completing a done or unknown todo emits nothing; an unknown id replies `null`.
- Removing is one `DELETE … RETURNING`: the removed todo comes back, an unknown id replies `null` and emits nothing.
- `ListTodos` pages in creation order (`created_at`, then `rowid`): `limit + 1` rows, keyset `(created_at, rowid) > (?, ?)`
  from the decoded cursor; `next_cursor` encodes the last row's position bound to `todos.ListTodos:<done|all>`, so a
  cursor from another filter or a tampered one is returned as the 400 `invalid_cursor` Rejection.
- `SearchTodos` matches `q` as a plain substring of the title (`instr`, not `LIKE`: `%` and `_` are literal),
  case-insensitive for ASCII only (SQLite `lower`), in creation order.
- Business outcomes are outputs (`null`, the cursor Rejection), never exceptions; edges map them to status codes.

## Gotchas

- Two requests with the same title are two todos: dedupe on the envelope id, never on the title.
- A delivery that dies between the `TodoCreated` emit and `announced = 1` emits again on retry (at-least-once);
  consumers dedupe on the todo id.
- `TodoCompleted` is at-most-once: a crash after the update and before the emit retries against a done todo and stays
  quiet.
- A `CreateTodo` redelivered after its todo was removed replies the remembered id with `done: false` and inserts nothing.

## Out of scope

Status codes, ETags, `location` headers (`api/rest`); counts (`stats`); who may call (`auth`).
```

`pieces/todos/fixtures/create-todo.json`

```json
{ "title": "buy milk" }
```

`pieces/todos/piece.test.ts`

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cursor } from '@murmur/node/lib';
import { testPiece } from '@murmur/node/testing';
import { isRejection } from 'murmur';

import { NotifyTodo } from '#contracts/notifications';
import {
  CompleteTodo,
  CreateTodo,
  GetTodo,
  ListTodos,
  RemoveTodo,
  SearchTodos,
  TodoCompleted,
  TodoCreated,
  TodoRemoved,
} from '#contracts/todos';

import createTodo from './fixtures/create-todo.json' with { type: 'json' };
import { Todos } from './piece.ts';

test('create stores the todo, replies with it and emits TodoCreated', async () => {
  await using t = await testPiece(Todos);
  const todo = await t.deliverJson(CreateTodo, createTodo);
  const stored = await t.needs.db.get('SELECT title, done FROM todos WHERE id = ?', todo.id);

  assert.deepEqual(todo, { id: t.ids.issued[0], title: 'buy milk', done: false });
  assert.deepEqual(t.emitted(TodoCreated), [{ id: todo.id, title: 'buy milk' }]);
  assert.deepEqual(stored, { title: 'buy milk', done: 0 });
});

test('create enqueues one NotifyTodo with the insert; a redelivery enqueues nothing', async () => {
  await using t = await testPiece(Todos);
  const todo = await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1' });
  await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1', attempt: 2 });

  assert.deepEqual(t.enqueued(NotifyTodo), [
    { input: { id: todo.id, title: 'buy milk' }, options: { dedupeKey: `notify:${todo.id}` } },
  ]);
});

test('create refuses an empty title before the handler runs', async () => {
  await using t = await testPiece(Todos);
  await assert.rejects(t.deliver(CreateTodo, { title: '' }), { name: 'ContractViolationError' });
  assert.equal(t.emitted().length, 0);
});

test('a redelivered create inserts once, emits once and replies the same todo', async () => {
  await using t = await testPiece(Todos);
  const first = await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1' });
  const again = await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1', attempt: 2 });

  assert.deepEqual(again, first);
  assert.equal(t.emitted(TodoCreated).length, 1);
  assert.deepEqual(await t.needs.db.all('SELECT id FROM todos'), [{ id: first.id }]);
});

test('a create redelivered after its todo was removed replies the same id and inserts nothing', async () => {
  await using t = await testPiece(Todos);
  const first = await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1' });
  await t.deliver(RemoveTodo, { id: first.id });
  const again = await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1', attempt: 2 });

  assert.deepEqual(again, first);
  assert.equal(t.emitted(TodoCreated).length, 1);
  assert.deepEqual(await t.needs.db.all('SELECT id FROM todos'), []);
});

test('get and list read what create stored', async () => {
  await using t = await testPiece(Todos);
  const milk = await t.deliver(CreateTodo, { title: 'milk' });
  const bread = await t.deliver(CreateTodo, { title: 'bread' });
  assert.deepEqual(await t.deliver(GetTodo, { id: milk.id }), milk);
  assert.equal(await t.deliver(GetTodo, { id: 'nope' }), null);
  assert.deepEqual(await t.deliver(ListTodos, {}), { data: [milk, bread], next_cursor: null });
});

test('list pages by limit and next_cursor; a cursor of another filter or a garbled one is 400 invalid_cursor', async () => {
  await using t = await testPiece(Todos);
  const milk = await t.deliver(CreateTodo, { title: 'milk' });
  const bread = await t.deliver(CreateTodo, { title: 'bread' });
  const jam = await t.deliver(CreateTodo, { title: 'jam' });
  const first = await t.deliver(ListTodos, { limit: 2 });
  assert.ok(!isRejection(first));
  const second = await t.deliver(ListTodos, { limit: 2, cursor: first.next_cursor });
  const foreign = await t.deliver(ListTodos, { done: false, cursor: first.next_cursor });
  const garbled = await t.deliver(ListTodos, { cursor: 'nope' });

  assert.deepEqual(first.data, [milk, bread]);
  assert.match(first.next_cursor ?? '', /^[\w-]+$/);
  assert.deepEqual(second, { data: [jam], next_cursor: null });
  assert.equal(isRejection(foreign) && foreign.code, 'invalid_cursor');
  assert.equal(isRejection(garbled) && garbled.status, 400);
});

test('list answers 400 invalid_cursor to a cursor with a valid checksum but the wrong position shape', async () => {
  await using t = await testPiece(Todos);
  await t.deliver(CreateTodo, { title: 'milk' });

  const positions = [{ a: 1 }, 'x', [1], ['a', 'b', 'c'], ['2026-10-25', 1.5]];

  const forged = await Promise.all(
    positions.map((p) => t.deliver(ListTodos, { cursor: cursor.encode('todos.ListTodos:all', p) })),
  );

  assert.deepEqual(
    forged.map((reply) => isRejection(reply) && reply.code),
    positions.map(() => 'invalid_cursor'),
  );
});

test('search replies the todos whose title contains q, ignoring case, in creation order', async () => {
  await using t = await testPiece(Todos);
  const milk = await t.deliver(CreateTodo, { title: 'buy Milk' });
  await t.deliver(CreateTodo, { title: 'bread' });
  const oatMilk = await t.deliver(CreateTodo, { title: 'oat milk' });
  assert.deepEqual(await t.deliver(SearchTodos, { q: 'milk' }), [milk, oatMilk]);
  assert.deepEqual(await t.deliver(SearchTodos, { q: '%' }), []);
  await assert.rejects(t.deliver(SearchTodos, { q: '' }), { name: 'ContractViolationError' });
});

test('complete marks the todo done once and emits TodoCompleted once', async () => {
  await using t = await testPiece(Todos);
  const milk = await t.deliver(CreateTodo, { title: 'milk' });
  const done = await t.deliver(CompleteTodo, { id: milk.id });

  assert.deepEqual(done, { ...milk, done: true });
  assert.deepEqual(await t.deliver(CompleteTodo, { id: milk.id }), done);
  assert.deepEqual(t.emitted(TodoCompleted), [{ id: milk.id }]);
  assert.deepEqual(await t.deliver(ListTodos, { done: false }), { data: [], next_cursor: null });
});

test('complete of an unknown id replies null and emits nothing', async () => {
  await using t = await testPiece(Todos);
  assert.equal(await t.deliver(CompleteTodo, { id: 'nope' }), null);
  assert.equal(t.emitted().length, 0);
});

test('remove replies the removed todo, emits TodoRemoved, and replies null the second time', async () => {
  await using t = await testPiece(Todos);
  const milk = await t.deliver(CreateTodo, { title: 'milk' });
  assert.deepEqual(await t.deliver(RemoveTodo, { id: milk.id }), milk);
  assert.equal(await t.deliver(RemoveTodo, { id: milk.id }), null);
  assert.deepEqual(t.emitted(TodoRemoved), [{ id: milk.id }]);
  assert.equal(await t.deliver(GetTodo, { id: milk.id }), null);
});
```

`testPiece` comes from `@murmur/node/testing` because it runs every delivery inside the real async context: a handler
that awaits the database and then emits is still inside its delivery, and the fake sqlite joins that delivery's
transaction. It fakes every need the test leaves out: `db` is an in-memory sqlite with the app's migration list
applied (`t.needs.db` reads it), a `jobs` need records `t.enqueued(C)` and `await t.runJobs()` runs them.

## Domain piece: `pieces/stats/`

`pieces/stats/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS stats_todos (id TEXT PRIMARY KEY, done INTEGER NOT NULL DEFAULT 0);
```

`pieces/stats/piece.ts`

```ts
import { sqlite } from '@murmur/node/capabilities';
import { Handle, Piece } from 'murmur';

import { GetStats, type Stats } from '#contracts/stats';
import { TodoCompleted, TodoCreated, TodoRemoved } from '#contracts/todos';

interface CountRow {
  readonly total: number;
  readonly done: number | null;
}

export class TodoStats extends Piece({ needs: { db: sqlite } }) {
  @Handle(TodoCreated)
  async created(event: TodoCreated): Promise<void> {
    await this.db.run('INSERT OR IGNORE INTO stats_todos (id, done) VALUES (?, 0)', event.id);
  }

  @Handle(TodoCompleted)
  async completed(event: TodoCompleted): Promise<void> {
    await this.db.run('UPDATE stats_todos SET done = 1 WHERE id = ?', event.id);
  }

  @Handle(TodoRemoved)
  async removed(event: TodoRemoved): Promise<void> {
    await this.db.run('DELETE FROM stats_todos WHERE id = ?', event.id);
  }

  @Handle(GetStats)
  async count(): Promise<Stats> {
    const row = await this.db.get<CountRow>('SELECT COUNT(*) AS total, SUM(done) AS done FROM stats_todos');

    return { total: row?.total ?? 0, done: row?.done ?? 0 };
  }
}
```

## Job piece: `pieces/notifier/`

`pieces/notifier/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS notifications (
  todo_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
```

`pieces/notifier/piece.ts`

```ts
import { sqlite } from '@murmur/node/capabilities';
import { type Delivery, Handle, Piece } from 'murmur';

import { NotifyTodo, SweepNotifications } from '#contracts/notifications';

export class Notifier extends Piece({ needs: { db: sqlite } }) {
  @Handle(NotifyTodo, { retry: { attempts: 5, after: ['30s', '2m', '10m'] } })
  async notify(input: NotifyTodo, delivery: Delivery): Promise<void> {
    await this.db.run(
      'INSERT OR IGNORE INTO notifications (todo_id, title, sent_at) VALUES (?, ?, ?)',
      input.id,
      input.title,
      this.clock.now().toString(),
    );

    this.log.info('todo notification sent', { todoId: input.id, attempt: delivery.attempt });
  }

  @Handle(SweepNotifications, { every: '1m' })
  async sweep(): Promise<void> {
    const cutoff = this.clock.now().subtract({ hours: 24 }).toString();
    await this.db.run('DELETE FROM notifications WHERE sent_at < ?', cutoff);
  }
}
```

A job handler is an `@Handle` of a Command like any other; the options say how it runs as a job. `retry` is its ladder
(attempt 2 after 30s, 3 after 2m, then 10m; dead after the fifth failure; `NonRetryableError` is dead at once), and
`every: '1m'` schedules `SweepNotifications` once per minute across all processes on the database. `delivery.attempt`
is the job's attempt. The handler is idempotent by its table (`INSERT OR IGNORE` on `todo_id`), because a job that dies
mid-run is claimed again. `murmur tail` shows each run as kind `job`; tests run them with `await t.runJobs()` or
`await app.jobs.drain()`.

## Guard piece: `pieces/auth/`

`pieces/auth/piece.ts`

```ts
import { kv } from '@murmur/node/capabilities';
import { bearer } from '@murmur/node/lib';
import { Handle, Piece, reject, type Rejection } from 'murmur';
import { z } from 'zod';

import { Authenticate, type Principal, type Quota, RateLimit } from '#contracts/auth';

const WINDOW_MS = 60_000;

export class Auth extends Piece({
  needs: { kv },
  config: {
    tokens: z.record(z.string(), z.string()),
    perMinute: z.number().int().positive().default(60),
  },
}) {
  @Handle(Authenticate)
  async authenticate(input: Authenticate): Promise<Principal | Rejection> {
    const token = bearer(input.headers['authorization']);
    if (token === null) {
      return reject(401, 'missing bearer token');
    }

    const userId = this.config.tokens[token];
    if (userId === undefined) {
      return reject(401, 'unknown token');
    }

    return { userId, roles: rolesOf(userId) };
  }

  @Handle(RateLimit)
  async limit(input: RateLimit): Promise<Quota | Rejection> {
    const key = `rate:${input.prior.userId ?? input.ip}`;
    const { count, resetAt } = await this.kv.incr(key, { windowMs: WINDOW_MS });

    if (count > this.config.perMinute) {
      return reject(429, 'rate limit exceeded', {
        details: { perMinute: this.config.perMinute },
        headers: { 'retry-after': String(Math.ceil(resetAt.since(this.clock.now()).total('seconds'))) },
      });
    }

    return { remaining: this.config.perMinute - count };
  }
}

function rolesOf(userId: string): string[] {
  if (userId === 'root') {
    return ['admin'];
  }

  return [];
}
```

A refusal is a return value: the guard delivery is acked, the trace shows `rejected 401`, nothing is dead-lettered. A
guard that _throws_ is a broken guard: retried, dead-lettered, answered with 502. That is the whole difference between
"a client without a token" and "auth is down", and it is visible in `murmur tail --failed` at a glance. The two default
guards run in order: `Authenticate` refuses first, so a bad token never reaches `RateLimit` and uses no quota.

## Edge piece: `pieces/api/rest/`

`pieces/api/rest/piece.ts`

```ts
import type { HttpResult } from '@murmur/node/capabilities';
import { Piece, Serve } from 'murmur';
import { z } from 'zod';

import web, { type WebRequest } from '#capabilities/web';
import { Authenticate } from '#contracts/auth';
import { GetStats } from '#contracts/stats';
import { CompleteTodo, CreateTodo, GetTodo, ListTodos, RemoveTodo, SearchTodos } from '#contracts/todos';
import { etagOf } from '#lib/etag';

@Serve(web.get('/todos'), ListTodos)
@Serve(web.get('/todos/search'), SearchTodos)
@Serve(web.post('/todos/:id/complete'), CompleteTodo)
@Serve(web.delete('/todos/:id', { status: 204 }), RemoveTodo)
@Serve(web.get('/stats', { skip: [Authenticate] }), GetStats)
export class RestApi extends Piece() {
  @Serve(web.post('/todos', { status: 201, idempotent: { scope: ['auth.userId'] } }))
  async create(req: WebRequest): Promise<HttpResult> {
    const { body } = await req.read({ body: CreateTodo.input });
    const todo = await this.request(CreateTodo, body);

    return req.reply(todo, { headers: { location: `/todos/${todo.id}` }, etag: etagOf });
  }

  @Serve(web.get('/todos/:id'))
  async show(req: WebRequest): Promise<HttpResult> {
    const { params } = await req.read({ params: { id: z.string() } });

    return req.reply(await this.request(GetTodo, params), { etag: etagOf });
  }
}
```

`lib/etag.ts`

```ts
import { createHash } from 'node:crypto';

import type { Todo } from '#contracts/todos';

export function etagOf(todo: Todo): string {
  const digest = createHash('sha1').update(JSON.stringify(todo)).digest('hex');

  return `"${digest.slice(0, 16)}"`;
}
```

What to notice:

- **Seven routes, two methods.** The five class-level `@Serve(binding, Contract)` lines forward with the default mapping:
  input from params + query + body, the output rendered like a returned outcome (`null` → 404, a `Rejection` through
  the envelope, otherwise JSON); `{ status: 204 }` drops the body. Only the routes that need a header (`location`,
  `etag`) are methods. Read the file as "shorthands above the class, methods inside".
- **One way to read a request.** `req.read({ params, query, headers, body })` reads each part with its own schema, in
  that order, and answers the first failing part with the token's `errors.input` mapping (body 400 `invalid_input` by
  default, params 404, a non-JSON body 415) before anything is published. `murmur check` verifies that every key of an
  inline `params: { … }` shape is a `:param` of the binding, and that every `:param` is a field of `params: C.input`.
- **One response tail.** `req.reply(outcome, { status, headers, etag })`: `null` is 404 `not_found`, a `Rejection`
  renders unchanged, `etag` sends a strong ETag and answers a matching `If-None-Match` with 304. No 404 or 304
  branch in app code.
- **Client retries are a route option.** `idempotent: { scope: ['auth.userId'] }` on `POST /todos`: a repeated
  `Idempotency-Key` with the same body replays the stored 201 (`idempotent-replayed: true`), the same key with another
  body is 422, one still running is 409. The rows live in `murmur_idempotency` on the app database; no table or check
  in app code.
- **One request type.** `req: WebRequest` on every method; `req.auth` is `Principal & Quota` because of the token's
  default guards. `/stats` says `skip: [Authenticate]` and keeps `RateLimit`, so a shorthand serves it without a
  token but still metered; a method on such a route would declare `req: HttpRequest<Quota>` and tsc checks the match.
- **Transport lives here.** A `Response` is sent as is; a plain object or array becomes `200 application/json`;
  `return reject(status, message)` renders the app's error envelope with a stable `code`, so no piece imports a shared
  helper for it.
- **Families.** This piece owns `/todos…` and `/stats`; the SSE feed owns `/events…`. `GET /todos/search` goes in
  this file. A static route under another piece's `:id` (`/todos/events` next to `/todos/:id`) is a `murmur check`
  error, not a guess about router precedence.

`pieces/api/rest/piece.test.ts`

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testPiece } from '@murmur/node/testing';

import { CreateTodo, GetTodo, RemoveTodo, SearchTodos } from '#contracts/todos';

import { RestApi } from './piece.ts';

const ada = { userId: 'ada', roles: [], remaining: 9 };

interface ErrorBody {
  readonly error: { readonly code: string };
}

test('GET /todos/:id answers 200 with an etag, then 304 for the same etag', async () => {
  await using t = await testPiece(RestApi, { auth: ada });
  t.respond(GetTodo, (input) => ({ id: input.id, title: 'milk', done: false }));
  const first = await t.fetch(new Request('http://app/todos/t1'));
  const etag = first.headers.get('etag') ?? '';
  const second = await t.fetch(new Request('http://app/todos/t1', { headers: { 'if-none-match': etag } }));

  assert.equal(first.status, 200);
  assert.match(etag, /^"[0-9a-f]{16}"$/);
  assert.equal(second.status, 304);
});

test('GET /todos/search forwards q to SearchTodos and wins over /todos/:id', async () => {
  await using t = await testPiece(RestApi, { auth: ada });
  t.respond(SearchTodos, (input) => [{ id: 't1', title: input.q, done: false }]);
  const found = await t.fetch(new Request('http://app/todos/search?q=milk'));
  const missing = await t.fetch(new Request('http://app/todos/search'));

  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), [{ id: 't1', title: 'milk', done: false }]);
  assert.equal(missing.status, 400);
  assert.equal(t.requested(GetTodo).length, 0);
});

test('DELETE /todos/:id answers 204 when removed and 404 otherwise', async () => {
  await using t = await testPiece(RestApi, { auth: ada });
  t.respond(RemoveTodo, (input) => (input.id === 't1' ? { id: 't1', title: 'milk', done: false } : null));
  const removed = await t.fetch(new Request('http://app/todos/t1', { method: 'DELETE' }));
  const missing = await t.fetch(new Request('http://app/todos/t2', { method: 'DELETE' }));

  assert.equal(removed.status, 204);
  assert.equal(missing.status, 404);
  assert.deepEqual(((await missing.json()) as ErrorBody).error.code, 'not_found');
});

test('POST /todos with an invalid body answers 400 and asks the domain nothing', async () => {
  await using t = await testPiece(RestApi, { auth: ada });
  t.respond(CreateTodo, (input) => ({ id: 't1', title: input.title, done: false }));
  const headers = { 'content-type': 'application/json' };
  const response = await t.fetch(new Request('http://app/todos', { method: 'POST', body: '{}', headers }));
  const body = (await response.json()) as ErrorBody;

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'invalid_input');
  assert.equal(t.requested(CreateTodo).length, 0);
});
```

`t.fetch` runs the matching binding of this piece only; guards are not run, `auth` is what you pass. The full
adapter, guards included, is `createTestApp()` in the e2e test: `await app.fetch('/todos', init)` against every piece
on a temp migrated database, `await app.reset()` between cases.

## Edge piece, second transport: `pieces/api/feed/`

`pieces/api/feed/piece.ts`

```ts
import { Handle, Piece, Serve } from 'murmur';

import web, { type WebRequest } from '#capabilities/web';
import { TodoCompleted, TodoCreated, TodoRemoved } from '#contracts/todos';

import { sseFrame } from './frames.ts';

type Client = ReadableStreamDefaultController<Uint8Array>;

export class TodosFeed extends Piece() {
  private readonly clients = new Set<Client>();

  @Serve(web.get('/events/todos'))
  stream(req: WebRequest): Response {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.clients.add(controller);
        controller.enqueue(sseFrame('hello', { user: req.auth.userId }));
        req.signal.addEventListener('abort', () => {
          this.clients.delete(controller);
        });
      },
    });

    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  @Handle(TodoCreated)
  created(event: TodoCreated): void {
    this.broadcast('created', event);
  }

  @Handle(TodoCompleted)
  completed(event: TodoCompleted): void {
    this.broadcast('completed', event);
  }

  @Handle(TodoRemoved)
  removed(event: TodoRemoved): void {
    this.broadcast('removed', event);
  }

  private broadcast(kind: string, data: object): void {
    const frame = sseFrame(kind, data);
    for (const client of this.clients) {
      this.send(client, frame);
    }
  }

  private send(client: Client, frame: Uint8Array): void {
    try {
      client.enqueue(frame);
    } catch {
      this.clients.delete(client);
    }
  }
}
```

`pieces/api/feed/frames.ts`

```ts
const encoder = new TextEncoder();

export function sseFrame(event: string, data: object): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
```

`pieces/api/feed/context.md` (the Gotchas section)

```markdown
## Gotchas

- `clients` is per-process state: with several processes each event reaches one process's clients only (a piece is a
  competing-consumer group). Fine for one process; a broadcast subscription mode is not in v0.3.
- A client that disconnects is removed by the abort listener, but a frame can be enqueued in between: `send` catches
  the controller's `Invalid state` and drops the client, so a disconnect never fails the event delivery.
- `stream`'s ingress entry completes when the `Response` is returned: `$sys.ingress.completed` arrives right away and
  the stream outlives it. A client that leaves shows as an abort of `req.signal` (the abort listener), never as a
  failed entry or delivery.
```

The same three domain events feed REST clients (through `stats`) and SSE clients (through this piece); the `todos`
piece changed nothing to gain a second transport. The feed owns the `/events` family, so it never sits under
`api/rest`'s `/todos/:id`.

## Failure shapes

What a client and the 2am human see, for the three ways a request can fail. Bodies always carry a stable `code` and
the `traceId`; class names never appear.

**A guard refuses** — `curl http://localhost:3000/todos/t1` without a token:

```
HTTP/1.1 401
{ "error": { "code": "unauthorized", "message": "missing bearer token" }, "traceId": "1f3c…" }
```

```
$ murmur trace 1f3c
$ingress.http  (http)                                   0–3ms   {"method":"GET","path":"/todos/t1","binding":"GET /todos/:id"}
├─ auth.Authenticate
│  └─ auth            attempt 1  acked 1ms
│     reply → http    rejected 401 (1ms)
```

One guard request, acked; its reply is a rejection, so `RateLimit` and the edge method never ran; `tail --failed` is
empty.

**The input is invalid** — `POST /todos` with `{}`:

```
HTTP/1.1 400
{ "error": { "code": "invalid_input", "message": "title: expected string, received undefined",
             "issues": [{ "path": ["title"], "code": "invalid_type", "expected": "string",
                          "message": "expected string, received undefined" }] },
  "traceId": "9a0e…" }
```

The trace has the ingress root and the two guard children only; `todos.CreateTodo` was never published.

**The domain handler throws** — `POST /todos` while the database is locked:

```
HTTP/1.1 502
{ "error": { "code": "upstream_failed", "message": "todos.CreateTodo failed",
             "cause": { "name": "SqliteError", "message": "database is locked" } },
  "traceId": "c41d…" }
```

```
$ murmur trace c41d
$ingress.http  (http)                                   0–10012ms
├─ auth.Authenticate …                                  acked
├─ auth.RateLimit …                                     acked
└─ todos.CreateTodo
   ├─ todos           attempt 1  FAILED 4ms             SqliteError: database is locked
   ├─ todos           attempt 2  FAILED 3ms             SqliteError: database is locked  (+210ms backoff)
   ├─ todos           attempt 3  FAILED 5ms             SqliteError: database is locked  (+880ms backoff)
   └─ reply → api/rest  TIMED OUT (10000ms)
```

Retries stop at the request deadline: a delivery that carries `replyTo` is never attempted again once the requester
can no longer receive the reply, so the client is not told "failed" for a todo that attempt four would have created.
The dead letter in `tail --failed` says `reason: requester-gone`. `cause` is in the body under `murmur dev` only; in
production it is in the log under the trace id.

## How to read a piece

One page, top to bottom, for anyone debugging a piece they did not write.

1. **The folder is the unit.** `pieces/api/rest/` is piece `api/rest`. `context.md` says what and why; `piece.ts` is
   the only file the framework reads; `schema.sql` is the DDL this piece owns; everything else in the folder is private
   code the piece and its tests import. Nested folders with their own `piece.ts` are separate pieces.
2. **The class header is the contract with the framework.** `export class Todos extends Piece({ needs, config,
   emits })` declares every lane in one place: `needs: { db: sqlite }` puts a `Sqlite` handle on `this.db`;
   `config: { … }` puts validated values on `this.config`; `emits: [...]` is the only list `this.emit` accepts.
   `this.request` takes any query or command; the call sites are its declaration, and the catalog reads them from
   source. `this.log`, `this.clock`, `this.ids` are always there. `Piece()` with nothing to declare is fine.
3. **Decorated methods are the ports.** `@Handle(CreateTodo)` means "the bus delivers `todos.CreateTodo` here"; the
   parameter _is_ the contract (`input: CreateTodo`, an instance, already validated); the return _is_ the output, checked
   against the contract by tsc (wrong key, missing key, extra key, `undefined` for a nullable: all compile errors).
   `@Serve(web.get('/todos/:id'))` means "HTTP calls this"; the parameter is `req: WebRequest`, the one request type,
   read with `req.read({ params, query, headers, body })`, the one idiom; the return is `req.reply(outcome, …)` or the
   outcome itself (`HttpResult`). A second parameter `delivery:
   Delivery` is there when you need the envelope id, the attempt or the abort signal. Outputs are plain objects;
   `new Todo(...)` is never written in app code.
4. **Edge or domain?** If methods carry `@Serve`, it is an edge: it owns status codes and headers and asks domain pieces
   through `this.request`. If methods carry `@Handle` and the class needs storage, it is a domain piece: it owns rows and
   answers with outputs. Business outcomes are return values (`null`, `reject(404, …)` when the output is
   `rejectable(Model)`), failures are exceptions
   (retried unless `NonRetryableError`, and never past the requester's deadline).
5. **Cost of one more endpoint.** A shorthand line above the class; or about six lines of method when it needs a
   header or a second status; a new path family goes into the edge piece that already serves the transport unless it
   has its own lifetime (long-lived streams) or failure mode. One-route pieces are a smell, not a rule.
6. **Follow a request by name.** `this.request(GetTodo, …)` → `murmur catalog --contract todos.GetTodo` tells you which
   piece handles it; `murmur trace <id>` shows the hop with the reply bracket; the wire name is always
   `<file domain>.<ClassName>`, so `todos.GetTodo` lives in `contracts/todos.ts`.
7. **State on `this` is per process.** Fields initialised on the class (`private readonly clients = new Set()`) live
   as long as the process; a count shared by several processes goes to `this.kv.incr`. Never keep per-delivery
   facts there; take them from `delivery` or `req`.
8. **Idempotency is in the code, not in the framework.** Look for the envelope id: `delivery.envelope.id` keyed into a
   side table (`todo_requests`), `INSERT OR IGNORE`, or `this.kv.once(...)`. The invariant is written in `context.md`
   and proven by a test that delivers the same `envelopeId` twice.
9. **Tests construct the piece the way the runtime does.** `await testPiece(Todos)` fakes every need left out of
   `needs` (sqlite with the app's migrations, jobs on that database, kv, fetch) and runs each delivery in a real async context; `t.deliver(CreateTodo, …)` runs one delivery and
   returns the output; `t.emitted(TodoCreated)` lists what went out; `t.respond(GetTodo, fn)` answers the piece's own
   requests; `t.fetch(new Request(...))` drives an edge method with `auth` of your choice. `new Todos()` outside the
   runtime throws on purpose.
10. **What you will not find.** No `ctx` parameter, no `typeof` in piece code, no `process.env`, no
    imports from another piece folder, no reads of another folder's files, no comments inside bodies (that knowledge is
    in names and in `context.md`).
11. **Size.** A piece may be several files and a few hundred lines; `murmur ctx <id>` prints the assembled context in
    tokens with a tier (`ok`, `large` past 25k, `warn` past 40k, `fail` past 80k) and `murmur check` warns past ~1,500
    lines or ~20 handlers. Those numbers are placeholders until the first real measurements; the pieces in this
    document are the sizing guidance. Cohesion is the rule that matters: one concept, one owner of its storage.

## Style rules (enforced by `murmur check` and `pnpm lint`)

Debuggability first; simplify, do not complicate. `murmur check` runs the app's `.oxlintrc.json`, the type-aware
switch check (`@murmur/lint/type-aware`) and oxfmt exactly as the app's `pnpm lint` does, on the folders it checks, so a piece that passes `check` passes `lint`; `murmur check --fix` formats and
applies the fixable rules.

- Every `if`, `else`, `for`, `while`, `do` body is a block, even for one statement.
- Every statement ends with `;`.
- Paragraphs are groups. A run of `const`/`let` declarations is one group; a blank line separates it from the block
  or `return` that follows.
- **Attach rule.** A single one-line declaration (`const row = await …;` included) directly before an `if`/`for`/
  `while`/`switch` that reads it stays attached: no blank line between them. Two or more declarations keep the
  blank line.
- A statement with `await` that spans several lines is its own paragraph (blank line around it); a run of one-line
  `await` statements is one group (no blank lines inside).
- A blank line before and after every other block, unless the block is the first or last statement of its parent.
- A blank line before `return` unless `return` is the only statement in the block.
- Types are explicit where code meets code: exported functions and every class method (private and `#private`
  included) declare their return type (`Promise<Todo | null>`, `Promise<Response>`); no `any`, no non-null `!`; a
  `switch` over a union covers every member or has a `default` (oxlint's type-aware pass).
- The compiler is strict on top of `strict`: no unused locals or parameters (prefix an intentionally unused parameter
  with `_`), no implicit returns, no switch fallthrough, no unreachable code, and index signatures are read with
  brackets (`input.headers['authorization']`, `req.params['id']`).
- No inline conditionals with statements: no `cond && doIt()`, no `cond ? a() : b()` as a statement, no nested
  ternaries. A ternary that yields a value is fine; when it needs a second look, make it an `if` block.
- No comments inside function bodies unless they say what the code cannot; knowledge goes into names and `context.md`.
- No `typeof X` types in piece code; name the class (`Todo`, `CreateTodo`, `HttpRequest<Principal & Quota & AdminGrant>`).
- No `enum`, no `namespace`, no parameter properties (`constructor(private db: Sqlite)`): write the field and assign
  it. Decorators are allowed only on piece classes and their methods.
- Small, named functions over long bodies; the class method stays an orchestrator and the private file does the work.
- Formatting is oxfmt's: semicolons, single quotes, 110 columns, trailing commas, sorted imports in three groups
  (`node:*` and packages alphabetically, so `@murmur/…` before `murmur` before `zod`; then `#capabilities/*` and
  `#contracts/*`; then local files), inline `type` qualifiers for names used only as types.
