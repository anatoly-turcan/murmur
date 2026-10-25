---
title: Todos
summary: Owns the todos table — creates, reads, completes and removes todos, announcing each change.
---

# todos

## What

The one store of todos. Answers `CreateTodo`, `GetTodo`, `ListTodos`, `CompleteTodo`, `RemoveTodo` and announces
`TodoCreated`, `TodoCompleted`, `TodoRemoved`. Knows no transport: `api/rest` turns HTTP into these contracts.

## Why

One owner for the `todos` table. Create, read, complete and remove change together (same rows, same mapping), so they
live together; the read model (`stats`) and the edges stay outside.

## Handles / Emits / Requests

Handles: todos.CreateTodo, todos.GetTodo, todos.ListTodos, todos.CompleteTodo, todos.RemoveTodo
Emits: todos.TodoCreated, todos.TodoCompleted, todos.TodoRemoved
Requests: none

## Needs

Needs: sqlite
Storage: `todos`, `todo_requests` (`./schema.sql`)

## Invariants

- `id` is a uuid from `this.ids`; `done` starts false; `created_at` is `Temporal.Instant.toString()`.
- `TodoCreated` is emitted only after the row is committed.
- A redelivered `CreateTodo` (same envelope id) inserts nothing, emits nothing and replies the same todo. How:
  `todo_requests` maps the envelope id to the todo id (`INSERT OR IGNORE`, one transaction with the todo insert);
  `announced` turns 1 after the emit, so a retry after a failed emit announces once more.
- Completing a done or unknown todo emits nothing; an unknown id replies `null`.
- Removing is one `DELETE … RETURNING`: the removed todo comes back, an unknown id replies `null` and emits nothing.
- Business outcomes are outputs (`null`), never exceptions; edges map them to status codes.

## Gotchas

- Two requests with the same title are two todos: dedupe on the envelope id, never on the title.
- A delivery that dies between the `TodoCreated` emit and `announced = 1` emits again on retry (at-least-once);
  consumers dedupe on the todo id.
- `TodoCompleted` is at-most-once: a crash after the update and before the emit retries against a done todo and stays
  quiet.
- A `CreateTodo` redelivered after its todo was removed replies the remembered id with `done: false` and inserts nothing.

## Out of scope

Status codes, ETags, `location` headers (`api/rest`); counts (`stats`); who may call (`auth`).
