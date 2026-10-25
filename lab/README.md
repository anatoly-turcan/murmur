# Taskwell lab

A benchmark lab for comparing application frameworks when the application is built by an AI engineering team
rather than by people. One product spec ("Taskwell", a multi-tenant task tracker with webhooks, background jobs,
rate limits and a deliberately tricky set of edge cases) is handed to a team that runs on one framework; the lab
then measures what the team delivered with a hidden black-box acceptance suite, a container performance run, code
and git metrics.

It was built to compare murmur with NestJS (`experiment/EXPERIMENT.md` is the full plan, written before the pilots and annotated as they ran). The
experiment is closed after its pilot stage; everything that was sealed while it ran is published here as the
reusable part of the research. Nothing in the harness or the suite is murmur-specific beyond the two framework
paragraphs of the kickoff, so another framework can be measured the same way.

## Layout

| Path | What | During the experiment |
|---|---|---|
| `SPEC.md` | The Taskwell product spec (v1). | **Given to the team.** Copied byte-identical into every run repo. |
| `SMOKE.md` | 13 smoke walkthroughs that define acceptance. | **Given to the team.** Copied byte-identical into every run repo. |
| `harness/` | Node 26 scripts that create runs, stamp events, measure code, git and perf, collect and tabulate. Kickoff templates in `harness/templates/`. | Lab operator only. |
| `suite/` | The hidden acceptance suite: 692 black-box HTTP tests for v1, plus 77 for the phase-2 change requests. | Sealed. |
| `experiment/` | The plan (`EXPERIMENT.md`), the trap map (`TRAPS.md`), the phase-2 change requests (`PHASE2.md`), the rendered kickoffs, the spec reviews and checklist, the reference adjudication report, and the framework-changelog-vs-traps template (never filled; see `docs/research/post-mortem.md` §5). | Sealed. |
| `reference/` | The lab's own Taskwell implementation (SQLite, no runtime dependencies), used to validate the suite and the perf harness. Covers v1 and CR-1..3. | Sealed. |
| `results/` | Measurements of the three pilot runs (see `results/README.md`). | Produced by the harness. |

`SPEC.md` and `SMOKE.md` were the only lab files a team ever received. `suite/`, `experiment/` and `reference/`
were sealed. Only `murmur-sonnet-1` ran as an isolated OS user with no file-system path to them; `nestjs-sonnet-1`
and `murmur-sonnet-2` ran under the author's own account, sealed by session deny rules and a runs root outside the lab, not by
file permissions. No transcript leak audit was run.

Everything here is public now, so models trained after publication may have seen `SPEC.md`, the traps and the
suite; a fair new comparison with later models needs a fresh spec.

`harness/`, `suite/` and `reference/` are standalone pnpm packages, each with its own `package.json` and
`pnpm-lock.yaml`, outside the root workspace. Requirements: Linux, Node 26+, pnpm, git, Docker (for perf).

```bash
cd lab/harness && pnpm install && pnpm typecheck && pnpm test
cd lab/suite && pnpm install && pnpm typecheck
cd lab/reference && pnpm install && pnpm typecheck && pnpm test
```

## How a run was produced

A run is one team building Taskwell from scratch on one framework with one model. All commands run from
`harness/`; `<dir>` is the run directory.

1. **new-run.** `node new-run.ts --phase phase1 --framework murmur|nestjs --model opus|sonnet --n <n> --created-at <iso> [--framework-ref <abs path to the framework snapshot>]`
   creates `<runs root>/phase1/<id>/` with `repo/` (a fresh git repo whose single commit holds `SPEC.md`,
   `SMOKE.md` and a `FRAMEWORK.md` pointer), `kickoff.md`, `run.json`, `session-settings.json` (deny rules for the
   lab directory and the run metadata) and `launch.sh`. It refuses a runs root inside the lab and refuses to start
   while another run is active or the candidate port is taken.
2. **kickoff.** The team session starts through `launch.sh` (orchestrator on Fable, implementers and reviewers on
   the arm's model), ideally as an isolated OS user (below). The kickoff fixes the process: plan, issues with
   done-checks, implementers in their own worktrees, an adversarial reviewer, at most two fix rounds,
   `git merge --no-ff`. `node stamp.ts --run <dir> --event kickoff --at <iso>`; later `--event done`.
3. **acceptance.** In a clean clone of `main`, follow the team's README only, start the candidate on a fresh
   database and run the suite's smoke subset (`scripts/run.sh <dir>/acceptance tests/smoke.test.ts`). 13/13 is
   accepted (`stamp --event accepted`); otherwise a bounce, at most two.
4. **suite.** The full hidden suite against the accepted commit, into `<dir>/suite/`.
5. **measure-code / measure-git / measure-perf.** `node measure-code.ts --repo <dir>/repo --ref main --out <dir>/code.json`,
   `node measure-git.ts --repo <dir>/repo --out <dir>/git.json`, and the container perf run below.
6. `node collect.ts --run <dir>` merges everything into `run-results.json`; `node tabulate.ts --phase phase1`
   prints the 2×2 tables and the hypothesis verdicts.

The full procedure, stop rules, caps, metric definitions and confounds are in `experiment/EXPERIMENT.md`.

### Runs root

Runs always live outside the lab so that a team has no relative path into it. The harness takes the runs root
from `--runs-root`, else `LAB_RUNS_ROOT`, else `<lab>/../../murmur-runs`, resolved from the harness location
(`harness/lib/arms.ts`): a `murmur-runs/` directory beside the repository that holds `lab/`.

Other harness environment: `LAB_CANDIDATE_PORT` (default `8085`), `LAB_NPM_REGISTRY` (default
`http://127.0.0.1:4873`, a local verdaccio where a framework snapshot's packages are published; murmur run repos get
an `.npmrc` pointing at it), `LAB_TEAM_USER` (default `labteam`), `LAB_ORCHESTRATOR_MODEL` (read by `launch.sh`).

The murmur packages a team installs come from that registry. From the repository root, with verdaccio running on
`scripts/release/verdaccio.yaml`: `pnpm release:snapshot <dir>` writes a release copy (no `lab/`, `.agents/`, git
history or `docs/research/`), `pnpm release:publish <dir>` publishes it, `pnpm release:verify <dir>` installs it into
a scaffolded app. A snapshot cut from this repository is not byte-identical to the one pilot 2 received: the root
README has since become the research write-up. The framework README the teams read is kept as
`docs/framework-readme.md`.

### Isolation

`harness/setup-team-user.sh` is a one-time root script for running team sessions as an isolated OS user: it
creates the user (`LAB_TEAM_USER`, default `labteam`), sets the lab to mode 700, grants traversal and read access
to Node, pnpm and the Claude Code install, copies the lab operator's Claude Code credentials, and writes a profile with `PATH`
and `LAB_RUNS_ROOT`. When that user exists, `new-run.ts` grants it access to the run's `repo/` only (ACL) and keeps
the run metadata at 600. Launch with `sudo -u <team user> -i bash <dir>/launch.sh`, then probe for leaks
(`sudo -u <team user> -i cat <lab>/experiment/TRAPS.md` must fail). The framework snapshot handed to a team must be
a release copy without `lab/`, `.agents/` or git history.

## Running the suite against any Taskwell implementation

The suite is black-box HTTP and has no runtime dependencies. Start the candidate following its README on a fresh
database, with one API and **two** workers and these variables:

| Candidate env | Value |
|---|---|
| `TASKWELL_TEST_MODE` | `true` (enables `/__test/*`) |
| `TASKWELL_TRUST_PROXY` | `true` (each synthetic user gets its own `X-Forwarded-For`) |
| `TASKWELL_WEBHOOK_TIMEOUT_MS` | `1000` (must equal `SUITE_CANDIDATE_WEBHOOK_TIMEOUT_MS`) |
| `TASKWELL_EMAIL_SINK_PATH` | optional; set `SUITE_EMAIL_SINK_PATH` to the same file |
| `TASKWELL_AUDIT_RETENTION_DAYS` | `30` for CR-3 runs |

Then:

```bash
cd lab/suite
TASKWELL_BASE_URL=http://127.0.0.1:8085 \
SUITE_WORKER_STOP_CMD='<kill both workers>' SUITE_WORKER_START_CMD='<ensure both workers run>' \
  scripts/run.sh <output dir>/suite                      # full v1 run
TASKWELL_BASE_URL=http://127.0.0.1:8085 scripts/run.sh <output dir>/acceptance tests/smoke.test.ts
```

`run.sh` waits for `/healthz`, runs every test file serially and writes `results.json`, `results.md` and `spec.log`
into the output directory. Without the two worker commands the crash-recovery tests report `skip`. Useful switches:
`SUITE_CR=CR-1|CR-2|CR-3` (phase-2 modes, cumulative), `SUITE_LEGACY_MANIFEST` (migration tests),
`SUITE_DRAIN_PENDING=any` (accepts a drain `pending` count that includes not-yet-due jobs; an adjudication aid,
never the default), timeouts via `SUITE_*_TIMEOUT_*`. `pnpm selftest` runs the suite against its stub server. The
complete environment table, the change-request modes, the legacy dataset and the result format are in
`suite/README.md`.

To run the suite against the reference implementation in one step (fresh SQLite under `lab/reference-out/<id>/`,
API plus two workers, everything stopped afterwards):

```bash
cd lab/reference && scripts/suite.sh <id> <port> [tests/<file>.test.ts ...]
```

## Container perf measurement

```bash
cd lab/harness
git clone -q <dir>/repo <dir>/perf-checkout && git -C <dir>/perf-checkout checkout <measured sha>
node measure-perf.ts --repo <dir>/perf-checkout --db-url sqlite:./perf.db --port 8085 --out <dir>/perf.json \
  --warmup 120 --duration 60 --reps 3 --connections 50
```

By default the candidate runs in Docker, identical for every arm: `node:26-bookworm-slim` (`--image`), 2 CPUs and
1 GiB memory without swap (`--cpus`, `--memory`), the checkout mounted at `/app`, the database on a volume at
`/data`, `./bin/setup` in a throwaway container first, then `./bin/api` with one `./bin/worker` beside it in the
serving container. The harness seeds the reference profile via `POST /__test/seed`, mints API keys, and drives each
SPEC 14.2 class (`get_single`, `list`, `search`, `write`, `summary`) open-loop at a fixed planned rate, so p99 is
latency at a fixed load. `perf.json` (schema 3) reports per class latency, achieved rate, status breakdown and
whether the p99 target was met, plus validity, cgroup CPU time and memory peak and per-process RSS.
`--network host` and `--no-container` (bare host) are available; `--base-url` measures an already running
candidate. The full method is in `experiment/EXPERIMENT.md` §7.6.

## Results

Run directories live under the runs root. The measurements of the three pilots (NestJS, murmur 0.2.1,
murmur 0.3.0; Sonnet teams under a Fable orchestrator, 2026-10-25) are copied into `results/<name>/`; see
`results/README.md` for what each file is and for the one caveat about the drain wording.
