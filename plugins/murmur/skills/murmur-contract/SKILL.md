---
name: murmur-contract
description: Add or change a murmur contract class (a Query, Command, Event or Guard in contracts/<domain>.ts). Use when asked for a new query, command, event, guard or a change to a contract's input or output.
argument-hint: <ClassName, e.g. GetInvoice>
---

# /murmur-contract `<ClassName>`

Contracts are the only surface pieces share. Repo facts come from the murmur CLI, run with Bash from the app root
(`pnpm exec murmur …`); never grep the repo.

1. Ask at most four questions, skipping any the request already answers: **kind?** (`query` reads and may be
   deduplicated, `command` changes state, `event` is fire-and-forget, `guard` answers an ingress policy with a
   `Model` or `reject()`) **domain file?** (`contracts/<domain>.ts`; the wire name is `<domain>.<ClassName>`)
   **input?** (fields and types) **output?** (a `Model` of the same file, `Model?` when "not found" is an answer,
   `Model[]`, or inline fields; none for an event).
2. `pnpm exec murmur catalog --contract <wire name> --format json` before the change, to show who handles, requests
   and emits it today. There is no separate contract command: that JSON row carries the contract's `kind`, `file`,
   `handlers`, `requesters`, `emitters` and its JSON Schema (`schema.payload`, `schema.reply`).
3. **New contract:** `pnpm exec murmur new contract <ClassName> --domain <file> --kind query|command|event|guard
   --input 'key:type,…' --output Model|Model?|Model[]|'key:type,…'` (`--name` only to override the wire name).
   **Existing contract:** list the catalog row's `handlers`, `requesters` and `emitters` to the user first — never
   edit a contract in place before that list is on screen; every listed piece must still accept the new shape.
4. `pnpm exec murmur catalog --contract <wire name> --format json` after the change and show the difference.
5. Remind the user that each handler, requester and emitter piece needs its own `/murmur-piece` run. To look at one
   of them, run `pnpm exec murmur ctx pieces/<id> --format md` first, then Read only the files the change touches
   (add `--with code` or `--with tests` to get them inline).

A contract is a class: `export class CreateTodo extends Command({ title: z.string().min(1) }, Todo) {}`,
`export class TodoCreated extends Event({ id: z.string() }) {}`, outputs are `Model` classes
(`class Todo extends Model({ … }) {}`). One file per domain, JSON-faithful schemas only (no `z.date()`, no
functions), no `typeof` anywhere.
