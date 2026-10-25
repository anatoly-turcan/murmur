---
title: REST API
summary: REST edge over the todos and stats domain — status codes, headers, ETag, 404 and 204.
---

# api/rest

## What

Serves the `/todos` family and `/stats` over the `web` token. Five routes are class-level shorthands that forward to a
contract (`GET /todos` with `?done=&limit=&cursor=` answering `{ data, next_cursor }`, `GET /todos/search` with `?q=`, `POST /todos/:id/complete`, `DELETE /todos/:id` with 204, `GET /stats` without a token); two are
methods because they need headers: `POST /todos` (201, `location`, `etag`) and `GET /todos/:id` (`etag`).

## Why

The one owner of HTTP status codes and headers for todos: domain pieces answer outputs (`null` for not found), this
piece maps them to responses.

## Handles / Emits / Requests

Handles: none
Emits: none
Requests: todos.CreateTodo, todos.GetTodo, todos.ListTodos, todos.SearchTodos, todos.CompleteTodo, todos.RemoveTodo, stats.GetStats
Serves: GET /todos, GET /todos/search, POST /todos, GET /todos/:id, POST /todos/:id/complete, DELETE /todos/:id, GET /stats

## Needs

Needs: none

## Invariants

- Methods read with `req.read({ params | body })` and answer with `req.reply(todo, { headers, etag })`; invalid input
  answers 400 `invalid_input` before anything is published (the token's default failure map).
- `null` from the domain is 404 `not_found`, rendered by the framework (shorthand or `req.reply`).
- The ETag is the first 16 hex digits of the sha1 of the todo's JSON in double quotes (`"0123abcd4567ef89"`, `etagOf` from `#lib/etag`);
  `req.reply` answers a matching `if-none-match` with 304, the `etag` header and no body.
- `POST /todos` is `idempotent: { scope: ['auth.userId'] }`: a retry with the same `Idempotency-Key` and body replays
  the first 201 (`idempotent-replayed: true`), another body answers 422; the method has no idempotency code.
- `GET /stats` skips `Authenticate` and keeps `RateLimit`: no token needed, still metered (by the caller's IP).
- Access logging is the token's: one `access { method, path, status, ms, traceId, user }` line per request from
  `log(auth)` in `capabilities/web/capability.ts`; this piece logs nothing per request.

## Gotchas

- `/todos/search` is a static segment and outranks `/todos/:id`; a new static route there belongs here, another piece serving it is a
  `murmur check` error.
- `GET /stats` is eventually consistent with the todos (it reads the `stats` read model).

## Out of scope

Storage and bus redelivery (`todos`); counts (`stats`); who may call (`auth`); the `/events` family (`api/feed`).
