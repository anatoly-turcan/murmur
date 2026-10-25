---
title: todo-api
summary: A small REST todo service built from independent pieces on one bus, with an SSE feed beside it.
---

# todo-api

Two domain pieces own the data: `todos` (the `todos` table) and `stats` (a read model built from todo events).
`notifier` turns each `TodoCreated` into a durable `NotifyTodo` job and sweeps old notifications every minute. `auth`
answers the two default guards of the `web` token (`capabilities/web/capability.ts`). Two edge pieces turn HTTP into
contracts: `api/rest` owns the `/todos` family and `/stats`, `api/feed` owns the `/events` family (SSE). Domain pieces
know no transport; edges own status codes and headers.
