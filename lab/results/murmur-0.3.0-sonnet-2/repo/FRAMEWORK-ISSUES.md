# Framework issues

## `murmur check --fix` rewrites `\u` escapes in regex literals into raw characters

Found in issue 002 (`lib/text.ts`). A regex literal containing ` `/` ` (and other
space escapes such as ` `, `　`) is rewritten by the oxfmt step of `murmur check --fix`
into the raw characters. U+2028/U+2029 are line terminators in JavaScript, so the literal then fails
to parse ("Unterminated regular expression") and the check stops. Workaround: build the class in a
`String.raw` template and use `new RegExp(...)`.

## `req.read` does not accept `z.record(...)` as a body part

Found in issue 013 (`pieces/api/users`). The docs say a part is "a zod object or shape", and the type agrees:
`PartSpec = z.ZodObject | z.ZodRawShape` (`node_modules/@murmur/node/src/capabilities/http/input.ts`), so a
`ZodRecord` is not a valid part and the read result loses its typing (`headers['idempotency-key']` becomes
`unknown`). Workaround: `z.looseObject({})`, which reads any JSON object as `Record<string, unknown>` and still
rejects arrays and scalars. `ReplyBody` is also declared
in the http capability but not exported from `@murmur/node/capabilities`; the edge redeclares it.

## No public API to clear the jobs queue

Found in issue 017 (`pieces/testing`). `createTestApp().reset()` clears jobs, but a running app has no documented
way to purge the framework queue. Pending jobs left after a reset (for example a webhook retry with dedupe key
`delivery:1:1:1`) block jobs created later with the same dedupe key once table ids restart at 1. Workaround:
`ResetAll` runs `DELETE FROM murmur_jobs` and `DELETE FROM murmur_schedules` through `this.db.run`.
