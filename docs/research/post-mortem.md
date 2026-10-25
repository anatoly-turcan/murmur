# Post-mortem: a negative result, measured

Two days, one framework, one benchmark lab, three pilot builds. The question was simple: if you design an application
framework around how AI agent teams work, do those teams build better software than they do on a normal framework?
The answer, on this evidence, is no. They build the same software, for more money, and it runs slower. That is a
useful thing to know before spending a month on it, which is what the lab was for.

This document is the full account. The short version is in the repository README.

## 1. The bet

Agent teams have a specific failure shape. One agent cannot hold a whole app in its context, so teams split work by
file or feature, step on each other in shared modules, and lose the plot on cross-cutting rules (auth, idempotency,
error contracts, time). The usual response is process: more review, more tests, more prompts.

murmur tried a structural response instead. An app is a flock of small, independent **pieces** that talk only through
a message **bus** via typed **contracts**. No piece imports another. Each piece is sized so that one agent session
holds its whole context (assembled-context tiers: large at 25k tokens, warn at 40k, fail at 80k). Its
`context.md`, contracts and tests are the source of truth; the code is regenerable from them. The framework owns the
cross-cutting machinery (admission, idempotency, jobs, transactions, clock) so the team does not re-invent it, and a
CLI (`murmur check`, `murmur ctx`) gives agents a lint-enforced style and a one-screen brief per piece.

If the thesis holds, murmur teams should hit fewer cross-cutting bugs, conflict less, and need fewer agents and
tokens. If it fails, they should look like NestJS teams with extra steps.

## 2. How we tested it

The lab is in `lab/`. The important design choices:

- **One product spec, written to be hard.** "Taskwell" is a task-management API: users, API keys, workspaces, roles,
  projects, tasks, comments, activity feed, search, webhooks with retries and signatures, digests and reminders on an
  application clock, idempotency keys, optimistic concurrency, rate limits, keyset paging, a precise error contract.
  48 traps are planted in the spec text, checked by 217 tests: sentences that are easy to skim past and cost a test when you do.
  `lab/experiment/TRAPS.md` maps every trap to its sentence and its hidden test.
- **A hidden black-box suite.** 692 tests the building teams never saw: 13 happy-path walkthroughs, 217 trap tests,
  462 error-contract checks. Teams received only `SPEC.md` and `SMOKE.md` from the lab; the murmur arm also had the framework snapshot with its
  README and docs (`docs/framework-readme.md` is the README pilot 2 read).
- **Same team, same prompt.** Headless Claude Code sessions, a Fable orchestrator spawning a Sonnet engineering team,
  the same kickoff text for both arms except for the framework-specific appendix, a 16-hour cap.
- **Acceptance on a clean clone** following the team's README only, then the suite, then measurement: code shape
  (`measure-code`), git process (`measure-git`: commits, merges, conflicts, resolution lines), and performance in a
  cgroup-limited container (`measure-perf`: 2 CPUs, 1 GiB, API and worker together, five request classes at planned
  rates with p99 targets from the spec, plus CPU and memory from the cgroup).
- **Pilots first.** The counted design was a 2×2 block (framework × team model). Before counting anything we ran
  uncounted pilots to calibrate caps and shake out the harness, with a loop on the murmur arm: read the pilot's
  framework issues and code shape, fix the framework, cut a new snapshot, rerun from zero. The pilots are where the
  story ended, so they are the data.

Full procedure, go/no-go gates and findings: `lab/experiment/EXPERIMENT.md`.

## 3. What happened

**Pilot 1, NestJS.** 2 h 44 min including a nine-minute harness interruption, 31 agents, $41. Acceptance 13/13.
Hidden suite 686/692. The team filed no framework issues.

**Pilot 1, murmur 0.2.1.** 1 h 47 min, 84 agents, $72. Acceptance 13/13. Hidden suite 687/692. The team filed nine
framework issues (SQLite busy timeouts, launcher process model, ingress in the worker, health-check override, peer
address, config types, missing exports, error envelope shape, binary name) and built what the framework did not
give them: a 2,000-line app-local "kit" library, their own job ledgers, idempotency store, rate counters, cursor codec,
and 3,574 lines of HTTP edge code for 61 routes, most of it the same preamble repeated per route.

**The v0.3 redesign.** The pilot evidence went into a design workflow: four readers extracted what both teams had
rebuilt by hand, three designers proposed strict / composable / minimal variants, a judge picked minimal, a critic
listed sixteen must-changes, a synthesiser wrote the design. Ten milestones landed in about five hours: sequential
guards with route metadata, `req.read` / `req.reply`, rejectable outputs, idempotent routes, a `jobs` capability
with retry ladders and schedules, callback transactions and `murmur migrate`, `kv.incr`, an overridable clock,
processes, auto-faked tests and `createTestApp`, a `#lib/*` lane with paging and cursors. `.agents/docs/design-v0.3.md`
is that document.

**Pilot 2, murmur 0.3.0.** 1 h 55 min, 50 agents, $64. Acceptance 13/13. Hidden suite 672/692 under the suite's
reading of one spec sentence, 684/692 under the team's (see §5). Three framework issues filed, all minor. Edge code
998 lines for 62 routes. The app-local helper layer shrank from 3,800 lines to 65.

**Performance.** NestJS and murmur 0.2.1 meet all five p99 targets in the container. murmur 0.3.0 meets three and
collapses on list and search (p50 above 12 seconds). The cause is in the team's auth guard: a SQLite transaction on
every request to read and bump four rate-limit buckets, competing with the worker's writes. Pilot 1 kept the counters
in memory. The 0.3.0 design had just made durable counters a first-class idea (`kv.incr`); the team did not call it, but
built the same shape by hand. Unloaded, both
murmur pilots cost about 3.5 ms of server CPU per list request against 1.0 ms for NestJS, and both idle at about 4 %
of a core where NestJS idles at zero.

Numbers in full: `results.md`.

## 4. Reading the numbers

**Correctness is a tie.** 686, 687, 684 (672 strict). The same three traps miss in every arm (webhook endpoint isolation, a slug
length error code, idempotency-key scope), which says more about the spec wording than about any framework. The
framework's promised edge, fewer cross-cutting bugs, did not appear. The teams were equally good at the hard parts
and equally blind to the same sentences.

**murmur is more expensive.** $64–72 against $41, 50–84 agents against 31. From the team reports, the extra spend most likely went into reading
framework documentation, working around framework issues, and writing the helper layer the framework lacked. v0.3
cut that but did not close the gap.

**murmur apps are bigger.** 11.7k lines of source against 8.9k, even after the edges shrank by 72 %. Pieces carry
their own contracts, context files, schema and fakes; the bus boundary adds a layer the NestJS app does not have.

**murmur conflicts less.** One or two conflicted merges against seven, 9–11 resolution lines against 100. This is the
piece model doing exactly what it claims: when agents own disjoint folders and talk only through contracts, their
branches do not collide. It is the one clear win, and it is real, but it did not translate into time or quality.

**murmur is slower.** Three times the CPU per request, a background tick, 1.5–2.6× the API memory. Some of this is the
envelope and contract validation on every bus hop; about half of busy time in both murmur profiles is inside
synchronous SQLite calls the framework's capabilities make on the app's behalf. None of it is unfixable, but fixing
it is a third framework round for a benefit the other numbers do not justify.

**The framework kept generating its own work.** Nine issues, then three, and the perf findings would have been the
next batch. Every pilot produced a new list. This was the risk named on day one: the framework becomes the project.
Two days in, it had.

## 5. Things we are not sure about

- **n = 1 per arm, Sonnet only.** Pilots were calibration runs. A real block with Opus teams could move any of these
  numbers. We stopped because the pilots showed no signal on the primary metric, not because they proved a negative.
- **Taskwell may be too small.** About 9k lines fits comfortably in an agent team's working set. The one-context sizing
  never bit. A larger app, or a long series of change requests on an existing app (the lab's unused Phase 2), is where
  pieces might still pay off. That experiment was not run.
- **One spec sentence decides 12 tests.** The drain endpoint's `pending` count: due jobs only, or every pending job?
  The suite reads it one way, the 0.3.0 team read it the other. Both numbers are reported; the spec should have said.
- **The perf collapse was an app decision with a framework nudge.** The team could have kept counters in memory on
  0.3.0 too. We score it against the framework because v0.3 pushed durable state as the default; that attribution is a
  judgement call.
- **Training data favours NestJS.** The models know NestJS deeply and murmur not at all. That handicaps every
  murmur number, and it is the handicap any new framework carries.
- **Pilot 2 is not independent.** 0.3.0 was redesigned from pilot 1's code on the same spec, and the planned
  changelog-vs-traps disclosure was never filled. That tilts towards murmur, and it still did not win.
- **Isolation was partial.** Only murmur pilot 1 ran as an isolated OS user; the NestJS pilot and murmur pilot 2 ran
  under the author's own account, sealed by session deny rules and a runs root outside the lab. No transcript leak audit was
  run.
- **The murmur kickoff named a tool that did not exist.** The framework paragraph both murmur teams received still said an
  MCP server was enabled; it had been removed before 0.2.1. Neither team reported it. The kickoff text is kept
  unchanged because each run record hashes it.

## 6. What we would keep

- The lab. A spec written to be hard, a hidden black-box suite with a trap map, acceptance on a clean clone, and a
  container perf rig are reusable for comparing models, team workflows, or your own stack. Worth more than the
  framework.
- Context-sized modules and lint-enforced style as conventions, not as a runtime. `murmur ctx` printing a one-screen
  brief per module and `murmur check` refusing comments, missing return types and non-exhaustive switches had visible
  effects on code quality and could sit on top of any framework.
- Contract-first guards that reject by returning a value, and the error envelope with stable codes. Small ideas,
  portable.

## 7. What we would not do again

- Build the framework before running the baseline. The NestJS pilot would have shown on day one that a Sonnet team
  already handles a 9k-line app with 31 agents and no framework issues.
- Let the framework absorb the pilots' findings on a loop. The one round we ran spent hours removing problems the framework
  itself had introduced, and created new ones.
- Measure perf last. Pilot 2 measured its own performance at 80 requests per second because it treated the per-key
  rate limits as a ceiling, and never saw the collapse. The container run belonged in the acceptance gate.

## 8. State of the code

murmur is frozen at 0.3.0 exactly as pilot 2 saw it. Known open issues: `murmur check --fix` rewrites `\u` escapes
in regular-expression literals into raw characters; `req.read` rejects a `z.record` body part and does not export
`ReplyBody`; there is no public API to purge the jobs queue; the runtime idles at about 4 % of a core; per-request
overhead is about 3.5× NestJS per list request. None of these will be fixed here.

Everything in this repository was written by Claude agent teams driven through Claude Code workflows: the framework,
the example app, the lab, the hidden suite, the reference implementation, the pilots, and this document. The author
set the direction, made the scope and stop/go calls, delegated some design calls to the agents (the decisions log
says which), reviewed the results and wrote no code by hand.
