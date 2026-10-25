---
title: Todos feed
summary: SSE stream of todo events on GET /events/todos.
---

# api/feed

## What

`GET /events/todos` opens a `text/event-stream`: a `hello` frame with the caller's user id, then one frame per
`TodoCreated` (`created`), `TodoCompleted` (`completed`) and `TodoRemoved` (`removed`) while the client stays.

## Why

A second transport over the same domain events: `todos` changed nothing to gain it. A long-lived stream has its own
lifetime and failure mode, so it is its own edge and owns the `/events` family.

## Handles / Emits / Requests

Handles: todos.TodoCreated, todos.TodoCompleted, todos.TodoRemoved
Emits: none
Requests: none
Serves: GET /events/todos

## Needs

Needs: none

## Invariants

- An event delivery never fails because of a client: no client, a closed client or a full one is not an error.
- The stream sits behind both default guards: no token, no stream (401).

## Gotchas

- `clients` is per-process state: with several processes each event reaches one process's clients only (a piece is a
  competing-consumer group). Fine for one process; a broadcast subscription mode is not in v0.3.
- A client that disconnects is removed by the abort listener, but a frame can be enqueued in between: `send` catches
  the controller's `Invalid state` and drops the client, so a disconnect never fails the event delivery.
- `stream`'s ingress entry completes when the `Response` is returned: `$sys.ingress.completed` arrives right away and
  the stream outlives it. A client that leaves shows as an abort of `req.signal` (the abort listener), never as a
  failed entry or delivery.

## Out of scope

REST and status codes (`api/rest`); the events themselves (`todos`).
