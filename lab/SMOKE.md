# Taskwell — Smoke scenarios

Thirteen happy-path walkthroughs you can run by hand or script against a fresh instance to check that the basics are wired up. Start the API and one worker, both with `TASKWELL_TEST_MODE=true`, and call `POST /__test/reset` first. These walkthroughs do not replace the specification.

Throughout, `$ANA`, `$BO` and `$CY` stand for the API-key secrets of three users.

## 1. Register and read yourself

Call `POST /v1/users` with `{"email":"ana@example.com","name":"Ana","timezone":"Europe/Athens"}`. Expect `201`, a `user` object and an `api_key.secret` starting with `twl_`. Call `GET /v1/users/me` with that key. Expect `200` and the same user, with `digest_enabled: true`. Register Bo (`America/New_York`) and Cy (`Asia/Tokyo`) the same way.

## 2. Create a workspace and invite people

As Ana, `POST /v1/workspaces` with `{"name":"Acme Ops"}`. Expect `201`, `slug: "acme-ops"`, `owner_id` equal to Ana's id, `my_role: "owner"`, `version: 1`. Add Bo with `POST /v1/workspaces/{id}/members` `{"email":"bo@example.com","role":"member"}` (expect `201`) and Cy as `viewer`. `GET /v1/workspaces/{id}/members` should list three entries ordered by join time. `GET /v1/workspaces` as Bo should show the workspace with `my_role: "member"`.

## 3. Welcome email

After scenario 2, call `POST /__test/jobs/drain`, then `GET /__test/emails?template=member_added`. Expect two records, one addressed to Bo and one to Cy, each with `data.workspace_name` equal to `"Acme Ops"`.

## 4. Project and task

As Bo, `POST /v1/workspaces/{id}/projects` `{"name":"Website"}`. Expect `201`, `slug: "website"`. Then `POST /v1/projects/{id}/tasks` with a title, `labels: ["bug"]`, `due_date` a week from now, `estimate_minutes: 90` and `budget: {"currency":"USD","amount":"120.5"}`. Expect `201`, `status: "open"`, `overdue: false`, `budget.amount` returned as `"120.50"` and `budget.amount_minor` as `"12050"`. `GET /v1/tasks/{id}` returns the same task and an `ETag: "1"` header.

## 5. Viewer is read-only

As Cy, `GET /v1/tasks/{id}` returns `200`. As Cy, `PATCH /v1/tasks/{id}` with `{"title":"x"}` returns `403` with `error.code: "forbidden"`. As Cy, `POST /v1/tasks/{id}/comments` also returns `403`.

## 6. Claim, update and the activity feed

As Ana, `POST /v1/tasks/{id}/claim`. Expect `200` with `assignee_id` equal to Ana's id and `version: 2`. Then `PATCH /v1/tasks/{id}` with header `If-Match: "2"` and body `{"status":"in_progress"}`. Expect `200`, `version: 3`. `GET /v1/workspaces/{id}/activity` should list, newest first, a `task.updated` event with `changes.status` from `open` to `in_progress`, a `task.updated` event for the assignment, then `task.created`, `project.created`, the two `member.added` events and `workspace.created`.

## 7. Comment and notification

As Bo, `POST /v1/tasks/{id}/comments` `{"body":"Reproduced on staging."}`. Expect `201` with `author.name: "Bo"`, `edited: false`. Drain jobs. `GET /__test/emails?template=comment_added` should contain one record addressed to Ana (the assignee; Bo is both creator and commenter and is not emailed).

## 8. Idempotent create

As Bo, send `POST /v1/projects/{id}/tasks` twice with the same `Idempotency-Key: smoke-8` header and the same body `{"title":"Idempotent task"}`. Expect the first response `201`, the second `201` with identical body and the header `Idempotent-Replayed: true`. The project's task list should contain exactly one task with that title.

## 9. Paginated listing

Create 25 tasks in the project. `GET /v1/projects/{id}/tasks?limit=10` returns 10 tasks ordered newest first and a non-null `next_cursor`. Follow `cursor` twice more: 10 tasks, then the remaining 7 (the project also holds the two tasks from scenarios 4 and 8) and `next_cursor: null`. No task id appears twice across the pages.

## 10. Soft delete and restore

As Ana, `DELETE /v1/tasks/{id}`. Expect `204`. `GET /v1/tasks/{id}` as Bo now returns `410` with `error.code: "gone"`, and the task is absent from the project's task list. `POST /v1/tasks/{id}/restore` as Ana returns `200` with `deleted_at: null`, and the task is listed again.

## 11. Webhook delivery

Run a small HTTP receiver that answers `200` and records requests. As Ana, `POST /v1/workspaces/{id}/webhooks` with its URL and `events: ["task.created"]`. Expect `201` with a `secret`. Create a task. Drain jobs. The receiver should have received exactly one `POST` with headers `X-Taskwell-Event: task.created`, `X-Taskwell-Delivery-Id`, `X-Taskwell-Timestamp` and `X-Taskwell-Signature`; recompute HMAC-SHA256 over `<timestamp>.<body>` with the secret and confirm it matches the `v1=` value. `GET /v1/webhooks/{id}/deliveries` lists the delivery with `status: "succeeded"` and one attempt with `outcome: "success"`.

## 12. Search

Create a task titled `Login redirect loop` with description `Happens after SSO` and a comment `Also on mobile`. `GET /v1/workspaces/{id}/search?q=login` returns that task with `match: "title_prefix"`; `q=redirect` returns it with `match: "title"`; `q=sso` returns it with `match: "description"`; `q=mobile` with `match: "comment"`; `q=zzzz` returns an empty `data` array.

## 13. Daily digest with the test clock

Set `PUT /__test/clock` to `{"now":"2027-06-10T04:30:00Z"}` (that is 07:30 in Athens, 00:30 in New York, 13:30 in Tokyo). Call `POST /__test/scheduler/tick`, drain, and check `GET /__test/emails?template=daily_digest`: there is one digest, for Cy (whose 08:00 has already passed today). Advance the clock by 3,600 seconds, tick, drain: a digest for Ana appears with `data.date: "2027-06-10"` and `data.timezone: "Europe/Athens"`. Advance another 36,000 seconds (now 15:30 UTC, 11:30 in New York), tick, drain: Bo's digest appears. Tick once more without advancing: no new digest records are added. Finally `DELETE /__test/clock`.
