# AGENTS.md

Guidance for AI agents working in **murmur**.

## What this is

Agent-first application framework (TypeScript, Node 26). An app is a flock of small independent
**pieces** that communicate only through a message **bus** via typed **contracts**. No piece knows the
whole picture. Boundaries are sized for one agent context window. See `.agents/docs/brief.md` first.

murmur is frozen at 0.3.0 and kept as a research artifact (`docs/research/`). `lab/` is the benchmark, outside the
pnpm workspace.

## Commands

- `pnpm install` — workspace install (pnpm only, never npm/yarn)
- `pnpm test` — all tests (`node --test`, native TS type stripping, no build step)
- `pnpm lint` — oxlint + type-aware switch check + oxfmt --check
- `pnpm typecheck` — per-package `tsc -p` (TypeScript 7)

## Code style

- Node 26, ESM. **Framework source (`packages/*`) is erasable TS**, run by Node's native type stripping: no
  decorators there. App pieces (`pieces/**`, incl. tests and fixtures run through `@murmur/node/register`) may use
  standard decorators and `using`; contracts, `capabilities/**` and `murmur.config.ts` stay erasable. No `enum`, no
  `namespace`, no parameter properties anywhere. Explicit `.ts` extensions in relative imports.
- No code comments unless they say something the code cannot. Linter enforces.
- Small focused functions, thin orchestrators.
- Style (lint-enforced): every `if`/`else`/`for`/`while`/`do` body is a block; every statement ends with `;`; a blank
  line before and after every block unless first/last in its parent; a blank line between a run of two or more
  `const`/`let` and the block or `return` after it; attach rule: a single one-line declaration (incl.
  `const x = await …;`) directly before the block that reads it has no blank line; a multi-line `await` statement is
  its own paragraph, a run of one-line awaits has no blank lines; a blank line before `return` unless it's the only
  statement; no `cond && doIt()` or statement ternaries, no nested ternaries; no `typeof X` types in piece code.
- Types (lint + tsc): explicit return types on exported functions and on every class method (`murmur/method-return-type`,
  private included); no `any`, no non-null `!`; an exhaustive `switch` over a union (`@murmur/lint/type-aware`, run by
  `pnpm lint` and `murmur check`); `noUnusedLocals/Parameters`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature` (read index signatures with brackets),
  `allowUnreachableCode: false`. oxfmt formats (`pnpm lint:fix`); `murmur check` runs the same preset + oxfmt.
- Prefer platform APIs: `AsyncLocalStorage`, `using`/`await using`, `AbortSignal`, `Temporal`,
  `node:test`, `node:sqlite`, `fetch`. Framework core has zero runtime deps and no `node:*` imports.
- Pieces import the framework, `node:*`, `#contracts/*`, `#capabilities/*`, `#lib/*`, files in their own folder and the
  app's `package.json` deps; never another piece folder. `docs/api-preview.md` is the reference app surface.

## Agent memory

- `.agents/docs/index.md` — topic router; before non-trivial work on a domain that has a matching doc, read that doc (only that one, never all). Canonical code wins over docs; fix stale docs.
- `.agents/decisions.md` — durable "we chose X because Y" log; read when a task hinges on _why_; add an entry when a lasting choice is made. Never pruned.
- Write durable reusable facts to docs; front-load: first ~40 lines of a doc carry the must-know facts.
