# Performance run (SPEC 14.2)

## Machine and setup

- A Linux workstation, Node 26.12.1, pnpm 12.11.2, SQLite through `node:sqlite`, database on the
  local ext4 disk.
- Fresh clone of branch `issue-020`, `./bin/setup`, then `./bin/api` and `./bin/worker` (one each, separate
  processes) with `TASKWELL_TEST_MODE=true TASKWELL_DATABASE_URL=sqlite:./taskwell.db TASKWELL_PORT=18090`.
- `/healthz` answered 1.0 s after start. Setup took 0.4 s with a warm pnpm store.
- Load generator and server ran on the same machine.

## Reference dataset

`POST /__test/seed {"profile":"reference"}` on an empty database: **31.0 s and 31.7 s** (two runs, HTTP 200, limit
5 min; the edge waits up to 600,000 ms so no timeout change was needed). Database file: about 255 MiB after seeding.

## Method (`scripts/perf.mjs`)

50 concurrent clients (each carrying about 0.6 s of think time, so the offered load is about 80 req/s because of the
per-key rate limits in the spec), a 120 s warm-up with the same operation mix, then measurement until every operation has at
least 2,000 successful samples per operation, and p99 is taken over those 2,000 samples (latency measured by the client from request start to the end of the body). The
ten seeded users' keys are used (18 key+workspace contexts, 16 workspaces).

The rate limits of SPEC 6.8 cap what ten keys can send: owner/admin 600, member 300 and viewer 60 requests per
minute per key+workspace, and 1,200 per minute per IP. Left alone, the 50 clients would receive 429s almost all
the time. The generator therefore:

- rotates the clients over 6 loopback source addresses (127.0.0.11 to 127.0.0.16), so the per-IP bucket is never
  the limit;
- keeps a client-side budget per key+workspace (95 % of the role limit, released evenly over each minute) and only
  chooses contexts that still have budget; writes use owner/admin/member contexts, the summary uses the contexts of
  the workspace that holds project 1;
- sleeps a random think time after every response (mean about 0.6 s) so the offered load (about 79 req/s) stays
  just under the aggregate limit instead of bursting at each window rollover;
- excludes 429 responses from the latency samples and reports their count.

The consequence: the test offers about 80 requests per second, which is the most these keys may send, not the most
the server can serve (an unthrottled burst with 50 closed-loop clients measured about 4 ms per request, about 230
req/s, on one thread). Operation mix, picked proportionally to the samples still missing: `GET /v1/tasks/{id}`;
project and workspace task lists with `limit=50` and random combinations of `status`, `assignee_id` (`me`, `none`,
an id), one or two `label`s, `overdue`, `due_after`/`due_before`, `sort` (`created_at`, `updated_at`, `due_date`),
`project_id`; `GET /v1/workspaces/{id}/search` with 3-letter and 5-letter prefixes and whole words taken from
titles; `POST` task, `PATCH` task (status, title or labels), `POST` comment; `GET /v1/projects/1/summary` (the
2,000-task project).

## Results

Run A (no webhook endpoint active). Run B (`--hang`): every owner/admin workspace gets an active webhook for
`task.created`, `task.updated` and `comment.created` pointing at a receiver that accepts connections and never
responds, so every write creates a delivery whose attempts time out (SPEC 14.2 "also applies while a receiver
never responds").

| Operation (p99, ms)                    | Target | Run A | Run B (hanging receiver) | p50 (A) |
| -------------------------------------- | -----: | ----: | -----------------------: | ------: |
| `GET /v1/tasks/{id}`                   |     50 |  32.6 |                     35.4 |     2.2 |
| Task lists, `limit=50`, project form   |    300 |  41.8 |                     40.4 |     3.2 |
| Task lists, `limit=50`, workspace form |    300 |  40.8 |                     36.8 |     4.3 |
| `GET /v1/workspaces/{id}/search`       |    800 |  51.3 |                     56.1 |    15.5 |
| `POST` task                            |    150 |  39.1 |                     39.4 |     3.2 |
| `PATCH` task                           |    150 |  42.0 |                     46.6 |     3.3 |
| `POST` comment                         |    150 |  35.2 |                     40.0 |     3.2 |
| `GET /v1/projects/1/summary`           |    300 |  33.1 |                     35.8 |     4.5 |

2,000 samples per row in both runs (2,000 to 2,002). Maximum single latencies were 125 to 270 ms (garbage
collection and the burst at the start of each window). Run A saw 316 `429` responses and run B 6 (client-side
budgeting is approximate); none are in the samples. No 5xx.

All latency targets are met with a wide margin. Worst-case shapes tried by hand on the seeded database (2-character
search `q=ab`: 74 ms; `overdue=true&sort=due_date` on the workspace list: 9 ms; `include_deleted=true`: 6 ms;
activity feed: 6 ms) are also far below target.

## Memory (resident set, `ps -o rss`)

| Process       | Limit   | Under load (max sampled every 2 s) | After load |
| ------------- | ------- | ---------------------------------: | ---------: |
| `./bin/api`   | 512 MiB |                        371 MiB max |    276 MiB |
| `./bin/worker`| 512 MiB |                        187 MiB max |    157 MiB |

`./bin/api` is a single Node process (the script `exec`s `murmur start api`), so this is the whole tree.

One thing to know: right after `POST /__test/seed` the API process holds up to about 780 MiB resident (one-off, drops back below 300 MiB afterwards) (the seed builds
the 100,000 tasks, 300,000 comments and their activity in memory and sends them in 1,000-row chunks). That is
above 512 MiB for a short time, but it is the one-off seeding call, not the request load of 14.2; the resident set
fell back below 300 MiB before the measurements started and was 184 MiB after a restart with the same database.
Not changed.

## Shutdown and startup (clean clone)

`SIGTERM` to both processes (children of one shell, exit codes collected with `wait`): api exit 0 in 69 ms, worker
exit 0 in 27 ms (also after the smoke run and the seed). `SIGINT` to the API: exit 0 in 17 ms.

## What was changed

Nothing in the pieces: every target was met on the first full measurement, so no index or query-shape change was
made and no `schema.sql` was touched. The only code added is `scripts/smoke.sh`, `scripts/smoke.mjs`,
`scripts/webhook-receiver.mjs`, `scripts/perf.mjs` and the README. During the development of the load generator
the first versions produced a spurious p99 of 700 to 1,000 ms for the summary: all 50 clients sat waiting for the
one rate-limited workspace and fired together when its window reopened, and the server's own access log showed 3
to 41 ms for those requests. That was a generator artefact and was fixed in the generator (even release of the
per-minute budget, proportional operation choice), not in the server.

## Not met / caveats

- The README sentence that `./bin/test` runs `e2e/` tests is now true (the branch includes the merge of issue 019).
- No latency or memory target was missed.
- The throughput the API can reach is not what these numbers show; they are bounded by the rate limits that the
  specification itself imposes on ten keys (see Method).
- The first `scripts/smoke.sh` run after a fresh start once failed in scenario 11 (the receiver saw no request
  because the drain returned before the delivery's first attempt); more than a dozen further runs, including 8 against freshly
  restarted processes, passed. Not reproduced, so not fixed; if it happens again look at
  `pieces/testing` `DrainJobs` against `pieces/webhooks/jobs-view.ts` `due_pending`.
