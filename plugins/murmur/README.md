# murmur — Claude Code plugin

Agents, skills and hooks for building murmur apps with Claude Code. Every repo fact the plugin needs comes from the
murmur CLI (`pnpm exec murmur …`, run through Bash in the app root); nothing greps the repo.

## Install

Inside a murmur app that depends on `@murmur/cli` (Node ≥ 26, pnpm), install it from the local
marketplace (`plugins/` in the release snapshot or a checkout, the folder that holds `.claude-plugin/marketplace.json`;
Claude Code 2.1.275 or later):

```sh
claude plugin install murmur --marketplace path/to/murmur/plugins
```

or load it for one session without installing:

```sh
claude --plugin-dir path/to/murmur/plugins/murmur
```

## Permissions

The agents and skills run the CLI through Bash. A plugin manifest cannot grant permissions, so allow the commands
once in the app's `.claude/settings.json` (or `settings.local.json`) to skip the prompts:

```json
{ "permissions": { "allow": ["Bash(pnpm exec murmur *)", "Bash(pnpm test*)"] } }
```

## Contents

| kind  | name                                  | does                                                                                                                                                                                       |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| skill | `/murmur-piece <path> [from scratch]` | one-sentence check → dev server → scaffold → `piece-writer` → tests → emit + trace → review                                                                                                |
| skill | `/murmur-contract <ClassName>`        | ≤ 4 questions (kind, domain, input, output) → `murmur new contract` writes a class → catalog before/after                                                                                  |
| skill | `/murmur-review [path\|--changed]`    | `murmur check --json` → one `piece-reviewer` per changed piece in parallel → verdict                                                                                                       |
| agent | `piece-writer`                        | writes or regenerates exactly one piece as a class from its `murmur ctx` brief (edge/domain split, style rules)                                                                            |
| agent | `piece-reviewer`                      | read-only review, `mergeable \| needs-changes` with `file:line — issue — fix`                                                                                                              |
| hook  | PostToolUse `Edit\|Write`             | `murmur check <edited path> --json` on the edited piece folder (every piece for a contracts file), debounced 300 ms per folder; errors block with a summary, warnings come back as context |
| hook  | PostToolUse `Bash`                    | files a command changed under `pieces/`, `contracts/`, `capabilities/` (`git status --porcelain`, compared with the last look this session) → the same check per folder, debounced         |
| hook  | Stop                                  | one `murmur check --json` of each app with changes in those folders since the session baseline; errors block the stop once (not again while `stop_hook_active`)                            |
| hook  | SessionStart                          | three lines: `murmur ctx` before editing a piece; `murmur check --fix`, `murmur check`, `murmur test` after; the three skills exist                                                        |

## Hooks

`hooks/check-edited.ts` reads the PostToolUse JSON on stdin, ignores files outside `pieces/`, `contracts/` and `capabilities/` of the
nearest app root (`murmur.config.ts`), and runs the app's own `@murmur/cli` (fallback `pnpm exec murmur`). Explicit
paths include untracked files, so a freshly written piece is checked too. `hooks/check-bash.ts` does the same for a
Bash command: it lists uncommitted files with `git status --porcelain`, keeps those whose mtime/size changed since its
last look (a per-session snapshot in the OS temp dir; `hooks/session-start.ts` records the baseline, so files dirty
before the session are not reported until they change again) and checks each touched piece folder.
Files the Edit hook just checked are recorded in that snapshot, so the next Bash command does not check them again.
`hooks/stop-check.ts` checks each app with files changed since the session baseline in those folders once when Claude
stops. The Bash and Stop hooks do nothing in a repo without a murmur app. Tests:
`pnpm --filter @murmur/plugin test`.
