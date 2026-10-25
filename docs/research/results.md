# Results: three Taskwell pilots

Same spec, same kickoff, same Sonnet team under a Fable orchestrator, one run per arm, 2026-10-25. Raw files per run
are in `lab/results/`. Pilots are uncounted calibration runs; no counted block was started.

## Team and process

| Metric                               |       NestJS | murmur 0.2.1 (pilot 1) | murmur 0.3.0 (pilot 2) |
| ------------------------------------ | -----------: | ---------------------: | ---------------------: |
| Kickoff to DONE.md                   | 2 h 44 min ¹ |             1 h 47 min |             1 h 55 min |
| Agents spawned                       |           31 |                     84 |                     50 |
| Commits / merges                     |      93 / 17 |               105 / 32 |                74 / 21 |
| Conflicted merges (resolution lines) |      7 (100) |                  1 (9) |                 2 (11) |
| Orchestrator-reported cost           |        $41.4 |                  $72.2 |                  $63.8 |
| Framework issues filed by the team   |            0 |                      9 |                      3 |
| Own test cases (`./bin/test`)        |          531 |                    612 |                    567 |

¹ includes a nine-minute harness interruption and a resumed session (finding P1 in `lab/experiment/EXPERIMENT.md`);
two sessions' costs summed.

## Code shape

| Metric                                  |      NestJS |  murmur 0.2.1 |      murmur 0.3.0 |
| --------------------------------------- | ----------: | ------------: | ----------------: |
| Source LOC / files                      | 8,930 / 209 |  11,971 / 161 |      11,699 / 168 |
| Test LOC                                |       7,357 |        11,698 |            10,902 |
| Units (Nest modules / pieces)           |          25 |            23 |                21 |
| HTTP edge LOC / routes                  |    691 / 62 |    3,574 / 61 |          998 / 62 |
| Edge LOC per route                      |        11.1 |          58.6 |              16.1 |
| App-local capabilities / helper kit LOC |         n/a | 1,720 + 2,068 | 65 (+ 755 `lib/`) |
| Distinct lines shared by ≥ 3 units      |         n/a |            83 |                92 |
| Locked packages                         |         513 |           139 |               139 |

Pilot 2 used the 0.3.0 surface broadly: `req.read` in 7 files, `req.reply` in 13, `rejectable` 52 times,
`jobs.enqueue` 6, `every` schedules 6, two `idempotent` routes, 137 `#lib` imports, processes `api` + `worker`. It
still built its own idempotency store and job ledgers next to the framework ones.

## Hidden suite

692 black-box tests: 13 happy-path walkthroughs, 217 trap tests, 462 error-contract checks.

| Result                | NestJS | murmur 0.2.1 | murmur 0.3.0, strict | murmur 0.3.0, team reading |
| --------------------- | -----: | -----------: | -------------------: | -------------------------: |
| Total passed / 692    |    686 |          687 |                  672 |                        684 |
| Happy path / 13       |     13 |           13 |                   13 |                         13 |
| Traps / 217           |    212 |          213 |                  200 |                        212 |
| Error contract / 462  |    461 |          461 |                  459 |                        459 |
| Acceptance smoke / 13 |     13 |           13 |                   13 |                         13 |

**Two readings of pilot 2.** SPEC §13.4 says the drain endpoint blocks until no _due_ job is pending and shows
`"pending": 0` in its example. The 0.3.0 team reports `pending` as every pending job, retries not yet due included.
The suite reads it as due jobs only, as NestJS and pilot 1 did. Twelve tests turn on that count alone. With the
team's reading accepted (`SUITE_DRAIN_PENDING=any`, an adjudication switch, never the default) they pass.

Misses by arm, with the team reading for pilot 2:

| Trap                                                         | NestJS  | murmur 0.2.1 | murmur 0.3.0 |
| ------------------------------------------------------------ | ------- | ------------ | ------------ |
| G4 failing webhook endpoint isolated from healthy deliveries | fail    | fail         | fail         |
| I1 slug length reported with the wrong error code            | partial | partial      | partial      |
| L3 idempotency-key scope across projects / endpoint types    | fail    | partial      | fail         |
| F2 per-endpoint delivery ordering                            | partial | pass         | pass         |
| D5 twenty concurrent ownership transfers                     | pass    | partial      | pass         |
| I5 status precedence (404 before malformed body)             | pass    | pass         | partial      |
| Error-contract length codes (slug / url / secret)            | 1 miss  | 1 miss       | 3 misses     |

G4, I1 and L3 miss in all three arms with the same team model: spec or suite ambiguity rather than a framework effect.
I5 in pilot 2 is a framework DX effect: the edge reads path params and body in one `req.read` call, so a malformed
body answers 400 before the 404 lookup.

## Performance in the container

Docker `node:26-bookworm-slim`, 2 CPUs, 1 GiB, API and worker in one container, reference dataset seeded, 120 s
warmup, then 3 × 60 s per class at the planned rate with 50 connections. Targets are the SPEC §14.2 p99 limits.

| Class (planned rps, p99 target)    | Candidate    | rps | p50 ms | p95 ms | p99 ms | max ms | errors | met |
| ---------------------------------- | ------------ | --: | -----: | -----: | -----: | -----: | -----: | --- |
| Single GET (500, 50)               | NestJS       | 500 |    0.4 |    1.5 |    1.9 |   18.7 |      0 | yes |
|                                    | murmur 0.2.1 | 500 |    1.3 |    3.0 |    4.2 |   24.1 |      0 | yes |
|                                    | murmur 0.3.0 | 500 |    1.5 |    4.3 |   17.4 |   58.4 |      0 | yes |
| List, limit 50, filters (500, 300) | NestJS       | 500 |    1.1 |    9.5 |   15.0 |   41.8 |      0 | yes |
|                                    | murmur 0.2.1 | 500 |   12.3 |   39.5 |   55.0 |  194.8 |      0 | yes |
|                                    | murmur 0.3.0 | 357 | 12,056 | 22,792 | 23,711 | 24,356 |      0 | no  |
| Workspace search (100, 800)        | NestJS       | 100 |    9.6 |   47.7 |   95.5 |  196.9 |      0 | yes |
|                                    | murmur 0.2.1 | 100 |    4.7 |    7.1 |    8.2 |   46.7 |      0 | yes |
|                                    | murmur 0.3.0 |  67 | 14,491 | 27,991 | 29,519 | 30,113 | 0.32 % | no  |
| Writes (200, 150)                  | NestJS       | 200 |    1.0 |    6.6 |   12.8 |   41.6 |      0 | yes |
|                                    | murmur 0.2.1 | 200 |    2.0 |   15.1 |   25.5 |   47.8 |      0 | yes |
|                                    | murmur 0.3.0 | 200 |    3.0 |   17.0 |   24.0 |   52.7 |      0 | yes |
| Project summary (100, 300)         | NestJS       | 100 |    2.8 |    3.6 |    4.0 |   13.3 |      0 | yes |
|                                    | murmur 0.2.1 | 100 |    6.7 |    7.9 |    9.8 |   15.4 |      0 | yes |
|                                    | murmur 0.3.0 | 100 |    3.9 |    5.0 |    8.1 |   23.9 |      0 | yes |

| Resource                          |  NestJS | murmur 0.2.1 | murmur 0.3.0 |
| --------------------------------- | ------: | -----------: | -----------: |
| CPU, whole run (share of 2 cores) |    23 % |         37 % |         45 % |
| CPU during warmup                 |    42 % |         56 % |         53 % |
| API RSS max                       | 146 MiB |      218 MiB |      383 MiB |
| Worker RSS max                    | 103 MiB |      164 MiB |      162 MiB |
| Container anonymous memory peak   | 126 MiB |      219 MiB |      377 MiB |
| Seed + discovery                  |  38.7 s |       13.2 s |       33.4 s |
| Warmup throughput reached         | 623 rps |      827 rps |      506 rps |

All three runs are valid: API and worker alive throughout, no server errors. The NestJS worker logged seven
"database is locked" warnings during seeding and recovered.

## Why pilot 2 collapsed

Measured on the host, unloaded, paced at 15 rps across the ten seeded keys (no container):

| Request                      | NestJS p50 | murmur 0.2.1 p50 | murmur 0.3.0 p50 |
| ---------------------------- | ---------: | ---------------: | ---------------: |
| Workspace GET                |     1.2 ms |           2.9 ms |           2.7 ms |
| Workspace task list          |     1.7 ms |           3.5 ms |           3.3 ms |
| Project task list            |     1.7 ms |           3.9 ms |           3.3 ms |
| Activity feed                |     1.5 ms |           3.4 ms |           3.2 ms |
| Comments                     |     1.3 ms |           3.0 ms |           2.6 ms |
| Search                       |     6.5 ms |           8.3 ms |          14.0 ms |
| Server CPU per list request  |   ≈ 1.0 ms |         ≈ 3.5 ms |         ≈ 3.5 ms |
| Idle CPU (share of one core) |          0 |          ≈ 4.4 % |          ≈ 4.4 % |

Per-request cost is the same for both murmur pilots, so the collapse is contention: pilot 2's auth guard runs a
SQLite transaction on every request (expire old windows, read four bucket counters, increment four). With fifty
connections plus the worker's own writes, every read request queues on SQLite's single writer. Pilot 1 kept the
counters in memory. The 0.3.0 design offered `kv.incr` as the counter primitive, which pointed the team at durable
counters.

In both murmur CPU profiles roughly half of busy time sits inside synchronous SQLite calls; envelope serialisation,
contract-name matching and zod parsing add 10–15 %. Both murmur APIs also run a background tick worth about 4 % of a
core while idle.

Pilot 2 measured its own performance at about 80 requests per second because it treated the per-key rate limits as
a ceiling, so the team never saw this.
