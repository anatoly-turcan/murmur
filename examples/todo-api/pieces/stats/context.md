---
title: Stats
summary: A read model counting todos from todo events; answers GetStats.
---

# stats

## What

Keeps its own `stats_todos` table from `TodoCreated` (row, `done 0`), `TodoCompleted` (`done 1`) and `TodoRemoved` (row
deleted), and answers `GetStats` with `{ total, done }` from that table.

## Why

A read model owned by a consumer: it never asks `todos` anything, so counting changes nothing in the producer.

## Handles / Emits / Requests

Handles: todos.TodoCreated, todos.TodoCompleted, todos.TodoRemoved, stats.GetStats
Emits: none
Requests: none

## Needs

Needs: sqlite
Storage: `stats_todos` (`./schema.sql`)

## Invariants

- Every event handler is idempotent: `INSERT OR IGNORE`, `UPDATE` and `DELETE` by id.
- `GetStats` on an empty table replies `{ total: 0, done: 0 }` (`SUM` of no rows is `null`, read as 0).
- Eventually consistent: a `GetStats` right after a create may not count it yet.

## Gotchas

- A `TodoCreated` retried after its `TodoRemoved` was handled counts the todo again; the table keeps no tombstones.

## Out of scope

The todos themselves (`todos`); HTTP (`api/rest` serves `GET /stats`).
