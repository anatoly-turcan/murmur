import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertUnique, describe, expectError, expectStatus } from '../lib/assert.ts';
import { localDate, setClock } from '../lib/clock.ts';
import { idempotencyKey, type Json } from '../lib/client.ts';
import { obsoleteIn } from '../lib/cr.ts';
import { createProject, createTask, createWorkspace, deleteOk, getOk, patchOk, postOk, registerUser, type User } from '../lib/fixtures.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { emails, tickAndDrain } from '../lib/testmode.ts';

freshDatabaseEachTest();

async function digests(user: User): Promise<Json[]> {
  return emails({ template: 'daily_digest', to: user.email });
}

function assertConsistent(sent: Json[], user: User, zones: string[]): void {
  assertUnique(sent.map((e) => e.data.date), 'digest dates');
  assertUnique(sent.map((e) => e.dedupe_key), 'digest dedupe keys');
  for (const e of sent) {
    assert.ok(zones.includes(e.data.timezone), `digest timezone ${e.data.timezone} not in ${zones.join(', ')}`);
    assert.equal(e.dedupe_key, `daily_digest:${user.id}:${e.data.date}`);
    assert.equal(e.data.date, localDate(e.sent_at, e.data.timezone), `digest date must be the local date of sent_at in ${e.data.timezone}`);
  }
}

async function tickAt(at: string): Promise<void> {
  await setClock(at);
  await tickAndDrain();
}

// TRAPS L1 / SPEC 10.2: either zone rule is fine as long as no date is digested twice and digests keep coming.
test('[L1] Tokyo → Los Angeles mover never gets a second digest for the same date', async (t) => {
  await setClock('2026-05-08T23:00:00Z');
  const user = await registerUser({ name: 'Mika', timezone: 'Asia/Tokyo' });
  await tickAndDrain();
  let sent = await digests(user);
  assert.deepEqual(sent.map((e) => e.data.date), ['2026-05-09']);
  await patchOk(user, '/v1/users/me', { timezone: 'America/Los_Angeles' });

  await tickAt('2026-05-09T15:00:00Z');
  sent = await digests(user);
  assert.equal(sent.filter((e) => e.data.date === '2026-05-09').length, 1, 'a second 2026-05-09 digest is the failure mode');
  t.diagnostic(`L1 Tokyo→LA: ${sent.length - 1} new digest(s) at 08:00 PDT on 9 May`);

  await tickAt('2026-05-10T15:00:00Z');
  sent = await digests(user);
  assert.ok(sent.some((e) => e.data.date === '2026-05-10'), 'digests must resume for 2026-05-10');
  assertConsistent(sent, user, ['Asia/Tokyo', 'America/Los_Angeles']);
});

test('[L1] Los Angeles → Tokyo mover gets at most one digest per date and keeps receiving them', async (t) => {
  await setClock('2026-05-09T15:00:00Z');
  const user = await registerUser({ name: 'Lou', timezone: 'America/Los_Angeles' });
  await tickAndDrain();
  let sent = await digests(user);
  assert.deepEqual(sent.map((e) => e.data.date), ['2026-05-09']);
  await patchOk(user, '/v1/users/me', { timezone: 'Asia/Tokyo' });

  await tickAt('2026-05-09T23:00:00Z');
  sent = await digests(user);
  const early = sent.slice(1);
  assert.ok(early.every((e) => e.data.date === '2026-05-10'), `only a 2026-05-10 digest may appear: ${JSON.stringify(early.map((e) => e.data.date))}`);
  t.diagnostic(`L1 LA→Tokyo: ${early.length ? '2026-05-10 digest sent early (current-zone rule)' : 'no digest 7 h after the first (24 h-style rule)'}`);

  await tickAt('2026-05-10T23:00:00Z');
  sent = await digests(user);
  assert.ok(sent.some((e) => e.data.date === '2026-05-11'), 'a 2026-05-11 digest must exist');
  assertConsistent(sent, user, ['America/Los_Angeles', 'Asia/Tokyo']);
});

// TRAPS L2 / SPEC 7.5, 7.6
test('[L2] restoring a task while its project is deleted is refused or deferred, never leaked', async (t) => {
  const owner = await registerUser({ name: 'Ana' });
  const ws = await createWorkspace(owner);
  const project = await createProject(owner, ws.id);
  const task = await createTask(owner, project.id);
  await deleteOk(owner, `/v1/tasks/${task.id}`);
  await deleteOk(owner, `/v1/projects/${project.id}`);

  const res = await owner.client.post(`/v1/tasks/${task.id}/restore`);
  if (res.status === 409 || res.status === 410) {
    assert.equal(typeof res.body?.error?.code, 'string', `refusal must use the error format: ${describe(res)}`);
    if (res.status === 410) expectError(res, 410, 'gone');
    t.diagnostic(`L2: restore refused with ${res.status} ${res.body.error.code}`);
    expectError(await owner.client.get(`/v1/tasks/${task.id}`), 410, 'gone');
    await postOk(owner, `/v1/projects/${project.id}/restore`);
    expectError(await owner.client.get(`/v1/tasks/${task.id}`), 410, 'gone');
    const restored = await postOk(owner, `/v1/tasks/${task.id}/restore`);
    assert.equal(restored.deleted_at, null);
    expectStatus(await owner.client.get(`/v1/tasks/${task.id}`), 200);

    return;
  }
  expectStatus(res, [200, 202], 'restore must be refused (409/410) or accepted (2xx)');
  t.diagnostic('L2: restore accepted while project deleted; verify README documents deferred restore');
  expectError(await owner.client.get(`/v1/tasks/${task.id}`), 410, 'gone');
  await postOk(owner, `/v1/projects/${project.id}/restore`);
  const after = await owner.client.get(`/v1/tasks/${task.id}`);
  expectStatus(after, 200, 'an accepted restore must take effect once the project is restored');
  assert.equal(after.body.deleted_at, null);
});

// TRAPS L3 / SPEC 6.5
test('[L3] same Idempotency-Key and body on a different project is not replayed', async (t) => {
  const owner = await registerUser({ name: 'Ana' });
  const ws = await createWorkspace(owner);
  const p1 = await createProject(owner, ws.id);
  const p2 = await createProject(owner, ws.id);
  const key = idempotencyKey('l3');
  const first = await owner.client.post(`/v1/projects/${p1.id}/tasks`, { title: 'Sync' }, { idempotencyKey: key });
  expectStatus(first, 201);
  const second = await owner.client.post(`/v1/projects/${p2.id}/tasks`, { title: 'Sync' }, { idempotencyKey: key });
  assert.notEqual(second.headers.get('idempotent-replayed'), 'true', 'replaying a task of another project is the failure mode');
  if (second.status === 422) {
    expectError(second, 422, 'idempotency_key_reused');
    t.diagnostic('L3: path is part of the fingerprint (422 idempotency_key_reused)');
  } else {
    expectStatus(second, 201, 'expected 422 idempotency_key_reused or a fresh 201');
    assert.equal(second.body.project_id, p2.id);
    assert.notEqual(second.body.id, first.body.id);
    t.diagnostic('L3: key scoped per endpoint (fresh 201)');
  }
  const inP1 = (await owner.client.pageAll(`/v1/projects/${p1.id}/tasks`)).items.filter((x) => x.title === 'Sync');
  assert.equal(inP1.length, 1);
});

const SAME_BODY_IMPOSSIBLE = obsoleteIn('CR-1', 'POST /v1/workspaces now requires organization_id, which a project body cannot carry, so the two bodies always differ; the per-project [L3] test keeps the trap covered');

test('[L3] same Idempotency-Key and body on a different endpoint type is not replayed', { skip: SAME_BODY_IMPOSSIBLE }, async (t) => {
  const owner = await registerUser({ name: 'Ana' });
  const key = idempotencyKey('l3b');
  const ws = await owner.client.post('/v1/workspaces', { name: 'Sync' }, { idempotencyKey: key });
  expectStatus(ws, 201);
  const project = await owner.client.post(`/v1/workspaces/${ws.body.id}/projects`, { name: 'Sync' }, { idempotencyKey: key });
  assert.notEqual(project.headers.get('idempotent-replayed'), 'true', 'returning the workspace for a project create is the failure mode');
  assert.ok(!('my_role' in (project.body ?? {})) && !('owner_id' in (project.body ?? {})), `response is a workspace: ${describe(project)}`);
  if (project.status === 422) {
    expectError(project, 422, 'idempotency_key_reused');
    t.diagnostic('L3: path is part of the fingerprint (422 idempotency_key_reused)');
  } else {
    expectStatus(project, 201, 'expected 422 idempotency_key_reused or a fresh 201');
    assert.equal(project.body.workspace_id, ws.body.id);
    t.diagnostic('L3: key scoped per endpoint (fresh 201)');
  }
  const projects = await getOk(owner, `/v1/workspaces/${ws.body.id}/projects`);
  assert.equal(projects.data.length, project.status === 201 ? 1 : 0);
});
