# Pilot results

Measurements of the three pilot runs of the Taskwell experiment, all phase 1, all on 2026-10-25. Every run had a
Sonnet team (implementers and reviewers on `sonnet`) under a Fable orchestrator, received only `SPEC.md` and
`SMOKE.md`, and passed acceptance (13/13 smoke walkthroughs). Pilots were uncounted by design (see
`../experiment/EXPERIMENT.md`, gate G11); no counted block ran before the experiment closed.

| Directory | Run id | Framework | Snapshot | Kickoff (UTC) | Suite (strict) | Traps | perf targets met |
|---|---|---|---|---|---|---|---|
| `nestjs-sonnet-1/` | `nestjs-sonnet-1` | NestJS 12 | — | 03:31 | 686/692 | 212/217 | 5/5 |
| `murmur-0.2.1-sonnet-1/` | `murmur-sonnet-1` | murmur | 0.2.1 | 03:50 | 687/692 | 213/217 | 5/5 |
| `murmur-0.3.0-sonnet-2/` | `murmur-sonnet-2` | murmur | 0.3.0 | 12:23 | 672/692 (684 with `SUITE_DRAIN_PENDING=any`) | 200/217 (212) | 3/5 |

The narrative of each pilot (agents, commits, cost, misses, perf diagnosis) is in
`../experiment/EXPERIMENT.md` §13.

## Files per run

| File | Produced by | Contents |
|---|---|---|
| `run.json` | `harness/new-run.ts`, `harness/stamp.ts` | `RunMeta` (`harness/lib/schema.ts`): arm, models, input hashes (spec, smoke, kickoff), timestamps (created, kickoff, done, accepted), shas, bounces, stop, meta (Claude Code version, launch mode, resume notes). |
| `code.json` | `harness/measure-code.ts` | Source and test LOC, files, test cases, dependencies and locked packages, DB hints, murmur pieces and contracts or Nest modules, measured on the committed tree of `main`. |
| `git.json` | `harness/measure-git.ts` | Merges (`--no-ff` issue branches), conflicts re-run with `git merge-tree`, rework lines, marker commits, parallelism bounds, per-merge detail. |
| `perf.json` | `harness/measure-perf.ts` | Schema 3: the candidate in a Docker container (`node:26-bookworm-slim`, 2 CPUs, 1 GiB memory, no swap; api and one worker), fixed-rate load per SPEC 14.2 class (warm-up 120 s, 3 × 60 s, 50 connections), per-class latency and status breakdown, targets met, validity, cgroup CPU and memory peaks, RSS. |
| `suite/results.json`, `suite/results.md` | `lab/suite` (`scripts/run.sh`) | The hidden acceptance suite's full v1 run (692 tests): summary by kind, category and trap, plus every test with status, message and diagnostics. `results.md` is the same as tables. |
| `repo/DONE.md` | the team | The team's completion report. |
| `repo/FRAMEWORK-ISSUES.md` | the team | Framework defects the team hit and the workarounds it used. |
| `repo/PERF.md` | the team | The team's own performance run (only `murmur-0.3.0-sonnet-2` wrote one). |
| `suite-drain-any/results.json`, `results.md` | `lab/suite` with `SUITE_DRAIN_PENDING=any` | Only in `murmur-0.3.0-sonnet-2/`; see the caveat below. |

## Caveat: two suite result sets for `murmur-0.3.0-sonnet-2`

The third pilot read SPEC 13.4 differently from the other two: its `/__test/jobs/drain` reports `pending` as every
pending job, retries not yet due included, while the suite reads the example `"pending": 0` as due jobs only.
That one reading accounts for the 12-test gap between `suite/` (strict, the suite's default) and
`suite-drain-any/` (re-run with `SUITE_DRAIN_PENDING=any`, an adjudication aid in `lab/suite/lib/testmode.ts`,
never the default). Both are kept; the wording was never adjudicated, so both numbers are reported (`../experiment/EXPERIMENT.md`
§13).

Both murmur kickoffs (`../experiment/KICKOFF-murmur.md`) still told the team an MCP server was enabled; it had
been removed before 0.2.1. Neither team reported it. The kickoff is kept unchanged because each `run.json`
records its hash.

## What was changed on publication

Numbers are untouched. Absolute paths (`framework_ref` now reads `<murmur release snapshot>`), the launch user
names in `run.json` `meta.launch` (`headless-as-owner-user` or `headless-as-isolated-os-user`) and the host
hardware lines in the team-written `DONE.md` and `PERF.md` were generalised. Session transcripts, token exports
and the run repositories themselves are not published.
