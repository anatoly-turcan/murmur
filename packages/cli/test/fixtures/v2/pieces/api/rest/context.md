---
title: REST edge
summary: REST over the todo domain, the /todos family and /stats.
---

# api/rest

## What

Turns HTTP into todo and stats contracts; owns status codes, ETag/304, 201 + location, 204, 404.

## Serves

Serves: GET /todos, POST /todos/:id/complete, DELETE /todos/:id, GET /stats, POST /todos, GET /todos/:id
Requests: todos.CreateTodo, todos.GetTodo, todos.ListTodos, todos.CompleteTodo, todos.RemoveTodo, stats.GetStats
