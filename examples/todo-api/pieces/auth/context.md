---
title: Auth
summary: Answers the Authenticate and RateLimit guards — who is calling, how often.
---

# auth

## What

`Authenticate` reads `authorization: Bearer <token>` and maps the token to a user through `config.tokens`, replying
the `Principal` (`root` carries the `admin` role). `RateLimit` (`optional: [Authenticate]`) counts calls per caller in
a fixed one-minute window (`this.kv.incr`) and replies the `Quota` left. Both refuse by returning `reject(...)`: 401
`unauthorized`, 429 `rate_limited` with `retry-after` = seconds until the window resets.

## Why

The two default guards of the `web` token: every HTTP route asks them before the edge method runs, so who may call
and how often live in one piece, apart from every route.

## Handles / Emits / Requests

Handles: auth.Authenticate, auth.RateLimit
Emits: none
Requests: none

## Needs

Needs: kv
Storage: `murmur_kv` counters under `rate:<user id or ip>` (framework table)
Config: `tokens` (token → user id), `perMinute` (default 60), from `murmur.yaml` `pieces.auth`.

## Invariants

- A refusal is a return value, never an exception: the guard delivery is acked and the trace shows `rejected 401`.
- Guards run in order: `Authenticate`, then `RateLimit`. `RateLimit` keys on `input.prior.userId` when the route kept
  `Authenticate`, else on `input.ip` (`/stats` skips `Authenticate`, so it is metered by IP).
- The window is the runtime clock (`floor(now / 60s)`), so tests move it with `t.clock.advance`.
- The counter lives in the database: every process on the file shares one count per caller.

## Gotchas

- A fixed window lets a caller spend `perMinute` at the end of one minute and again at the start of the next.
- An unknown token is refused by `Authenticate` before `RateLimit` runs, so it uses up no quota.

## Out of scope

Which routes skip a guard (`api/rest`, `skip: [Authenticate]` on `/stats`); the default guard list
(`capabilities/web/capability.ts`).
