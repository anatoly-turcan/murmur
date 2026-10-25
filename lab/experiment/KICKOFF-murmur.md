# Kickoff

Your team will build the product described in `SPEC.md` in this repository, to the definition of done in its section 15. `SMOKE.md` lists happy-path walkthroughs that must pass before you report done; they do not replace the specification. `FRAMEWORK.md` repeats the framework section below.

## Framework

Build the product with **murmur**, an agent-first TypeScript application framework for Node 26. A murmur application is a set of small, independent pieces that never import each other and communicate only through a message bus using typed contracts; each piece is sized so that one agent session can hold all of it. The framework is provided at `{{FRAMEWORK_REF}}`; its packages (`murmur`, `@murmur/*`) are published to the package registry configured in this repository's `.npmrc`. Start with its README and its documentation, which explain how to add it to a project, how to structure pieces, groups and contracts, and how to run and test an application. murmur ships its own agent tooling, and that tooling is part of the framework: the Claude Code plugin (agents `piece-writer` and `piece-reviewer`, and skills for writing pieces and contracts and for reviewing them), the MCP server, and the CLI, including `murmur ctx <piece>`, which assembles the context an agent needs to work on one piece, and `murmur check`, which enforces piece boundaries. The plugin and the MCP server are already enabled in this session; use them as the framework documentation describes. Use only the framework's documented public API and do not modify the framework itself; if a framework defect blocks you, work around it inside the application and record it in `FRAMEWORK-ISSUES.md`. The choice of the libraries used inside pieces is yours.

## Team and process

You lead a small engineering team. You do not write product code yourself: you plan, split the work into issues, dispatch agents, read their results and merge. The team has exactly three roles: you, implementers and reviewers. Do not add any other layer (no sub-leads or managers between you and the implementers).

1. **Plan.** Read every document you were given in full. Write or update `PLAN.md` at the repository root: architecture, data model, the breakdown into units of work, the order of work, the risky areas, and the assumptions you make where the specification is silent.
2. **Split.** Write each unit of work as an issue file `issues/NNN-short-name.md` (numbering continues across the life of the repository) containing: the goal; the files or areas it owns; the specification sections it implements; the issues it depends on; and a **done-check**, meaning the exact command to run (normally a test command) and the behaviours that command must prove. One implementer must be able to finish one issue in one session.
3. **Build.** For each issue whose dependencies are merged, start one implementer agent in its own git worktree on branch `issue-NNN`, created from the current `main`. Run independent issues in parallel, with at most 6 implementers working at the same time. An implementer writes the code and the tests that pin the issue's behaviour, runs the done-check and the existing tests, and commits on its branch. Implementers never touch `main`.
4. **Review.** For each finished branch, start one reviewer agent that did not write it. The reviewer is adversarial: it reads the issue, the relevant specification sections and the diff, runs the done-check and the full test suite, looks for behaviour that contradicts the specification and for missing tests, and returns either `approve` or `changes_requested` with concrete findings.
5. **Fix.** On `changes_requested`, start a fresh implementer on the same branch with the findings; the reviewer then reviews again. At most 2 fix rounds per issue. After the second round you decide: merge as is, move what remains into a new issue, or drop the issue and say why in its file.
6. **Merge.** Merge each approved branch into `main` with `git merge --no-ff issue-NNN`. Resolve conflicts yourself or hand the branch back to an implementer to bring it up to date with `main`. Run `./bin/test` on `main` after every merge; if it is red, open a fix issue before merging anything else. Remove merged worktrees and mark the issue file done.
7. **Repeat** until the definition of done below is met.

Rules:

- Use SQLite as the database engine.
- Implementer and reviewer agents run on the model configured for this team; do not override it.
- Work only inside this repository and the framework resources named above. Do not look for or read other projects or directories on this machine.
- Commit locally only; do not push anywhere and do not add remotes.
- Where the specification is silent or ambiguous, decide, and record the assumption in `README.md`. Do not ask questions: nobody will answer them during the work.

## Done

You are done when every issue is merged or explicitly dropped; `./bin/setup`, `./bin/api`, `./bin/worker` and `./bin/test` work from a clean checkout following only `README.md`; every walkthrough in `SMOKE.md` passes against a fresh instance; and you judge that the definition of done in section 15 of `SPEC.md` is met. Then write `DONE.md` listing what is implemented, what is missing or partial, known defects, and how you verified `SMOKE.md`; commit it to `main`; and stop.
