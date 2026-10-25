import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { advance, setClock } from '../lib/clock.ts';
import { Client, etagVersion, idempotencyKey, nextIp, quoted, type ApiResponse } from '../lib/client.ts';
import { activity, createComment, createTask, createWebhook, getOk, team, uniqueEmail, type Team } from '../lib/fixtures.ts';
import { ok, startReceiver } from '../lib/receiver.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drainAll, emails } from '../lib/testmode.ts';

freshDatabaseEachTest();

function statuses(results: ApiResponse[]): string {
  return results.map((r) => r.status).join(',');
}

async function claimRace(t: Team, taskId: number): Promise<number> {
  const results = await Promise.all(t.members.map((m) => m.client.post(`/v1/tasks/${taskId}/claim`)));
  const winners = results.filter((r) => r.status === 200);
  assert.equal(winners.length, 1, `exactly one claim may succeed, got statuses ${statuses(results)}`);
  const winnerId = winners[0].body.assignee_id;
  assert.ok(t.members.some((m) => m.id === winnerId), 'winner must be one of the claimers');
  assert.equal(winners[0].body.version, 2);
  for (const r of results.filter((x) => x.status !== 200)) {
    expectError(r, 409, 'already_assigned', { path: 'assignee_id', code: 'already_assigned', assignee_id: winnerId }, { exactDetails: true });
  }
  const got = await getOk(t.owner, `/v1/tasks/${taskId}`);
  assert.equal(got.assignee_id, winnerId);
  assert.equal(got.version, 2);

  return winnerId;
}

async function taskUpdates(t: Team, taskId: number) {
  const events = await activity(t.owner, t.ws.id);

  return events.filter((e) => e.type === 'task.updated' && e.target?.type === 'task' && e.target.id === taskId);
}

test('[A1] claim is atomic under 20 concurrent requests', async () => {
  const t = await team({ admins: 0, members: 20, viewers: 0 });
  const task = await createTask(t.owner, t.project.id);
  const winnerId = await claimRace(t, task.id);
  const updates = await taskUpdates(t, task.id);
  assert.equal(updates.length, 1, `exactly one task.updated event, got ${updates.length}`);
  assert.deepEqual(updates[0].changes, { assignee_id: { from: null, to: winnerId } });
  assert.equal(updates[0].actor.id, winnerId);
  await drainAll();
  assert.deepEqual(await emails({ template: 'task_assigned' }), [], 'claims send no email');
});

test('[A1] claim stays atomic over 10 consecutive races of 20 claimers', async () => {
  const t = await team({ admins: 0, members: 20, viewers: 0 });
  for (let round = 0; round < 10; round += 1) {
    const task = await createTask(t.owner, t.project.id, { title: `Race ${round}` });
    await claimRace(t, task.id);
    assert.equal((await taskUpdates(t, task.id)).length, 1, `round ${round}: one task.updated`);
  }
  await drainAll();
  assert.deepEqual(await emails({ template: 'task_assigned' }), [], 'claims send no email');
});

test('[A1] claim by the current assignee is 409 already_assigned', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id);
  expectStatus(await t.member.client.post(`/v1/tasks/${task.id}/claim`), 200);
  const again = await t.member.client.post(`/v1/tasks/${task.id}/claim`);
  expectError(again, 409, 'already_assigned', { path: 'assignee_id', code: 'already_assigned', assignee_id: t.member.id });
  assert.equal((await getOk(t.owner, `/v1/tasks/${task.id}`)).version, 2, 'a failed claim changes nothing');
});

async function patchRace(t: Team, n: number): Promise<void> {
  const task = await createTask(t.owner, t.project.id, { title: 'Original' });
  const writers = t.members.slice(0, n);
  const results = await Promise.all(
    writers.map((m, i) => m.client.patch(`/v1/tasks/${task.id}`, { title: `Title by ${i}` }, { ifMatch: '"1"' })),
  );
  const winners = results.filter((r) => r.status === 200);
  assert.equal(winners.length, 1, `exactly one conditional PATCH may win, got ${statuses(results)}`);
  assert.equal(winners[0].body.version, 2);
  for (const r of results.filter((x) => x.status !== 200)) {
    expectError(r, 409, 'version_conflict', { path: 'version', code: 'stale', current_version: 2 }, { exactDetails: true });
  }
  const got = await t.owner.client.get(`/v1/tasks/${task.id}`);
  assert.equal(got.body.version, 2);
  assert.equal(got.body.title, winners[0].body.title);
  assert.equal(etagVersion(got), 2);
}

test('[A2] two concurrent PATCH with the same If-Match: one wins, one 409 version_conflict', async () => {
  const t = await team({ admins: 0, members: 2, viewers: 0 });
  await patchRace(t, 2);
});

test('[A2] 20 concurrent PATCH with the same If-Match: exactly one wins', async () => {
  const t = await team({ admins: 0, members: 20, viewers: 0 });
  await patchRace(t, 20);
});

test('[A2] stale If-Match on PATCH and DELETE changes nothing', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id, { title: 'Keep me' });
  expectStatus(await t.owner.client.patch(`/v1/tasks/${task.id}`, { status: 'in_progress' }), 200);
  const stalePatch = await t.owner.client.patch(`/v1/tasks/${task.id}`, { title: 'Changed' }, { ifMatch: '"1"' });
  expectError(stalePatch, 409, 'version_conflict', { path: 'version', code: 'stale', current_version: 2 });
  const staleDelete = await t.owner.client.delete(`/v1/tasks/${task.id}`, { ifMatch: '"1"' });
  expectError(staleDelete, 409, 'version_conflict', { path: 'version', code: 'stale', current_version: 2 });
  const got = await getOk(t.owner, `/v1/tasks/${task.id}`);
  assert.equal(got.title, 'Keep me');
  assert.equal(got.version, 2);
  assert.equal(got.deleted_at, null);
  expectStatus(await t.owner.client.delete(`/v1/tasks/${task.id}`, { ifMatch: '"2"' }), 204);
});

test('[A2] version increases by exactly one on claim, delete, restore, empty PATCH and status change', async () => {
  const t = await team();
  const created = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'Versioned' });
  expectStatus(created, 201);
  assert.equal(created.body.version, 1);
  assert.equal(etagVersion(created), 1);
  const id = created.body.id;

  const claim = await t.member.client.post(`/v1/tasks/${id}/claim`);
  expectStatus(claim, 200);
  assert.equal(claim.body.version, 2);
  assert.equal(etagVersion(claim), 2);

  expectStatus(await t.owner.client.delete(`/v1/tasks/${id}`, { ifMatch: '"2"' }), 204);
  const restore = await t.owner.client.post(`/v1/tasks/${id}/restore`);
  expectStatus(restore, 200);
  assert.equal(restore.body.version, 4, 'delete and restore each add one');
  assert.equal(etagVersion(restore), 4);

  const empty = await t.owner.client.patch(`/v1/tasks/${id}`, {}, { ifMatch: '"4"' });
  expectStatus(empty, 200);
  assert.equal(empty.body.version, 5);
  assert.equal(etagVersion(empty), 5);

  const status = await t.owner.client.patch(`/v1/tasks/${id}`, { status: 'done' }, { ifMatch: '"5"' });
  expectStatus(status, 200);
  assert.equal(status.body.version, 6);
  assert.equal(etagVersion(status), 6);
  const got = await t.owner.client.get(`/v1/tasks/${id}`);
  assert.equal(got.body.version, 6);
  assert.equal(etagVersion(got), 6);
});

// SPEC 3.11 #5: soft deletion is a change, so delete and restore each add exactly one.
test('[A2] soft delete and restore bump the version of workspaces, projects and comments', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id);
  const comment = (await t.owner.client.post(`/v1/tasks/${task.id}/comments`, { body: 'v1' })).body;
  const cases: [string, number][] = [
    [`/v1/comments/${comment.id}`, comment.version],
    [`/v1/projects/${t.project.id}`, t.project.version],
    [`/v1/workspaces/${t.ws.id}`, t.ws.version],
  ];
  for (const [path, version] of cases) {
    expectStatus(await t.owner.client.delete(path, { ifMatch: quoted(version) }), 204, `DELETE ${path}`);
    const restored = await t.owner.client.post(`${path}/restore`);
    expectStatus(restored, 200, `restore ${path}`);
    assert.equal(restored.body.version, version + 2, `${path}: delete and restore each add one`);
    assert.equal(etagVersion(restored), version + 2);
  }
});

// SPEC 6.6: If-Match is read only by PATCH/DELETE of versioned objects; restore ignores any value.
test('[A2] a malformed If-Match on restore is ignored', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id);
  expectStatus(await t.owner.client.delete(`/v1/tasks/${task.id}`), 204);
  const res = await t.owner.client.post(`/v1/tasks/${task.id}/restore`, undefined, { ifMatch: 'garbage, W/"9"' });
  expectStatus(res, 200);
  assert.equal(res.body.deleted_at, null);
});

test('[A2] workspace, project and comment PATCH honour If-Match', async () => {
  const t = await team();
  const targets = [
    { path: `/v1/workspaces/${t.ws.id}`, body: { name: 'Renamed Ops' }, actor: t.owner },
    { path: `/v1/projects/${t.project.id}`, body: { name: 'Renamed project' }, actor: t.owner },
  ];
  const task = await createTask(t.member, t.project.id);
  const comment = await createComment(t.member, task.id, 'first');
  targets.push({ path: `/v1/comments/${comment.id}`, body: { body: 'edited' } as any, actor: t.member });

  for (const target of targets) {
    const before = await target.actor.client.get(target.path);
    expectStatus(before, 200);
    const v = etagVersion(before);
    assert.equal(v, before.body.version, `${target.path}: ETag must equal version`);
    const stale = await target.actor.client.patch(target.path, target.body, { ifMatch: `"${v! + 1}"` });
    expectError(stale, 409, 'version_conflict', { path: 'version', code: 'stale', current_version: v });
    const fresh = await target.actor.client.patch(target.path, target.body, { ifMatch: `"${v}"` });
    expectStatus(fresh, 200);
    assert.equal(fresh.body.version, v! + 1, `${target.path}: version +1`);
    assert.equal(etagVersion(fresh), v! + 1);
  }
});

test('[A2] unquoted If-Match is 400 invalid_header', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id);
  const res = await t.owner.client.patch(`/v1/tasks/${task.id}`, { title: 'x' }, { ifMatch: '1' });
  expectError(res, 400, 'invalid_header');
  assert.equal((await getOk(t.owner, `/v1/tasks/${task.id}`)).version, 1);
});

test('[A3] replay returns the stored response and produces no new activity, email or delivery', async (tt) => {
  const t = await team();
  const receiver = await startReceiver(ok());
  tt.after(() => receiver.close());
  const hook = await createWebhook(t.owner, t.ws.id, { url: receiver.url, events: ['task.created'] });
  const key = idempotencyKey('a3');
  const body = { title: 'Replay me', assignee_id: t.member.id };
  const first = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, body, { idempotencyKey: key });
  expectStatus(first, 201);
  const eventsBefore = (await activity(t.owner, t.ws.id)).length;

  const replay = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, body, { idempotencyKey: key });
  expectStatus(replay, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(replay.text, first.text, 'replayed body must be byte-identical');
  assert.equal(replay.headers.get('etag'), first.headers.get('etag'));
  assert.equal((await activity(t.owner, t.ws.id)).length, eventsBefore, 'replay adds no activity');

  await drainAll();
  const assigned = await emails({ template: 'task_assigned', to: t.member.email });
  assert.equal(assigned.length, 1, 'exactly one task_assigned email');
  assert.equal(receiver.requests.length, 1, 'exactly one webhook request');
  const deliveries = await getOk(t.owner, `/v1/webhooks/${hook.id}/deliveries`);
  assert.equal(deliveries.data.length, 1, 'exactly one delivery');
  const list = await t.owner.client.pageAll(`/v1/projects/${t.project.id}/tasks`, { limit: 100 });
  assert.equal(list.items.filter((x) => x.title === 'Replay me').length, 1);
});

test('[A3] idempotency keys are scoped to the authenticated user', async () => {
  const t = await team();
  const key = idempotencyKey('scope');
  const body = { title: 'Scoped' };
  const mine = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, body, { idempotencyKey: key });
  expectStatus(mine, 201);
  const theirs = await t.admin.client.post(`/v1/projects/${t.project.id}/tasks`, body, { idempotencyKey: key });
  expectStatus(theirs, 201);
  assert.notEqual(theirs.headers.get('idempotent-replayed'), 'true');
  assert.notEqual(theirs.body.id, mine.body.id);
  assert.equal(theirs.body.creator_id, t.admin.id);
});

test('[A3] POST /v1/users keys are scoped to the client IP', async () => {
  const ip = nextIp();
  const key = idempotencyKey('register');
  const body = { email: uniqueEmail('replay'), name: 'Replay' };
  const anon = new Client(null, ip);
  const first = await anon.post('/v1/users', body, { idempotencyKey: key });
  expectStatus(first, 201);
  const replay = await anon.post('/v1/users', body, { idempotencyKey: key });
  expectStatus(replay, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(replay.body, first.body);
  const otherIp = await new Client(null, nextIp()).post('/v1/users', body, { idempotencyKey: key });
  expectError(otherIp, 409, 'email_taken');
});

test('[A3] Idempotency-Key is ignored on claim', async () => {
  const t = await team({ admins: 0, members: 1, viewers: 0 });
  const task = await createTask(t.owner, t.project.id);
  const key = idempotencyKey('claim');
  expectStatus(await t.member.client.post(`/v1/tasks/${task.id}/claim`, undefined, { idempotencyKey: key }), 200);
  const second = await t.member.client.post(`/v1/tasks/${task.id}/claim`, undefined, { idempotencyKey: key });
  expectError(second, 409, 'already_assigned');
  assert.notEqual(second.headers.get('idempotent-replayed'), 'true');
});

test('[A3] keys expire after 24 hours on the application clock', async () => {
  const t = await team();
  await setClock('2026-04-01T10:00:00Z');
  const key = idempotencyKey('expiry');
  const first = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'Expiring' }, { idempotencyKey: key });
  expectStatus(first, 201);
  await advance(86_401);
  const later = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'Expiring' }, { idempotencyKey: key });
  expectStatus(later, 201);
  assert.notEqual(later.headers.get('idempotent-replayed'), 'true');
  assert.notEqual(later.body.id, first.body.id);
});

test('[A4] same key with a different body is 422 idempotency_key_reused', async () => {
  const t = await team();
  const key = idempotencyKey('a4');
  expectStatus(await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'Original' }, { idempotencyKey: key }), 201);
  const res = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'Different' }, { idempotencyKey: key });
  expectError(res, 422, 'idempotency_key_reused');
  const list = await t.owner.client.pageAll(`/v1/projects/${t.project.id}/tasks`, { limit: 100 });
  assert.equal(list.items.filter((x) => x.title === 'Original').length, 1);
  assert.equal(list.items.filter((x) => x.title === 'Different').length, 0);
});

test('[A5] a failed first request does not consume the key', async () => {
  const t = await team();
  const key = idempotencyKey('a5');
  const bad = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { description: 'no title' }, { idempotencyKey: key });
  expectValidation(bad, 'title', 'required');
  const good = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'Now valid' }, { idempotencyKey: key });
  expectStatus(good, 201);
  assert.notEqual(good.headers.get('idempotent-replayed'), 'true');
  assert.equal(good.body.title, 'Now valid');
});

test('[A5] 20 concurrent identical creates with one key create exactly one task', async () => {
  const t = await team();
  const key = idempotencyKey('inflight');
  const body = { title: 'Concurrent idempotent' };
  const results = await Promise.all(
    Array.from({ length: 20 }, () => t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, body, { idempotencyKey: key })),
  );
  const created = results.filter((r) => r.status === 201);
  assert.ok(created.length >= 1, `at least one create must succeed, got ${statuses(results)}`);
  for (const r of results.filter((x) => x.status !== 201)) expectError(r, 409, 'idempotency_in_progress');
  assert.equal(new Set(created.map((r) => r.body.id)).size, 1, 'all 201 responses must carry the same task');
  const list = await t.owner.client.pageAll(`/v1/projects/${t.project.id}/tasks`, { limit: 100 });
  assert.equal(list.items.filter((x) => x.title === body.title).length, 1);
  const replay = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, body, { idempotencyKey: key });
  expectStatus(replay, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(replay.body.id, created[0].body.id);
});

test('[A5] an Idempotency-Key longer than 255 characters is 400 invalid_header', async () => {
  const t = await team();
  const res = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'Long key' }, { idempotencyKey: 'k'.repeat(256) });
  expectError(res, 400, 'invalid_header');
  const ok255 = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'Max key' }, { idempotencyKey: 'k'.repeat(255) });
  expectStatus(ok255, 201);
});

// SPEC 6.5: the header is not read on claim, so even a malformed value is accepted.
test('[A5] a malformed Idempotency-Key on claim is ignored', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id);
  const res = await t.member.client.post(`/v1/tasks/${task.id}/claim`, undefined, { idempotencyKey: 'k'.repeat(300) });
  expectStatus(res, 200);
  assert.equal(res.body.assignee_id, t.member.id);
});

test('[A6] fingerprint compares parsed JSON: reordered keys and whitespace replay', async () => {
  const t = await team();
  const key = idempotencyKey('a6');
  const path = `/v1/projects/${t.project.id}/tasks`;
  const first = await t.owner.client.post(path, { title: 'Order', description: 'x', labels: ['a', 'b'] }, { idempotencyKey: key });
  expectStatus(first, 201);
  const raw = '{ "labels" : [ "a",  "b" ],\n  "description":"x" ,\t"title":   "Order" }\n';
  const replay = await t.owner.client.request('POST', path, { rawBody: raw, contentType: 'application/json', idempotencyKey: key });
  expectStatus(replay, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(replay.body, first.body);
});
