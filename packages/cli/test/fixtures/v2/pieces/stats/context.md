---
title: Stats
summary: A read model counting todos and done todos.
---

# stats

## What

Listens to the todo events and answers `GetStats`.

## Handles / Emits / Requests

Handles: todos.TodoCreated, todos.TodoCompleted, todos.TodoRemoved, stats.GetStats
Emits: none
Requests: none

## Needs

Needs: sqlite
Storage: `stats_todos` (`./schema.sql`)
