# Timeline

Two calendar days, 2026-10-24 and 2026-10-25. Times are hours from the first commit (T+0 = 2026-10-24 03:15 UTC).
Everything below was executed by Claude agent teams in Claude Code; the author directed, made the stop/go calls and
reviewed the results.

|      T+ | Event                                                                                                                                                                                                     |
| ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     0 h | murmur repository initialised: design brief, vocabulary, first decisions.                                                                                                                                 |
|     2 h | Benchmark lab started: Taskwell spec v1, two review rounds, hidden suite at 648 tests.                                                                                                                    |
|     3 h | Spec frozen for pilots, suite at 692 tests, experiment plan with gates, kickoff prompts, runner harness.                                                                                                  |
|     6 h | murmur 0.1.0: envelope, contracts, in-memory and AMQP transports, capabilities, CLI, dev UI, Claude Code plugin, release scripts.                                                                         |
|  6–10 h | Lab reference implementation of Taskwell (four slices in parallel worktrees), phase-2 change requests, adjudication of spec gaps.                                                                         |
|     9 h | v0.2 design draft: contract classes, `class X extends Piece({...})`, `@Handle` / `@Serve`, guards rejecting by value.                                                                                     |
|  9–22 h | v0.2 milestones V1–V9: model, runtime, HTTP on web Request/Response, lint and style rules, static analysis, example app rewritten, plugin skills, three "regenerate a piece from its brief alone" proofs. |
|    22 h | murmur 0.2.0 snapshot verified from a local registry.                                                                                                                                                     |
|    23 h | MCP server removed; the CLI is the only agent surface. 0.2.1.                                                                                                                                             |
|    24 h | Pilot kickoffs: NestJS, then murmur 0.2.1, headless, same prompt.                                                                                                                                         |
|    26 h | murmur pilot 1 done (1 h 47 min). NestJS pilot loses a background agent to a harness timeout, resumed.                                                                                                    |
|    27 h | NestJS pilot done (2 h 44 min incl. the pause). Both accepted 13/13 on clean clones; hidden suite 687 and 686.                                                                                            |
| 27–28 h | Pilot findings read; runtime fixes for pilot 1's nine framework issues (V11a); v0.3 design workflow (four readers, three designers, judge, critic, synthesis).                                            |
| 28–33 h | v0.3 milestones V11b–V11k in one chain, each with one implementer, one reviewer, at most one fix round. 0.3.0 published to the local registry.                                                            |
|    33 h | murmur pilot 2 kicked off on 0.3.0.                                                                                                                                                                       |
|    35 h | Pilot 2 done (1 h 55 min), accepted 13/13, hidden suite 672 (684 under the team's drain reading).                                                                                                         |
| 35–36 h | Container perf for all three candidates; pilot 2 collapses on list and search; root cause traced to a write-per-request rate limiter.                                                                     |
|    37 h | Comparison written. Decision: stop investing. Framework frozen at 0.3.0, lab merged into this repository, write-up published.                                                                             |
