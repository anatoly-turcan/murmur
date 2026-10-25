---
title: Notifier
summary: Runs the NotifyTodo jobs todos enqueues and keeps a day of sent notifications.
---

# notifier

## What

Handles the `NotifyTodo` job that `todos` enqueues with each new todo (`dedupeKey: notify:<id>`). The handler "sends"
the notification by recording it in `notifications` (one row per todo). `SweepNotifications` runs every minute and
deletes rows older than 24 hours. It is the only piece of the `worker` process (`pnpm exec murmur start worker`).

## Why

The example of the jobs lane: the notification survives a crash and a restart (it is a row in `murmur_jobs` until it
ran), retries on its own ladder, and the periodic sweep runs once per minute across processes.

## Handles / Emits / Requests

Handles: notifications.NotifyTodo, notifications.SweepNotifications
Emits: none
Requests: none

## Needs

Needs: sqlite
Storage: `notifications` (`./schema.sql`)

## Invariants

- One notification per todo: the insert is `INSERT OR IGNORE` on `todo_id`, so a retried job records it once.
- A failed send retries after 30s, 2m, 10m, 10m, then the job is dead (`murmur_jobs.state = 'dead'`).
- Times come from `this.clock`, so a frozen clock moves the sweep window too.

## Gotchas

- It does not subscribe `TodoCreated`: on the memory transport that event stays in the `api` process. The job is the
  cross-process path, claimed by whichever process loads this piece.

## Out of scope

The todos (`todos`); delivery over a real channel (mail, webhook): the handler is where it would go.
