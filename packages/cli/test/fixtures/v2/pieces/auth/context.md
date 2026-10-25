---
title: Auth
summary: Guards for who is calling (bearer token) and how often (per-minute window).
---

# auth

## What

Answers `Authenticate` and `RateLimit`. Refusals are `reject()` values, never exceptions.

## Handles / Emits / Requests

Handles: auth.Authenticate, auth.RateLimit
Emits: none
Requests: none
