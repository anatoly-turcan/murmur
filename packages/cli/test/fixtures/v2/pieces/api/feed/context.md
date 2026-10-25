---
title: SSE feed
summary: Streams todo events to connected clients over SSE on /events/todos.
---

# api/feed

## What

Keeps a set of stream controllers and fans the three todo events out to them.

## Gotchas

- `clients` is per-process state: with several processes each event reaches one process's clients only.
