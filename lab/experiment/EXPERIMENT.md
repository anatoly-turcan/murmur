# Experiment plan: murmur vs NestJS, built by AI engineering teams (sealed during the experiment)

> Status: closed after the pilots (gate G11). Gates other than the ticked ones never ran, so blank `______` fields
> are expected. The pilot narrative is §13.

Sealed. Never shown to building teams, their orchestrators, the adversarial tester, or anyone launched inside a run. The owner fixed the design (2×2 factorial, process, metrics). This document refines it into a procedure and does not reopen it.

**Known bias, stated up front.** The models have deep NestJS training data and no murmur data. Every murmur result carries this handicap, and every NestJS result benefits from it. Nothing in the design removes it. murmur's documentation, plugin, MCP server and `murmur ctx` are its only counterweight, and they count as part of the treatment. A further bias runs the other way: the owner designed murmur, wrote SPEC.md and the hidden suite, and knows the traps (see §10, C3 and C4).

---

## 1. Hypotheses

`W` is the weighted hidden-suite score of §8.1, a value in [0, 1]. Each hypothesis is pre-registered with its decision rule, and `harness/tabulate.ts` evaluates the rules mechanically.

| # | Statement | Phase | Decision rule (means over runs in each cell) |
|---|---|---|---|
| H1 | **Parity in phase 1.** murmur matches NestJS on correctness when the team and model are the same. | 1 | Supported if \|W(murmur, m) − W(nestjs, m)\| ≤ 0.05 for m = opus, for m = sonnet, and pooled over both models. |
| H2 | **murmur + sonnet ≥ NestJS + opus.** The framework lets a cheaper team (implementers and reviewers on sonnet, D3) match a stronger one on the incumbent framework. | 1 (also reported for 2) | Supported if W(murmur, sonnet) ≥ W(nestjs, opus) **and** trap score T (§8.1) for (murmur, sonnet) ≥ T for (nestjs, opus). |
| H3 | **murmur wins phase 2 on tokens and conflicts.** Change requests cost less and collide less when the app is made of pieces. | 2 | Supported if, for both models: mean tokens per CR (murmur) ≤ 0.85 × mean tokens per CR (nestjs), **and** conflicted merges across phase 2 (murmur) ≤ conflicted merges (nestjs), **and** final W (murmur) ≥ final W (nestjs) − 0.05. |

With n = 2 per cell these rules are descriptive, not inferential. Any cell whose spread (min to max) overlaps the comparison cell's spread is reported as "directional only". If a verdict is close (within 0.02 of a threshold) or the cells overlap, add a third run to every arm rather than to one.

## 2. Design

### 2.1 Arms

| Arm (run-id prefix) | Framework | Implementer + reviewer model | Orchestrator model |
|---|---|---|---|
| `murmur-opus-<n>` | murmur (frozen snapshot) | opus | fable |
| `murmur-sonnet-<n>` | murmur (frozen snapshot) | sonnet | fable |
| `nestjs-opus-<n>` | NestJS (current stable on npm at freeze date) | opus | fable |
| `nestjs-sonnet-<n>` | NestJS (current stable on npm at freeze date) | sonnet | fable |

There are at least 2 runs per arm, so at least 8 runs per phase. Phase 2 reuses the phase-1 codebase of the same run id (`$RUNS/phase2/<id>` is cloned from `$RUNS/phase1/<id>`).

`$RUNS` is the runs root **outside the lab repo**: `<lab>/../../murmur-runs` by default (beside the repository that holds the lab; during the experiment a fixed directory beside the lab repo), overridable with the env var `LAB_RUNS_ROOT` (D1). `new-run.ts` refuses a runs root inside the lab.

### 2.2 Fixed across arms

- **Roles and hierarchy.** There are three roles: orchestrator (fable), implementers, and reviewers. No group-lead or module-lead layer exists in either arm. The owner's conditional rule ("if murmur gets a group-lead layer, NestJS gets a module-lead layer") resolves to "neither". If that ever changes, the change applies to both arms at once and every run is redone.
- **Reviewer model = implementer model** (D3). The factor is therefore "team model under a fable lead", and **H2 reads "a cheaper team"** (cheaper implementers *and* cheaper reviewers), not "a cheaper implementer alone".
- **Database engine: SQLite in both arms** (D2), stated once in the shared process section of both kickoffs.
- **Process.** The process is the one in the kickoff (§4.2): plan, then issues with done-checks, then implementers in their own worktrees (at most 6 at once), then an adversarial reviewer, then at most 2 fix rounds, then `git merge --no-ff` by the orchestrator. `--no-ff` is required so that measure-git can see every issue branch.
- **Runtime.** Node 26 on the same machine, the same `pnpm`, the same Claude Code version (record it in `run.json` meta as `claude_code`), and the same session settings shape (`session-settings.json`, written by new-run).
- **Execution.** Runs execute one at a time on this host, with no containers (D6). `new-run.ts` and `measure-perf.ts` refuse to start while another run is active (kickoff stamped, neither done nor stopped) or while anything listens on the candidate port (default 8085, `LAB_CANDIDATE_PORT`).
- **Inputs.** SPEC.md, SMOKE.md and the kickoff template, frozen and hashed into `run.json.inputs`. `tabulate.ts` warns if any hash differs between runs.
- **Web.** WebSearch is denied in both arms. WebFetch is denied in the murmur arm (its docs are local) and allowed only for `docs.nestjs.com` in the NestJS arm. The package registry is reachable in both arms for installs.

### 2.3 The only difference

The framework paragraph of the kickoff (§4.2), plus the framework's legitimate tooling:

- **murmur:** the frozen snapshot, its README and docs, its CLI (`murmur ctx`, `murmur check`, …), its MCP server, and its Claude Code plugin (agents `piece-writer` and `piece-reviewer`, skills). Plugin agents may fill the implementer and reviewer slots, because they are the product's intended way of working. They do not add a layer or an extra review pass. Before the snapshot is cut, verify that no plugin agent or skill pins a `model` in its frontmatter (go/no-go G14).
- **NestJS:** npm packages, `@nestjs/cli`, and docs.nestjs.com. Nothing else is provided: no Nest-specific plugin, skill or MCP server, and no starter beyond what `nest new` generates.

### 2.4 Design decisions (owner, 2026-10-24)

| # | Decision | Reason |
|---|---|---|
| D1 | The runs root lives outside the lab repo: `$RUNS/<phase>/<id>/`, configurable with `LAB_RUNS_ROOT`. | Teams must have no path to the sealed material (`suite/`, `experiment/`, `reference/`). The G9 leak probe stays. |
| D2 | **SQLite** is the database engine in both arms. The shared process section of both kickoffs says: "Use SQLite as the database engine." The framework paragraphs no longer offer an engine choice. | It removes the engine confound on performance and on the concurrency traps, and murmur v0 ships a sqlite capability only. |
| D3 | Reviewer model = implementer model. | One "team model" factor. H2 reads "a cheaper team". |
| D4 | Plugin agents and skills must not pin `model` in frontmatter (G14). | Otherwise a plugin agent could silently override the arm's model. |
| D5 | Phase 2: teams get each CR's Request + Specification only. Acceptance criteria are withheld. | The acceptance criteria are the CR hidden tests. This mirrors TRAPS.md in phase 1. |
| D6 | Runs within a block execute sequentially on this host, with no containers. The harness refuses to start a run while another run is active or the candidate port is taken. | Concurrent runs collide on ports and CPU and distort wall-clock and perf. |
| D7 | Trap-awareness disclosure: before launch, the owner fills `experiment/FRAMEWORK-CHANGELOG-vs-TRAPS.md`, mapping each murmur feature added after SPEC.md to any trap it eases (G15). | The owner knows the traps (C4). |
| D8 | Scoring: W = (3T + S + E) / 5 (§8.1). Trap outcome vocabulary: `not_implemented`, `wrong`, `untested_but_works`, `caught_by_own_tests`, plus `covered` for passed traps that have team tests (§7.2). | Count-independent weights; one vocabulary shared with the suite. |

## 3. Isolation and blinding

The teams must never see this plan, the sealed material (`suite/`, `experiment/`, `reference/`), the word "benchmark", each other, or the association "Taskwell" ↔ murmur's own repository.

| Risk | Mechanism |
|---|---|
| Reaching the lab or a sibling run from a team session | (1) Runs live outside the lab repo, under `$RUNS` (D1), so no relative path leads to the sealed material. (2) Run each team session as an isolated OS user with no read access to the lab directory (`chmod 700`), and with ACL access only to its own `$RUNS/<phase>/<id>/repo` and the murmur snapshot. (3) Launch every session with `--settings $RUNS/<phase>/<id>/session-settings.json`. That file is written by new-run, lives outside the repo, and denies Read/Edit on the whole lab directory and on run metadata files (`$RUNS/*/*/*.json`, `*.md`). (4) Leak probe before each block (G9). (5) Leak audit after each run (§7.12). |
| Run metadata (`run.json`, `kickoff*.md`, metrics) | Kept in the run directory, never in `repo/`. The team's cwd is `repo/`. |
| murmur's development repository contains `.agents/` (design brief and spec with the thesis "disjoint files, no merge conflicts", plus the word "experiment"). | Give teams a **release snapshot**, not the dev repo. It contains the packages, README, `docs/`, `plugins/murmur`, the MCP server and `examples/`, without `.agents/`, without git history and without `CLAUDE.md`/`AGENTS.md` internals. It is checked by `grep -rniE 'taskwell|benchmark|experiment|murmur-lab|nestjs' <snapshot>`, which must return nothing (G3). |
| Kickoff wording | `harness/test/kickoff.test.ts` asserts that neither kickoff mentions benchmark, experiment, hidden suite, traps, `private/` or `murmur-lab`, and that neither names the other framework. |
| Phase-2 acceptance criteria | Teams receive the **Request** and **Specification** sections of each CR verbatim. The **Acceptance criteria** sections are withheld, because they are the CR hidden tests. This mirrors phase 1, where TRAPS.md is withheld and SMOKE.md is given. |

## 4. What each team receives (verbatim)

### 4.1 Repository contents at kickoff (phase 1)

`harness/new-run.ts` creates `$RUNS/phase1/<id>/repo/` as a fresh git repository (branch `main`) with exactly one commit, "Initial specification" by `Product Owner <owner@example.invalid>`, dated `--created-at`. The commit contains:

- `SPEC.md`: byte-identical to the lab's `SPEC.md`.
- `SMOKE.md`: byte-identical to the lab's `SMOKE.md`.
- `FRAMEWORK.md`: the arm's framework paragraph (§4.3), which is the framework pointer.

Outside the repo, the run directory holds `kickoff.md` (the prompt to paste), `run.json`, and `session-settings.json`.

### 4.2 Kickoff prompt

The exact texts are `experiment/KICKOFF-murmur.md` and `experiment/KICKOFF-nestjs.md`. They are generated from `harness/templates/` (`kickoff.md` + `framework-<fw>.md` + `process.md`), and a test keeps them byte-identical to the templates. The two prompts are identical except for the framework paragraph. The shared process section carries the rule "Use SQLite as the database engine." (D2); a test checks that it appears in both prompts and in neither framework paragraph. In the murmur file, `{{FRAMEWORK_REF}}` is a placeholder: new-run fills it with `--framework-ref`, the absolute path of the frozen snapshot, which is the same for every murmur run. The implementer model never appears in the prompt. It is enforced by the session (`CLAUDE_CODE_SUBAGENT_MODEL` in `session-settings.json`) and verified by G7.

The phase-2 prompt per change request is `harness/templates/kickoff-cr.md`. It has the same framework paragraph and process section, followed by the CR's Request + Specification text. `new-run --phase phase2` renders it to `$RUNS/phase2/<id>/kickoff-cr{1,2,3}.md`.

### 4.3 The two framework paragraphs

**murmur**

> ## Framework
>
> Build the product with **murmur**, an agent-first TypeScript application framework for Node 26. A murmur application is a set of small, independent pieces that never import each other and communicate only through a message bus using typed contracts; each piece is sized so that one agent session can hold all of it. The framework is provided at `{{FRAMEWORK_REF}}`. Start with its README and its documentation, which explain how to add it to a project, how to structure pieces, groups and contracts, and how to run and test an application. murmur ships its own agent tooling, and that tooling is part of the framework: the Claude Code plugin (agents `piece-writer` and `piece-reviewer`, and skills for writing pieces and contracts and for reviewing them), the MCP server, and the CLI, including `murmur ctx <piece>`, which assembles the context an agent needs to work on one piece, and `murmur check`, which enforces piece boundaries. The plugin and the MCP server are already enabled in this session; use them as the framework documentation describes. Use only the framework's documented public API and do not modify the framework itself; if a framework defect blocks you, work around it inside the application and record it in `FRAMEWORK-ISSUES.md`. The choice of the libraries used inside pieces is yours.

**NestJS**

> ## Framework
>
> Build the product with **NestJS**, the TypeScript server framework, as a standard modular monolith on Node 26: feature modules with controllers, providers and dependency injection, structured as the official NestJS documentation describes. Use the current stable NestJS release from npm. The official NestJS CLI (`@nestjs/cli`) and the official documentation at https://docs.nestjs.com are available to you; nothing else is provided. Use only NestJS's documented public API and do not modify NestJS itself; if a framework defect blocks you, work around it inside the application and record it in `FRAMEWORK-ISSUES.md`. The choice of ORM or query library and of other libraries is yours.

### 4.4 Fixed owner messages (the only things the owner may say during a run)

| When | Text (verbatim) |
|---|---|
| Kickoff | contents of `kickoff.md` (phase 1) or `kickoff-crN.md` (phase 2) |
| Stall nudge (§6) | `Continue with the same process until the definition of done is met.` |
| Smoke bounce (§6) | `Not accepted yet: SMOKE.md walkthrough(s) <numbers> do not pass against a fresh instance started as README.md describes. Continue with the same process until they pass, then update DONE.md.` (phase 2: `DONE-CR-N.md`) |

No other hints, answers or clarifications. A question from the team goes unanswered, and the kickoff tells the team so.

## 5. Procedure

### 5.0 Host setup (once)

`sudo bash harness/setup-team-user.sh [runs-root]` creates an isolated OS user (`LAB_TEAM_USER`, default `labteam`), sets the lab to 700, gives that user traversal into the owner's home and read access to node (nvm), pnpm and the Claude Code install, copies the owner's Claude credentials into that user's `~/.claude`, and writes a `.bash_profile` with PATH and `LAB_RUNS_ROOT`. `new-run.ts` then grants the isolated OS user rwx on each run's `repo/` by ACL and keeps `run.json`, `kickoff*.md` and `session-settings.json` at 600 (the deny rules in the settings are the second wall). Launch: `sudo -u <team user> -i bash <run dir>/launch.sh`. Headless form (used by the pilot): `launch.sh --setting-sources project --permission-mode acceptEdits --allowedTools Bash Read Edit Write MultiEdit Glob Grep Agent Skill ToolSearch TodoWrite WebFetch --output-format stream-json --verbose -p "$(cat ../kickoff.md)" > ../session.jsonl`; `--setting-sources project` keeps the owner's user-level plugins and hooks out of the team session, the user-level `~/.claude/CLAUDE.md` still loads for a launch that is not run as the isolated OS user.

### 5.1 Once, before any counted run

1. Freeze the inputs: SPEC.md, SMOKE.md, `harness/templates/*`, the hidden suite (commit `suite/`, then record `git rev-parse HEAD:<path to suite>` on every run with `stamp --set suite_tree=<sha>`), and the murmur snapshot (record its tag and the tarball sha256 in this file's go/no-go table).
2. Pass the go/no-go checklist (§11), including the pilot runs.
3. Fix the run schedule. The design uses **blocks**: block *b* contains one run of each arm, with n = *b*. Order inside a block comes from `printf 'murmur-opus\nmurmur-sonnet\nnestjs-opus\nnestjs-sonnet\n' | shuf --random-source=<(yes <block-number>)`, recorded before the block starts. The runs of a block execute **sequentially** on this host (D6). The harness enforces this: `new-run.ts` refuses while another run is active or something listens on the candidate port (`--port`, default 8085, `LAB_CANDIDATE_PORT`; 8080 is left to the unrelated keycloak container).

### 5.2 Phase 1, per run

1. `cd harness && LAB_RUNS_ROOT=<runs root> node new-run.ts --phase phase1 --framework <fw> --model <m> --n <n> --created-at <now-iso> [--framework-ref /abs/murmur-snapshot]`
2. Start the session as the isolated OS user with `$RUNS/phase1/<id>/launch.sh` (written by new-run: cwd `repo/`, model fable, `--settings ../session-settings.json`, and for murmur `--plugin-dir <snapshot>/plugins/murmur`, which also registers the plugin's MCP server; nothing is written into the repo). For murmur the run repo carries an `.npmrc` pointing at the lab's package registry (`LAB_NPM_REGISTRY`, default `http://127.0.0.1:4873`), where the snapshot's packages are published; the registry must be up before the session starts (§5.0). Record the Claude Code version: `node stamp.ts --run <dir> --set claude_code=<version>`.
3. Paste `kickoff.md`, then `node stamp.ts --run <dir> --event kickoff --at <iso>`.
4. Monitor the token and wall-clock counters against the stop rules (§6). Do not read the team's work in progress beyond what monitoring needs.
5. When the team writes `DONE.md` and stops: `stamp --event done --at <iso> --sha $(git -C repo rev-parse main)`.
6. **Acceptance.** In a clean clone of `main`, follow README.md only, start the candidate as in §7.1 on a fresh database, and run the hidden suite's smoke subset: `scripts/run.sh <abs dir>/acceptance tests/smoke.test.ts`, which scripts SMOKE.md 1–13.
   - 13/13 passes: `stamp --event accepted --at <iso>`.
   - Otherwise send the bounce message, run `stamp --event bounce --at <iso>`, and continue from step 5. After a second failed bounce (2 bounces in total), stop with `stamp --event stopped --reason not_accepted`.
7. Run the measurements of §7 on `main` at the accepted (or stopped) commit.
8. `node collect.ts --run <dir>`.

A run that is not accepted is scored in phase 1 with whatever `main` holds. It cannot enter phase 2, so a replacement run with the next free `n` is launched for phase-2 eligibility. Allow at most 2 replacements per arm, and report attrition per arm (C12).

### 5.3 Phase 2, per accepted phase-1 run

1. `node new-run.ts --phase phase2 --framework <fw> --model <m> --n <n> --created-at <iso> --from $RUNS/phase1/<id>`. This clones `main`, removes the remote, and writes `kickoff-cr1..3.md`.
2. For CR = 1, 2, 3, in order. Each CR gets a **fresh orchestrator session** with the same settings, the same team setup and the same models. The repository and its files (PLAN.md, issues/, README, and murmur's `context.md` files) are the only memory carried over.
   1. `stamp --event crN_start --at <iso> --sha <main HEAD>`; paste `kickoff-crN.md`.
   2. Apply the stop rules per CR.
   3. When the team writes `DONE-CR-N.md`: `stamp --event crN_done --at <iso> --sha <main HEAD>`.
   4. Acceptance: the smoke subset, adjusted for the CR (G13), with the same bounce rules. Then `stamp --event crN_accepted`.
   5. Run the hidden suite (v1 + every CR delivered so far) into `<dir>/suite-crN/`. Record git metrics for the CR: `node measure-git.ts --repo repo --range <crN_start sha>..<crN_done sha> --out git-crN.json`.
   6. If a CR is not accepted after 2 bounces, record `stopped`. Still deliver the next CR, because cumulative cost is the object of study, and flag the run.
3. After CR-3, run the whole-phase measurements (§7), with git restricted to `--range <base_sha>..main`, then `collect.ts`.

### 5.4 After each phase

`node tabulate.ts --phase phase1 > $RUNS/phase1/RESULTS.md`, and the same for phase 2. Archive the per-run `run-results.json` files. Fill §12 of this document with the verdicts.

## 6. Stop rules

| Rule | Phase 1 (per run) | Phase 2 (per CR) |
|---|---|---|
| Token cap: hard stop at **fresh tokens** (input + output + cache writes, all agents) | **30 M** | **10 M** |
| Token alert: owner checks for runaway loops (no action unless the loop is a harness fault) | 22 M | 7.5 M |
| Wall-clock cap from the kickoff stamp | **16 h** | **6 h** |
| Stall: no new commit on any branch **and** no agent activity | 60 min → one stall nudge; a second stall in the same phase/CR → stop (`stall`) | same |
| Fix rounds per issue | 2 (process rule; the orchestrator decides afterwards) | same |
| Smoke bounces | 2; then stop (`not_accepted`) | same |
| Done | **SMOKE passes 13/13 via the suite's smoke subset on a fresh instance** **and** the team has written `DONE.md` and stopped | the CR smoke subset passes **and** `DONE-CR-N.md` exists and the team stopped |
| Harness fault (rate-limit outage, machine crash, leak found) | Void the run (`stopped`, reason `void:<cause>`), keep its data apart, and rerun with the next `n`. A void run never counts. | same |
| Framework blocker (owner, 2026-10-25): a murmur defect that makes a SPEC requirement impossible inside the caps, confirmed on the reference app, not a missing convenience | Stop the **block** (both arms). Fix in the murmur repo, cut a new snapshot sha, add the entry to `FRAMEWORK-CHANGELOG-vs-TRAPS.md` (D7), void every run of the block (`void:framework-blocker`), restart the block from n=1. Anything short of a blocker is **not** touched mid-experiment: it goes to the run's `FRAMEWORK-ISSUES.md` and the owner's v0.3 backlog, and is a result of the experiment (gaps found), scored under §7 (workarounds, issue count). | same |

The caps are placeholders until the pilot (G11). After the pilot, set each cap to about 2× the pilot's consumption, then freeze it. A run that hits a cap is scored on its last `main`, with `stop_reason` recorded. Caps never change mid-experiment.

## 7. Measurement procedures

All commands run from `harness/` on Node 26. `<dir>` is `$RUNS/<phase>/<id>`.

### 7.1 Hidden suite (`suite/`, see its README)

- **Target.** A clean clone of the measured commit, set up by following its README, on a fresh database. Start it with `TASKWELL_TEST_MODE=true TASKWELL_TRUST_PROXY=true TASKWELL_WEBHOOK_TIMEOUT_MS=1000`, **one `./bin/api` and two `./bin/worker`** instances. Provide `SUITE_WORKER_STOP_CMD` and `SUITE_WORKER_START_CMD` (kill or ensure the two workers), because without them the G1/G3 crash tests are `skip`.
- **Phase 1:** `cd suite && TASKWELL_BASE_URL=http://127.0.0.1:8085 scripts/run.sh <abs dir>/suite`. This writes `<dir>/suite/results.json`, `results.md` and `spec.log`. `collect.ts` reads `<dir>/results.json` if present, else `<dir>/suite/results.json`.
- **Acceptance smoke subset:** `scripts/run.sh <abs dir>/acceptance tests/smoke.test.ts`. Accepted means 13/13 `[SMOKE-n]` tests pass.
- **Result shape** (from the suite's reporter): per test `name`, `category` (`A`–`L`, `smoke`, `errors`, `other`), `kind` (`trap` for `[A1]`…`[L3]`, `happy` for `[SMOKE-n]`, `errors` for `[ERR]`), `trapId`, `status` (`pass`, `fail`, `skip`, `todo`), `message`, and `classification` (null on failed trap tests, to be filled in).
- **Phase 2, after CR-N:** the suite currently covers v1 only (its README says so). Before phase 2, the CR tests must be added, tagged so that `category` starts with `CR` (or `suite: "CR-N"`), with v1 tests re-run under the CR-mandated call changes (`organization_id`, opaque string ids). Output goes to `<dir>/suite-crN/results.json` (or `<dir>/results-crN.json`). This is go/no-go G13 for phase 2.

### 7.2 Trap outcome classification (`adjudication.json`)

An adjudicator agent (fable, fresh session, never a team member) receives TRAPS.md, `results.json`, `spec.log`, and read access to the run repo. Several suite tests can belong to one trap. A trap's verdict is `pass` when all of its executed tests pass, `fail` when any of them fails, and `skipped` when none of them was executed. For **every trap that was executed** the adjudicator records one outcome in `adjudication.json.trap_outcomes` (keyed by trap id):

| Trap verdict | Outcome | Meaning |
|---|---|---|
| fail | `not_implemented` | The behaviour or endpoint is absent or stubbed. |
| fail | `wrong` | Implemented, but it behaves against the spec (no team test catches it, or a team test encodes the wrong behaviour). |
| fail | `caught_by_own_tests` | The team's own suite has a test for this behaviour that fails or is skipped, or DONE.md lists the defect, so the team knew. |
| fail or pass | `untested_but_works` | The behaviour works and no team test exercises it. For a failed trap, the adjudicator found the failure incidental to the trap (for example a precondition broken by another defect). This is the suite's `untested` label. |
| pass | `covered` | Correct, and a team test exercises it. |

The canonical vocabulary (D8) is `not_implemented | wrong | untested_but_works | caught_by_own_tests`, plus `covered` for passed traps that have team tests. `collect.ts` rejects any outcome that contradicts the trap verdict: `covered` only on a pass, and `not_implemented`, `wrong` or `caught_by_own_tests` only on a fail. When `adjudication.json` has no entry for a failed trap, `collect.ts` falls back to the suite's per-test `classification`: `not_implemented` and `wrong` map to themselves, `untested` maps to `untested_but_works`, and the canonical names are accepted as they are. When a trap's failed tests carry different labels, the most severe wins (not_implemented > wrong > caught_by_own_tests > untested_but_works). Anything else counts as `unclassified`. The suite's L1–L3 tests already accept any documented-consistent behaviour. Where their `diagnostics` ask for a README check (L2), the adjudicator decides, and records the decision as a replacement test entry in `adjudication.json.tests`. That entry overrides the suite test with the same `name`. The owner spot-checks 25% of the classifications, chosen at random.

### 7.3 Adversarial tester (`bugs.json`)

This happens after the hidden suite. The tester is fable in a fresh session, works **black-box only** (base URL, the candidate's README.md and SPEC.md, no source code), has a budget of 3 M fresh tokens or 90 minutes, and gets the same prompt for every run:

> You are testing an HTTP API against its specification (SPEC.md) and its README. Find behaviour that contradicts the specification. For each defect, write a minimal reproduction (curl commands or a short script), the spec section it violates, and a severity: critical (data loss, security, corrupted invariants), major (wrong result or status on a specified path), minor (format or ordering details). Do not report missing optional features. Do not report behaviour the README documents as an assumption where the specification is silent. Stop when the budget is spent or you have nothing more to find.

The owner (or a second agent) reruns every reproduction. Defects that reproduce get `confirmed: true`. A defect gets `in_hidden_suite: true` when a failing hidden test already covers it. The metric counts confirmed defects that are not in the hidden suite, and weights them critical 5, major 3, minor 1.

### 7.4 Tokens, turns and wall-clock (`tokens.json`, `run.json`)

- **Tokens and turns.** Export usage from the workflow or session logs for every agent in the run (orchestrator, implementers, reviewers, plugin agents, and the MCP tool turns that run inside them). Write it as `tokens.json` (§9.1): `totals`, `by_role`, `by_cr` (phase 2), `agent_turns` (assistant turns summed over all agents) and `agents_spawned`. Total = input + output + cache_read + cache_write; fresh = total − cache_read. Exclude the adjudicator, the tester and acceptance checks.
- **Wall-clock.** Phase 1 runs from the `kickoff` stamp to the last `done` stamp, or to `stop.at` for stopped runs; it includes bounce time. Phase 2 is the sum over CRs of `crN_done − crN_start`.

### 7.5 Parallelism and conflicts (`git.json`, `git-crN.json`)

`node measure-git.ts --repo <dir>/repo [--range <a>..main]`

- Merges come from `git log --merges` (`--no-ff` is mandated). Each 2-parent merge M = (P1, P2) is one issue branch, and its commits are `git log P2 ^P1`.
- **Conflicts.** Each merge is re-run with `git merge-tree --write-tree --name-only P1 P2`. Exit code 1 means a conflict, and the conflicted files are listed. **Rework** is the `git diff --numstat` line total between the automatic merge tree and the committed merge tree. Clean merges with a nonzero diff count as `amended_clean_merges`. `marker_commits` counts commits whose diff touches `^(<<<<<<<|>>>>>>>)` lines (`git log -G`). `rerere_entries` counts entries in `rr-cache`.
- **Parallelism.** Each branch gets an interval ending at its last commit time. *Lower bound*: the interval starts at the branch's first commit. *Upper bound*: it starts at the fork point (merge-base commit time). Reported per bound: max concurrent branches, mean concurrency (Σ interval lengths / union length), and busy span. Git cannot see when work started before the first commit. If the session logs carry agent spawn times, they supersede the lower bound (note this in run.json meta).

### 7.6 Performance (`perf.json`)

1. `git clone -q <dir>/repo <dir>/perf-checkout && git -C <dir>/perf-checkout checkout <measured sha>`
2. Provide a fresh SQLite database file in `<dir>` (D2), in the URL form the candidate's README documents.
3. `node measure-perf.ts --repo <dir>/perf-checkout --db-url <url> --port 8085 --out <dir>/perf.json --warmup 120 --duration 60 --reps 3 --connections 50`

The script runs `./bin/setup`, then starts `./bin/api` and one `./bin/worker` with `TASKWELL_TEST_MODE=true TASKWELL_TRUST_PROXY=true TASKWELL_LOG_LEVEL=warn`. Next it calls `POST /__test/reset` and `POST /__test/seed {"profile":"reference"}` (SPEC 14.1) and saves the seed response as `seed.json`. It then discovers workspaces, roles, projects, task samples and the largest project (by `summary.task_counts.total`), and mints up to 20 API keys per seeded user (`--keys-per-user`, SPEC maximum 20). Seed plus discovery time is reported as `seed_and_discovery_s`.

Load is **fixed-rate, not closed-loop**: every class is driven open-loop at a planned rate by the harness pacer (`harness/lib/pacer.ts`), so p99 is latency at a fixed, SPEC-bounded load and req/s is an input, not a result. The plan is a function of the discovered pool and the SPEC 6.8 limits only, so every SPEC-conformant candidate with the same seed shape gets the same rates:

* **Pool and slots.** Each API key gets its own `X-Forwarded-For` address (`10.100.x.y`, fixed per key), so the authenticated IP bucket (1,200/min) is per key. A slot is a (key, workspace) pair where the key's user holds a role; its weight is the role limit (owner/admin 600, member 300, viewer 60 per minute). Reads use every role, writes only owner/admin/member. `summary` uses only the workspace of the largest project. If a key's slot weights in a class sum above 1,200, they are scaled down to 1,200. `get_single` also hits `GET /v1/workspaces/{id}` in one third of its requests, which a server may count in the key-general bucket (120/min), so its per-key cap is min(1,200, 120 / ⅓) = 360.
* **Capacity rule.** `capacity_rps(class) = Σ slot weights / 60`; `planned_rps(class) = min(class rate, ⌊capacity_rps / 2⌋)` (2× headroom). Class rates: `get_single` 500, `list` 500, `search` 100, `write` 200, `summary` 100 req/s. A class whose pool cannot carry 1 req/s aborts the measurement.
* **Spreading.** Requests go to slots by smooth weighted round-robin (deterministic, interleaved), so every bucket of a class runs at the same utilisation `planned_rps / capacity_rps ≤ ½` of its limit per one-minute window. Object ids, filters and search terms within the slot's workspace are random. Each list request carries at most one filter of each kind (one `status` value set, `open,in_progress`).
* **Warm-up.** The warm-up mixes all classes by weighted round-robin in proportion to their planned rates, at a total rate scaled so that the summed utilisation Σ planned_rps/capacity_rps over the mix stays ≤ ½ (`warmup_rps`).
* **Smooth pacing.** Request *i* is scheduled at `start + i / planned_rps`, a fixed interval, so arrivals are evenly spread rather than bunched at second boundaries. `--connections` (50) connection loops share one keep-alive `node:http` agent with 50 sockets; a free connection takes the next due request, waits until its scheduled time and sends it. A request that starts late because every connection is busy is still timed from its scheduled time, so coordinated omission is handled explicitly: client-side queueing shows up in the latency, and the worst start lag is reported as `max_lag_ms`. The harness's own event-loop delay during each class run (`perf_hooks.monitorEventLoopDelay`) is reported next to it as `loop_delay_max_ms` and `loop_delay_p99_ms`: a large `max_lag_ms` with a low loop delay is a server stall, one with a matching loop delay is a harness stall. p50/p99 are nearest-rank over 2xx latencies (0.1 ms). Achieved `rps` = responses / (time from first scheduled start to last response); it falls below `planned_rps` only if the candidate cannot keep up. autocannon is no longer used (`autocannon: null` in `perf.json`).

On the reference pool (10 users × 20 keys, 10 workspaces, each user owner/admin/member/viewer in one) the capacity is far above every class rate, so the planned rates are the class rates. After `--warmup` seconds of mixed warm-up, each SPEC 14.2 class runs `--reps` × `--duration` seconds at `--connections` connections:

| Class | Requests (random mix within the slot's workspace) | Planned req/s | p99 target |
|---|---|---|---|
| `get_single` | `GET /v1/tasks/{id}`, `/v1/projects/{id}`, `/v1/workspaces/{id}` | 500 | 50 ms |
| `list` | task lists (project and workspace) with `limit=50` and random filter/sort combinations, activity, comments | 500 | 300 ms |
| `search` | `GET /v1/workspaces/{id}/search?q=<substring of a seeded title>` | 100 | 800 ms |
| `write` | `POST` task, `PATCH` task, `POST` comment (writer roles only) | 200 | 150 ms |
| `summary` | `GET /v1/projects/{largest}/summary` | 100 | 300 ms |

`perf.json` (schema 2) reports per class `planned_rps`, `capacity_rps`, the achieved `rps`, the median-of-reps p99 and the status breakdown, and under `load` the pacing (`"smooth"`), headroom, limits, warm-up rate and slot/key counts per class. It also reports the peak RSS of the api and worker process trees (SPEC: < 512 MiB each). A class is **invalid** if more than 1% of its responses are 429, other 4xx, 5xx, errors or timeouts. With the plan above a SPEC-conformant server returns no 429, so an invalid class points at the candidate (its rate limiter, validation or stability). Invalid results are reported but excluded from p99 comparisons. An achieved `rps` clearly below `planned_rps` means the candidate could not keep up at 50 connections; it is reported beside the p99. The machine must be idle during measurement: no team runs, and the same power profile every time.

**Container (C17, implemented 2026-10-25; `perf.json` schema 3).** By default the candidate runs in Docker, identical for both arms: image `node:26-bookworm-slim` (`--image`), `--cpus 2 --memory 1g --memory-swap 1g` (`--cpus`, `--memory`), running as the host uid, the checkout mounted read-write at `/app` (cwd), and `<dir>/perf-db` mounted at `/data`. Whatever URL form `--db-url` uses (`sqlite:./x`, `sqlite:/abs`, `sqlite:///abs`, `file:`, bare path), it becomes the same file name under `/data` (for example `sqlite:///data/x`). The image ships without corepack, so the harness entry script installs it with npm into a per-run home (`<dir>/perf-container/home`) and enables pnpm. `./bin/setup` runs first in a throwaway container with the same image, limits and mounts on `--network host` (it needs the 127.0.0.1:4873 registry). The serving container then starts `./bin/api`. After `/healthz` answers it starts one `./bin/worker` alongside, and logs go to `<dir>/perf-container/{api,worker}.log`. Running setup in its own container keeps install and build out of the serving container's `memory.peak`. The stop is `docker stop --time 10`, then kill. Network: `--network publish` is the default for both arms. It uses the default bridge plus `-p 127.0.0.1:<port>:<port>`, so traffic passes through Docker Desktop's port forwarder, which runs outside the cgroup, and the candidate must bind 0.0.0.0. `--network host` stays available, but on Docker Desktop (Linux VM backend) a host-network container is reachable from the VM's distro only when "Enable host networking" is on, and it is off. Liveness: the worker starts once `/healthz` answers, and the harness waits 3 s before reset/seed. From then on the api and worker are polled every second (in `/proc` inside the container, or the child process state with `--no-container`). If either exits, `candidate.<api|worker>_alive` is false, with `_exited_at` (to within the 1 s poll), `_exited_during` (startup, seed, warmup or the running class) and `_log_tail` (its last 20 log lines). The file then gets `valid: false`, and `invalid_reason` names the exit and any invalid classes. Per rep and class `perf.json` adds `p95_ms`, `max_ms` and `error_rate` (non-2xx + errors + timeouts over all attempts). For a class, p50/p95/p99 are medians of reps, `max_ms` is the worst rep and `error_rate` is pooled over reps. CPU comes from the container's cgroup v2 `cpu.stat`, read by `docker exec` before and after each class, the warm-up and the whole measurement. It is reported as `cpu_s`, `user_s`, `system_s` and `utilisation = cpu_s / (elapsed × cpus)`. Memory is reported under `memory`. `peak_mib` comes from `memory.peak`, or from `memory.current` sampled at 1 s if that file is missing. `current_max_mib` and `anon_max_mib` come from 1 s samples. `memory.peak` and `memory.current` include page cache (the seeded SQLite file is about 450 MB), so `anon_max_mib` and the per-tree RSS are the figures to compare. `rss_max_mib` keeps its shape: api and worker tree RSS, read from `/proc` inside the container because the image has no `ps`. `container` records image, image id, docker version, cpus, memory bytes and network mode. `--no-container` runs on the bare host as before (`container`, `cpu`, `memory` null).

### 7.7 Code metrics (`code.json`)

`node measure-code.ts --repo <dir>/repo --ref main` reads the committed tree only. **Source LOC** counts non-blank, non-comment lines of `.ts/.js/.mjs/.cjs/.tsx/.sql/.prisma`, excluding tests (`*.test.*`, `*.spec.*`, `*.e2e-spec.*`, `test/`, `tests/`, `__tests__/`, `e2e/`), migrations (counted separately), declaration files, `node_modules`, `dist` and `build`. It also reports test files, LOC and cases (`it(`/`test(`/`t.test(` calls), direct production and dev dependencies across all `package.json` files (workspace links excluded), locked packages (pnpm or npm or yarn lockfile), DB driver hints, murmur pieces and contract files, and Nest modules. The **coverage proxy** is test cases per 100 source LOC, plus test LOC divided by source LOC.

**Structure (murmur arm, open item, owner 2026-10-25):** `measure-code.ts` also runs `murmur catalog --json` on the checkout and records `groups` (folders under `pieces/` without `piece.ts`), `max_depth`, `pieces_per_group` (min/median/max), `largest_piece_tokens` and `pieces_over_large_tier` (§2.2 caps), `edge_pieces` vs `domain_pieces`. Nesting is never prescribed to the team (the kickoff names pieces and the bus only; the example app shows one group, `pieces/api`); whether and how deep a team nests is a result.

### 7.8 Readability session (`readability.json`)

Phase 1 only, 30 minutes per run, done by the owner (and a second rater if one is available). The run order is randomized per rater, and each rater writes the scores before seeing any other metric of that run. The rater can see the framework, which is unavoidable (C10).

- **Probes, each capped at 6 min, time recorded in minutes.** P1: find where claim atomicity (only one claim wins) is enforced. P2: find where the 08:00-local digest due time is computed. P3: trace `POST /v1/projects/{id}/tasks` to the webhook delivery attempt. P4: list every file you would touch to add a new nullable task field returned everywhere.
- **Likert 1–5.** L1: I could orient myself quickly. L2: related logic lives together. L3: names say what things do. L4: the tests show the intended behaviour. L5: I would be confident changing this. L6: the framework's structure helped rather than hindered.

### 7.9 Collection

`node collect.ts --run <dir>` merges `run.json`, `results*.json`, `adjudication.json`, `bugs.json`, `tokens.json`, `git*.json`, `perf.json`, `code.json` and `readability.json` into `run-results.json` and `row.md`, and lists the missing files.

### 7.10 Tabulation

`node tabulate.ts --phase phase1|phase2 [--json]` prints, for every metric, a 2×2 table (rows: opus, sonnet, all; columns: murmur, nestjs, Δ) whose cells show mean (min–max, n). It also prints the per-run rows, the hypothesis verdicts, and input-drift warnings.

### 7.11 Framework friction (qualitative, reported beside the numbers)

Report the size of `FRAMEWORK-ISSUES.md` (entries and severity) and the workarounds in the app, plus the murmur `murmur check` result on the final `main`. A murmur boundary violation is reported, not scored.

### 7.12 Leak audit (every run)

Grep the team user's session transcripts (`~<team user>/.claude/projects/**/*.jsonl`) for `murmur-lab`, `/private/` (the sealed directory's name at the time), `TRAPS`, `PHASE2`, `EXPERIMENT`, `benchmark` and `hidden suite`. Also look for paths outside `repo/` and the snapshot. The murmur arm is additionally checked for reads of NestJS material outside its own deps, and the NestJS arm for `murmur`. A confirmed read of sealed material voids the run.

## 8. Scoring

### 8.1 Hidden suite

Weights are set at the level of test **kinds**, not individual tests. The suite has about 46 trap ids, 13 smoke walkthroughs and over 400 endpoint-error tests, so per-test weights would let error coverage swamp the traps.

- **T** (trap score) = the mean over executed trap ids of (passed tests ÷ executed tests of that trap). A trap with 3 tests of which 2 pass scores 0.667.
- **S** (smoke) = pass rate over executed `[SMOKE-n]` tests.
- **E** (endpoint errors) = pass rate over executed `[ERR]` tests.
- **W = (3·T + 1·S + 1·E) / 5.** Traps carry 60% of the score and weigh 3× the happy path. A kind with no executed tests drops out of both numerator and denominator.
- `skip` and `todo` are excluded from every denominator, matching the suite's own pass-rate definition, and are reported as a count. The worker stop/start commands keep skips near zero.
- Also reported: unweighted pass rate, T, traps fully passed, S, E, pass rate per category A–L, and counts of trap outcomes (§7.2).
- **Phase 2.** W after each CR is computed over v1 + all CR tests delivered so far, where CR tests carry kind `trap` or `happy` as the suite tags them. **Regressions after CR-N** are the v1 test names that passed after CR-(N−1) (after phase 1, for CR-1) and fail now. Final W is the score after CR-3.

### 8.2 Other metrics

| Metric | Formula | Better |
|---|---|---|
| New defects (weighted) | Σ over confirmed, not-in-suite defects of {critical 5, major 3, minor 1} | lower |
| Tokens (total, fresh) | §7.4 | lower |
| Tokens per CR | mean over CR-1..3 of `by_cr[CR]` totals | lower |
| Wall-clock | §7.4 | lower |
| Agent turns | `tokens.json.agent_turns` | lower |
| Parallelism | max and mean concurrency, both bounds (§7.5) | higher |
| Conflicts | conflicted merges, conflicted files, resolution lines | lower |
| Performance | classes meeting p99 target (0–5) and p99 per class, both at the planned fixed rate (§7.6); validity per class. Achieved req/s is descriptive (it equals the planned rate unless the candidate falls behind), not compared | higher met / lower p99 |
| Code | source LOC (descriptive), direct prod deps, locked packages, test cases, cases per 100 LOC | — / lower / lower / higher / higher |
| Readability | mean Likert; total probe minutes | higher / lower |

There is deliberately no composite score. Each hypothesis names its own metrics, and everything else is reported beside them.

## 9. Results schema

### 9.1 Files per run directory

| File | Producer | Shape |
|---|---|---|
| `run.json` | new-run, stamp | `RunMeta` in `harness/lib/schema.ts`: id, phase, framework, model, n, orchestrator/implementer/reviewer model, framework_ref, source_run, base_sha, `inputs` (sha256 of spec, smoke, kickoffs), `timestamps` (created, kickoff, done, accepted, crN_start/done/accepted), `shas`, `bounces[]`, `stop`, `meta` (db_engine, claude_code, isolation, …) |
| `kickoff.md` / `kickoff-crN.md` | new-run | prompt text |
| `session-settings.json` | new-run | Claude Code settings passed with `--settings` |
| `suite/results.json` / `suite-crN/results.json` (or flat `results.json` / `results-crN.json`) | hidden suite `scripts/run.sh` | the suite's `ResultsFile` (`suite/reporter/model.ts`): `{generatedAt, complete, baseUrl, summary, harnessErrors, tests: [{name, file, trapId, trapIds, category, kind: "trap"\|"happy"\|"errors"\|"other", status: "pass"\|"fail"\|"skip"\|"todo", durationMs, message, diagnostics, classification}]}`; the harness reads only `tests` (`SuiteTest` in `harness/lib/schema.ts`) |
| `adjudication.json` | adjudicator | `{adjudicator, trap_outcomes: {"A1": "covered", …}, tests: [replacement SuiteTest entries, matched by name], notes}` |
| `bugs.json` | tester + confirmation | `{tester_model, budget_tokens, bugs: [{id, title, severity, confirmed, in_hidden_suite, spec_ref}]}` |
| `tokens.json` | owner | `{source, totals: {input, output, cache_read, cache_write}, by_role: {orchestrator: {…, model, turns}, implementer: {…}, reviewer: {…}}, by_cr?: {"CR-1": {…}}, agent_turns, agents_spawned, usd?}` |
| `git.json`, `git-crN.json` | measure-git | `GitMetrics` |
| `perf.json`, `seed.json` | measure-perf | per-class `TargetResult`, `targets_met`, `valid`, `rss_max_mib`, pool stats |
| `code.json` | measure-code | `CodeMetrics` |
| `readability.json` | rater | `{rater, minutes, probes_minutes: {P1..P4}, likert: {L1..L6}, notes}` |
| `run-results.json`, `row.md` | collect | `RunResults` in `harness/collect.ts` |

### 9.2 `run-results.json` (one per run)

`{schema, id, phase, framework, model, n, db_engine, inputs, framework_ref, status: {accepted, done_reported, bounces, stop_reason}, suite: {total, executed, passed, skipped, pass_rate, weighted, trap: {total, passed, rate}, happy, errors, by_category, by_trap, trap_outcomes}, crs: {"CR-N": {suite, regressions[], tokens_total, wall_clock_s, conflicted_merges}} | null, bugs: {reported, confirmed, confirmed_new, weighted}, tokens: {input, output, cache_read, cache_write, total, fresh, agent_turns, agents_spawned, usd}, wall_clock_s, git: {…GitMetrics without merges_detail}, perf: {targets_met, valid, p99_ms{}, rps{}, rss_max_mib}, code: {src_loc, test_loc, migration_loc, test_files, test_cases, deps_prod, deps_dev, lock_packages, units, coverage_proxy}, readability: {score, probes_total_min, likert}, missing[]}`

### 9.3 Published tables

`$RUNS/<phase>/RESULTS.md` comes from tabulate. It contains the hypothesis verdicts, one row per run (accepted, W, trap %, smoke %, weighted new defects, tokens, wall h, conflicts, max parallelism, perf met, source LOC, tests), and one 2×2 table per metric. Every run uses SQLite (D2). `db_engine` is still recorded from dependency hints as a check, and a run that used any other engine is flagged as a protocol deviation.

## 10. Confounds and mitigations

| # | Confound | Mitigation | Residual |
|---|---|---|---|
| C1 | Training-data asymmetry (NestJS deep, murmur none) | Stated up front. murmur's docs and tooling are part of the treatment. Count framework-API misuse findings from reviews and `FRAMEWORK-ISSUES.md` to show where the asymmetry bites. | Not removable; results read "murmur despite zero priors". |
| C2 | Framework maturity: murmur v0 bugs vs a mature NestJS | Snapshot frozen for the whole experiment (sha recorded; tabulate warns on drift). G1 requires the example app to pass. Teams log defects in FRAMEWORK-ISSUES.md. A framework fix mid-experiment voids every murmur run before it. | murmur bugs count against murmur, by design. |
| C3 | Author bias: the owner designed murmur, SPEC.md and the hidden suite | Suite frozen and hashed before the first counted run. Black-box tests only. The adversarial tester is black-box. Adjudication is spot-checked. | The owner's taste in spec shape remains. |
| C4 | Teaching to the test: murmur features added after SPEC/TRAPS were written may target traps (idempotency, outbox, clock) | Freeze the snapshot before the pilot. The owner fills `experiment/FRAMEWORK-CHANGELOG-vs-TRAPS.md` (D7, G15), which is published with the results. | Disclosed, not removed. |
| C5 | DB engine choice would change perf and the concurrency traps (SQLite serializes writers) | Resolved by D2: SQLite in both arms. `db_engine` hints are checked per run. | Results do not generalise to PostgreSQL deployments. |
| C6 | Leakage through the filesystem and through murmur's dev repo (.agents thesis) | D1 (runs outside the lab), §3 (OS user + ACLs, deny rules, release snapshot without .agents, leak probe and audit). | A Bash read outside the ACLs is the remaining hole; the ACLs close it. |
| C7 | Small n (2 per cell) and model nondeterminism | Pre-registered rules. Blocks with randomized order. Third run per arm when verdicts are close (§1). Report spreads, never just means. | Low power; claims stay directional. |
| C8 | Time-of-day and API-load effects on wall-clock and on retries | Blocks (one run per arm per block). Wall-clock reported next to tokens, never alone. Sequential execution (D6). | Some noise in wall-clock. |
| C9 | Reviewer model unspecified in the owner's original design | D3: pinned to the implementer model. | H2 reads "a cheaper team", not "a cheaper implementer alone". |
| C10 | Readability rater is not blind (the framework is obvious from the code) | Timed probes as the primary signal. Likert scores secondary. Second rater if possible. Scores written before seeing other metrics. | Rater bias is likely pro-murmur; discount Likert accordingly. |
| C11 | Plugin agents bring curated role prompts that the NestJS arm lacks, and may pin a model | Legitimate treatment per the design. G14 forbids model pins and G7 checks the models in the pilot logs. Report how often plugin agents were used. | Part of what is measured. |
| C12 | Survivorship in phase 2 (only accepted runs continue) | Replacement runs, attrition reported per arm, phase-1 results include all runs. | Phase-2 arms may differ in phase-1 quality; report phase-1 W of the runs that entered phase 2. |
| C13 | Phase-2 fresh sessions favour codebases with built-in agent memory (murmur `context.md`) | Treatment, not a confound per the brief. The NestJS team may write equivalent docs; both arms carry PLAN.md and issues/. | — |
| C14 | Perf rate limiting and host noise | X-Forwarded-For + key pool + invalid flag. Idle host, 3 reps, median. Same Node and DB server. | Virtualised-host timer noise; compare only same-host results. |
| C15 | Git-derived parallelism depends on commit habits | Both bounds reported. Agent-spawn timestamps from logs supersede when available. | — |
| C16 | Example-app overlap: murmur's example (`todo-api`) is close to a task tracker | G3 also checks that the example implements none of Taskwell's mechanics (cursors, idempotency keys, ETag/If-Match, outbox, digests, webhooks with HMAC). Trim it if needed. NestJS docs have their own CRUD samples. | — |
| C17 | Perf and memory measured on the bare host: a candidate that spawns more processes or holds more memory looks the same as a lean one while the host is idle (owner, 2026-10-25) | Before block 1: `measure-perf.ts` runs the candidate inside one cgroup-limited container for both arms (`docker run --cpus 2 --memory 1g`, same node image, SQLite file on a volume), records per class p50/p95/p99/max latency and the error rate per rep (today: p50 and p99 per rep, median-of-reps p99, status breakdown; no p95, no CPU), peak RSS and CPU time (user+sys, from the cgroup) of the api and worker trees, and the container's own cpu/mem limits in `perf.json`; D6 "no containers" then applies to the agent runs only, not to the perf step. Open item until implemented. | Container overhead is identical in both arms; cgroup limits inside a Linux VM are approximate. |

## 11. Go/no-go checklist (all must be ticked before block 1)

| # | Check | How | ✓ |
|---|---|---|---|
| G1 | **murmur v0 passes its own example app.** Snapshot installs and its example's tests and checks are green. | `pnpm --dir <snapshot> install && pnpm --dir <snapshot> check && pnpm --dir <snapshot> example` (example served; its scenario tests pass). Record the snapshot tag and sha256 here: `______` | ☐ |
| G2 | The murmur plugin (skills, agents, hooks; CLI only, no MCP since murmur V10b, owner 2026-10-25) and `murmur ctx` / `murmur check` / `murmur test` work from the snapshot in a fresh session as the isolated OS user. | Manual: `murmur catalog`, `murmur ctx`, and `murmur check` on the example | ☐ |
| G3 | The snapshot is clean of leaks and example overlap. | `grep -rniE 'taskwell\|benchmark\|experiment\|murmur-lab\|nestjs' <snapshot>` returns nothing; no `.agents/`; example mechanics review (C16) | ☐ |
| G4 | **The hidden suite runs against the stub.** `suite/stub/server.ts` (only `/healthz` and reset; 501 elsewhere) yields a complete `results.json` (`complete: true`, empty `harnessErrors`, no `uncoveredTraps`), and `harness/collect.ts` reads it. | `pnpm --dir suite selftest`, then copy `out/selftest/results.json` into a scratch run's `suite/` and run `node collect.ts --run <scratch run>` | ☑ 2026-10-24: complete=true, harnessErrors=0, uncoveredTraps=[]; collect read it |
| G5 | The hidden suite is validated as passable. Recommended: every test passes against at least one reference implementation, or each non-passing test has been reviewed against SPEC.md. | Reference run or review log | ☐ |
| G6 | The harness is green. | `pnpm --dir harness typecheck && pnpm --dir harness test` | ☑ 2026-10-24: 41/41 (re-run before the pilot) |
| G7 | Model enforcement: implementers, reviewers and plugin agents run on the arm model, and the orchestrator runs on fable. | Pilot logs show the model per agent | ☐ |
| G8 | Kickoffs are frozen and identical except for the framework paragraph. | `kickoff.test.ts` passes; `sha256sum experiment/KICKOFF-*.md` recorded: `______` | ☐ |
| G9 | Leak probe: from a session of the isolated OS user in a fresh run repo under `$RUNS`, reading `<lab>/experiment/TRAPS.md`, `<lab>/harness/`, a sibling run's `repo/` and `run.json`, and the murmur dev repo's `.agents/` all fail. | Manual, before each block | ☑ 2026-10-25: the team-user setup script run by the owner (acl installed); `sudo -u <team user> -i cat experiment/TRAPS.md` → Permission denied; `claude --version` as the team user → 2.1.310. Re-run the probe against `harness/` and the murmur dev repo's `.agents/` before block 1. |
| G10 | `measure-perf.ts` works on a real candidate (the pilot's): valid on all 5 classes, seed completes in ≤ 5 min. | Pilot; pre-validated on the reference 2026-10-24 with smooth open-loop pacing: 5/5 valid, 0 non-2xx responses, achieved rate within 0.01 % of planned 500/500/100/200/100 req/s (get_single/list/search/write/summary). Short run (20 s warm-up, 1 × 60 s): p99 9.8/14.0/8.1/20.2/7.0 ms. Production settings (120 s warm-up, 3 × 60 s): median p99 10.9/13.6/9.7/25.6/7.9 ms, 5/5 met, seed + discovery 3.4 s, wall 16 min 38 s | ☑ 2026-10-24 (reference; repeat on the pilot) |
| G11 | **Pilot.** One uncounted phase-1 run per framework (sonnet). Used to calibrate the caps (§6), check monitoring and the token export, and exercise every measurement. Pilot data is never counted, and nothing in SPEC, suite, kickoff or snapshot changes after the pilot without repeating it. | Pilot report | ☐ Three pilots ran (NestJS, murmur 0.2.1, murmur 0.3.0 after the murmur loop); the log is §13. Not ticked: no counted block followed, the experiment closed here. |
| G12 | **Cost estimate per run, filled in by the owner from the pilot** | table below | ☐ |
| G13 | Phase 2 only, before the first CR is delivered: the suite gains CR-1..3 tests (from PHASE2.md acceptance criteria), a CR-adjusted smoke subset, and v1 tests runnable under the CR call changes. Then G4 is re-run. | Suite selftest + one dry run on a pilot repo | ☑ 2026-10-24 (reference; repeat the dry run on the pilot): CR-1 35, CR-2 22, CR-3 20 tests; selftest none 2/692 and CR-3 2/769 pass against the stub (complete, harnessErrors=0, uncoveredTraps=[]); reference per CR build: none 692/692, CR-1 722 pass 0 fail 5 skip (4 legacy without manifest, 1 obsolete), CR-2 732/0/17, CR-3 751/1/17 (`[CR3-8]` worker-kill variant: 3 member_added `send` entries landed inside the export range, timing-dependent, pending adjudication); collect read suite-cr1..3 on a scratch phase-2 run (0 regressions vs phase 1) |
| G14 | No murmur plugin agent or skill pins a model (D4). Checked before the snapshot is cut. | `grep -rnE '^model:' <murmur repo>/plugins/murmur` returns nothing (repeat on the snapshot) | ☐ |
| G15 | `experiment/FRAMEWORK-CHANGELOG-vs-TRAPS.md` is filled and signed off by the owner (D7). | Every murmur feature or commit after SPEC.md's first version is listed, with traps eased or "none" | ☐ |
| G16 | The host is free for sequential runs: the candidate port (8085 by default, `LAB_CANDIDATE_PORT`; 8080 is held by an unrelated keycloak container, so the lab does not use it) is free and no run is active. | `ss -ltn \| grep ':8085 '` returns nothing; `new-run.ts` does not refuse | ☑ 2026-10-24: 8085 free; new-run created a scratch run |

**Cost estimate (owner fills in after pilot):**

| Arm | Phase 1 fresh tokens (est.) | Phase 1 $ / plan-usage % | Phase 2 fresh tokens per CR (est.) | Phase 2 $ / usage % (3 CRs) | Wall-clock P1 / P2 (est.) |
|---|---|---|---|---|---|
| murmur-opus | | | | | |
| murmur-sonnet | | | | | |
| nestjs-opus | | | | | |
| nestjs-sonnet | | | | | |
| **Total for 8 + 8 runs (+ pilots, + replacements budget 25%)** | | | | | |

## 12. Results (filled after each phase)

- The experiment closed after the uncounted pilots; no counted phase ran, so H1–H3 have no verdict.
- Pilot results: §13 below, `../results/`, `../../docs/research/results.md`.
- Voided runs: none.
- Deviations from this plan: the murmur kickoff still named the MCP server that 0.2.1 had already removed; only one
  of three pilots ran as the isolated OS user (G9); `FRAMEWORK-CHANGELOG-vs-TRAPS.md` (G15) was never filled; the
  murmur arm was iterated between pilots (the pilot loop in §13) instead of proceeding to block 1.

## 13. Pilot log (the G11 record, moved out of the gate table)

NestJS pilot `nestjs-sonnet-1` started 2026-10-25 03:31Z in the pilot runs root `murmur-runs-pilot`, headless, as the owner's user (no isolated OS user yet, so G9 is not exercised by this pilot), `--setting-sources project`. murmur pilot `murmur-sonnet-1` started 2026-10-25 03:50Z in `murmur-runs-pilot-murmur` as the isolated OS user, headless, snapshot 0.2.1 from the lab registry on :4873; plugin skills and agents loaded (session init lists murmur:piece-writer / piece-reviewer and the three skills). G1/G3/G14 green on this snapshot; `release:verify` green.

**Pilot finding P1 (harness):** headless `claude -p` ends the session 10 min after the orchestrator's last turn even while a background agent runs (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`); `nestjs-sonnet-1` lost agent 013 at 05:31Z with 12/14 issues merged and no DONE.md. Fix: `session-settings.json` env now sets the ceiling to `0` (`new-run.ts`); the pilot was resumed at 05:40Z with `--resume` and a harness notice (`run.json` meta `resumed_at`, `resume_reason`). A counted run that hits this is a harness failure, not a team failure: resume once, record it, do not count as a bounce.

**Pilot loop (owner decision 2026-10-25):** the murmur pilot is iterated, not followed by block 1. After each murmur pilot: acceptance, read its `FRAMEWORK-ISSUES.md` and structure metrics, fix the framework, publish a new snapshot, run a fresh murmur pilot from zero (new run dir, same kickoff). Exit when a pilot yields no new blocker or major framework issue and acceptance passes; cap 3 murmur pilots. Framework fixes must be generic (helpers, capabilities, ctx wording); nothing that encodes Taskwell's shape or a trap area, checked by G15 before each snapshot. The NestJS pilot is repeated only when harness or kickoff changes.

**murmur pilot 1 result (2026-10-25):** DONE.md 05:37Z, 1 h 47 min from kickoff, 84 agents, 105 commits / 32 merges (1 conflicted), orchestrator-reported cost $72.2; acceptance 13/13 at 05:43Z; full suite 687/692 (traps 213/217: D5 partial, G4 fail, I1 partial, L3 partial; errors 461/462, the slug `too_long` detail is reported as `invalid_format`). code.json: src 11,971 LOC / 161 files, tests 11,698 LOC / 612 cases, 23 pieces, 6 app-local capabilities incl. a 2,068-LOC `kit` helper library. 9 items in the team's FRAMEWORK-ISSUES.md (sqlite busy timeout, launcher child process, ingress in worker, healthz override, peer address, jitter type, runContext export, 404 envelope, bin name).

**Pilot finding P2 (harness):** the run repo's `.git` is owned by the isolated OS user, so `measure-git` (merge-tree) fails with `insufficient permission`; run it on an owner-owned clone with every `origin/*` branch tracked locally (`git branch --track`), as done for this pilot. Fold into `collect`/a `measure-all` step before block 1.

**NestJS pilot 1 result (2026-10-25):** DONE.md 06:15Z, 2 h 44 min from kickoff incl. the P1 interruption (05:31Z–05:40Z), 31 agents, 93 commits / 17 merges (7 conflicted, 100 resolution lines), orchestrator-reported cost $41.4 (two sessions); acceptance 13/13 at 06:24Z; full suite 686/692 (traps 212/217: F2 partial, G4 fail, I1 partial, L3 fail; errors 461/462, same slug `too_long`-vs-`invalid_format` detail as murmur). code.json: src 8,930 LOC / 209 files, tests 7,357 LOC / 531 cases, 25 Nest modules, 513 locked packages (murmur: 139). FRAMEWORK-ISSUES.md: none.

**Shared misses (G4, I1 slug detail, L3, errors slug) in both arms with the same team model:** candidates for a spec or suite ambiguity rather than a framework effect; owner adjudicates before block 1 (§7.2), nothing in the suite changes without a note here.

**v0.3 and murmur pilot 2 (2026-10-25):** framework fixed from the pilot-1 evidence (V11a runtime fixes; v0.3 design in the murmur repo .agents/docs/design-v0.3.md, ten milestones V11b–V11k: sequential guards with route meta, req.read/req.reply, rejectable outputs, idempotent routes, jobs capability, clock + kv.incr, callback transactions + murmur migrate, processes, test fakes + createTestApp, lib lane); 0.3.0 published to the lab registry, snapshot `murmur-release-test` (a release copy beside the dev repo) at the 0.3.0 release commit (RELEASE.md built 12:21Z), release:verify green, G1 new app from registry check clean, G3 leak grep empty, G14 no model pins. Pilot 2 `murmur-sonnet-2` kicked off 2026-10-25T12:23:13Z in `murmur-runs-pilot-murmur-2` as the owner's user (headless, same kickoff/spec/smoke hashes as pilot 1, session env sets the P1 ceiling to 0).

**murmur pilot 2 result (2026-10-25):** DONE.md 14:18Z, 1 h 55 min from kickoff, 50 agents, 74 commits / 21 merges (2 conflicted, 11 lines), orchestrator-reported cost $63.8; acceptance 13/13 at 14:24Z; full suite 672/692 under the suite's strict drain reading (traps 200/217) and 684/692 with `SUITE_DRAIN_PENDING=any` (traps 212/217: G4 fail, I1 partial, I5 partial, L3 fail; errors 459/462: slug/url/secret length details reported as `invalid_format`). The 12-test gap is one reading of SPEC 13.4: the team's `/__test/jobs/drain` reports `pending` as every pending job, retries not yet due included, while the suite reads the example `"pending": 0` as due jobs only (pilot 1 and NestJS report due only). Owner adjudicates the wording; the `SUITE_DRAIN_PENDING=any` switch in `suite/lib/testmode.ts` is an adjudication aid, never the default. I5 partial: the edge reads params and body in one `req.read`, so a malformed body answers 400 before the 404 visibility check (framework DX finding: `req.read` invites parse-before-lookup; v0.4 candidate). code.json: src 11,699 LOC / 168 files, tests 10,902 LOC / 567 cases, 21 pieces, 139 locked packages; edge pieces 998 LOC for 62 routes (pilot 1: 3,574 / 61; NestJS controllers 691 / 62), app-local capabilities 65 LOC (pilot 1: 1,720 + 2,068 kit), lib 755, contracts 614; 92 distinct lines shared by ≥3 pieces (pilot 1: 83). FRAMEWORK-ISSUES.md: 3 (`murmur check --fix` rewrites `\u` escapes in regex literals into raw characters, `req.read` rejects a `z.record` body part and `ReplyBody` is not exported, no public API to purge the jobs queue).

**C17 perf, all three candidates (2026-10-25, docker node:26-bookworm-slim, 2 cpus / 1 GiB, api + worker in one container, warmup 120 s, 3 × 60 s, 50 connections, publish network):** NestJS valid, 5/5 targets, p99 get 1.9 / list 15 / search 96 / write 13 / summary 4 ms, error rate 0, cpu 23 % of 2 cores, api RSS max 146 MiB, worker 103, anon peak 126 MiB. murmur pilot 1 valid, 5/5, p99 4.2 / 55 / 8.2 / 26 / 9.8 ms, error rate 0, cpu 37 %, RSS 218 / 164, anon 219 MiB. murmur pilot 2 valid, 3/5: get p99 17 ms, write 24, summary 8.1 met; list collapsed (357 of 500 rps, p50 12.1 s, p99 23.7 s) and search (67 of 100 rps, p50 14.5 s, p99 29.5 s, 0.3 % timeouts); cpu 45 %, RSS 383 / 162, anon 377 MiB. Diagnosis on the host (paced 15 rps, 10 seed keys, no container): unloaded cost per request is the same for both murmur pilots (list ≈ 3.5 ms server CPU, p50 3.3 ms; NestJS ≈ 1.0 ms, p50 1.7 ms; search pilot 2 p50 14 ms vs pilot 1 8.3 vs NestJS 6.5); both murmur APIs burn ≈ 4.4 % of a core idle (NestJS 0) — framework background work, v0.4 item. The load collapse is contention, not per-request cost: pilot 2 counts its four rate-limit buckets in SQLite on every request (`countRequest(this.db, …)` in `pieces/auth/piece.ts`, a write transaction per request shared with the worker's writes), pilot 1 kept counters in memory. The v0.3 design offered `kv.incr` as the counter primitive, so the framework nudged the team towards durable counters; scored as an app design choice with a framework DX contribution. perf.json schema 3 in each run dir; perf-checkout and perf-db kept. G15 changelog-vs-traps is still to be filled before any counted block.
