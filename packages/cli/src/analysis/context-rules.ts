import { HEADINGS } from './context-headings.ts';

export const SIZING_HEURISTICS = [
  'describable in one sentence without "and"',
  'one writer of each table; readers declare the table in context.md',
  'things that change together live together',
  'handlers sharing no state or helpers are a split smell',
  'start coarse, split on pain, never speculatively',
] as const;

export function rulesText(sizingDoc: string): string {
  return [
    HEADINGS.rules,
    '',
    "1. A piece talks to other pieces only through contracts on the bus; never import another piece folder; other pieces' code is off limits, even for idioms: read context.md files and contracts only.",
    '2. `piece.ts` exports one class, `export class X extends Piece({ needs: { db: sqlite }, config, emits: [SomeEvent] })` (`Piece()` when it has none); logic goes to private files in the folder.',
    '3. `@Handle(C) async m(input: C): Promise<Out>`: the parameter is the contract instance, the return is the output; add `delivery: Delivery` only when you need the envelope id, attempt or signal.',
    '4. `this.emit(E, payload)` only for events in `emits`; `this.request(C, input)` for any query or command (the call site is the declaration). On the memory transport events stay in one process; cross-process durable work is `this.jobs.enqueue(Command, input)` inside the transaction.',
    '5. A business refusal is a returned `reject(status, message, { code, details })`: in a guard, or in any handler whose contract output is `rejectable(...)`. The edge renders it unchanged. `null` is not found. Throw only when the operation did not happen: it is retried, then dead-lettered; `NonRetryableError` when a retry cannot help.',
    "6. Client retries: `idempotent: { scope }` on the route. Bus redelivery: key every effect on `delivery.envelope.id` (`this.kv.once(delivery.envelope.id, effect)` or a claim-first `INSERT OR IGNORE` side table); emits stay at-least-once. Durable or delayed work: `this.jobs.enqueue(C, input, { runAt, dedupeKey, groupKey })`, never a timer; periodic work: `@Handle(C, { every: '1m' })`.",
    "7. Edges read with `const { params, query, headers, body } = await req.read({...})`, call one contract, and answer with `req.reply(outcome, { status, headers, etag })` or return the outcome. Admission is the route's guards and `meta`; never request a guard from a serve method. Domain pieces know no transport.",
    '8. Config from `this.config`, I/O through the `needs` handles (`this.db`, …), `this.log`, `this.clock`, `this.ids`; never `process.env`. Transactions: `await this.db.transaction(async (tx) => …)`; a nested call joins. Field initialisers may use `this.db` / `this.config` / `this.log` (`readonly #repo = new Repo(this.db);`); `new X()` of the piece outside the runtime throws, tests use `testPiece`.',
    '9. Return plain objects that satisfy the model type, never `new Model(…)`; no `typeof` types in piece code, name the class.',
    '10. Style: every `if`/`for`/`while` body in braces; every statement ends with `;`; a blank line around blocks, after a run of two or more consts and before `return` unless it is the only statement; a single one-line `const` (even `const x = await …;`) stays attached to the block that reads it (no blank line between `const row = await …;` and `if (row === undefined) {`); a multi-line `await` statement is its own paragraph, one-line awaits group without blank lines; exported functions and class methods declare their return type; no `any`, no `!`; no statement ternaries, no `cond && call()`, no nested ternaries; no comments in bodies (knowledge goes to `context.md`).',
    `11. One concept, one owner of its storage; ctx tiers large 25k / warn 40k / fail 80k tokens, ~1,500 lines, ~20 handlers; heuristics in \`${sizingDoc}\`:`,
    ...SIZING_HEURISTICS.map((h, i) => `    ${i + 1}. ${h}`),
    '12. Shared pure code lives in `lib/` and is imported as `#lib/x`; a capability is I/O or state, never a helper bag.',
  ].join('\n');
}
