import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { addSeconds, setClock } from '../lib/clock.ts';
import { request, type ApiResponse, type Json } from '../lib/client.ts';
import { createProject, createTask, createWebhook, createWorkspace, registerUser, type User } from '../lib/fixtures.ts';
import { assertOnlyUuids, UUIDV7_RE, uuidV7Millis } from '../lib/ids.ts';
import { legacySkip, legacyUser, loadLegacy, requireLegacyDataset, type LegacyManifest, type LegacyObject } from '../lib/legacy.ts';
import { ok, startReceiver } from '../lib/receiver.ts';
import { drainAll, emails } from '../lib/testmode.ts';

// Runs against the dataset of scripts/seed-legacy.ts after ./bin/setup migrated it; never resets. Tests run in
// file order and the last ones move the application clock past the sunset.
const manifest = loadLegacy();
const skip = legacySkip('CR-2', manifest);
const m = manifest as LegacyManifest;
const DAY = 86_400;

requireLegacyDataset(manifest, skip);
after(async () => {
  if (!skip) await request('DELETE', '/__test/clock');
});

const user = (name: 'ana' | 'bo' | 'cy' | 'dee'): User => legacyUser(m.users[name]);

function expectDeprecated(res: ApiResponse, what: string): Date {
  expectStatus(res, 200, what);
  assert.equal(res.headers.get('deprecation'), 'true', `${what}: Deprecation: true`);
  const sunset = res.headers.get('sunset');
  assert.ok(sunset && !Number.isNaN(Date.parse(sunset)) && /GMT$/.test(sunset), `${what}: Sunset must be an HTTP-date, got ${sunset}`);
  assertOnlyUuids(res.body, what);

  return new Date(sunset);
}

function expectCurrent(res: ApiResponse, what: string): void {
  expectStatus(res, 200, what);
  assert.equal(res.headers.get('deprecation'), null, `${what}: no Deprecation header via a UUID`);
  assert.equal(res.headers.get('sunset'), null, `${what}: no Sunset header via a UUID`);
}

async function uuidOf(u: User, path: string): Promise<string> {
  const res = await u.client.get(path);
  expectDeprecated(res, `GET ${path}`);

  return res.body.id;
}

async function sunsetInstant(): Promise<Date> {
  return expectDeprecated(await user('ana').client.get(`/v1/tasks/${m.tasks.t1.id}`), 'legacy task read');
}

test('[CR2-1] GET by legacy integer serves UUIDs with Deprecation and Sunset; by UUID it is identical without them', { skip }, async () => {
  const ana = user('ana');
  const startedAt = Date.now();
  const legacy = await ana.client.get(`/v1/tasks/${m.tasks.t1.id}`);
  const sunset = expectDeprecated(legacy, 'GET /v1/tasks/<int>');
  assert.match(legacy.body.id, UUIDV7_RE);
  const current = await ana.client.get(`/v1/tasks/${legacy.body.id}`);
  expectCurrent(current, 'GET /v1/tasks/<uuid>');
  assert.deepEqual(current.body, legacy.body, 'identical body');
  const migratedAt = sunset.getTime() - 30 * DAY * 1000;
  assert.ok(migratedAt >= Date.parse(m.seededAt) - 1000 && migratedAt <= startedAt + 1000, `Sunset ${sunset.toUTCString()} must be 30 days after a migration between seeding and now`);
});

test('[CR2-1] every migrated object type resolves its legacy id and reports one Sunset', { skip }, async () => {
  const ana = user('ana');
  const paths = [
    `/v1/users/${m.users.cy.id}`,
    `/v1/workspaces/${m.workspaces.alpha.id}`,
    `/v1/projects/${m.projects.alpha.id}`,
    `/v1/tasks/${m.tasks.t2.id}`,
    `/v1/comments/${m.comments.c1.id}`,
    `/v1/webhooks/${m.webhooks[0].id}`,
    `/v1/workspaces/${m.workspaces.alpha.id}/members`,
    `/v1/projects/${m.projects.alpha.id}/tasks`,
    `/v1/tasks/${m.tasks.t1.id}/comments`,
  ];
  const sunsets = new Set<number>();
  for (const path of paths) sunsets.add(expectDeprecated(await ana.client.get(path), `GET ${path}`).getTime());
  assert.equal(sunsets.size, 1, 'one migration, one Sunset');
});

test('[CR2-T] migrated rows get UUIDv7 ids whose timestamp is their created_at', { skip }, async () => {
  const ana = user('ana');
  const rows: [string, string, LegacyObject][] = [
    ['task', `/v1/tasks/${m.tasks.t1.id}`, m.tasks.t1],
    ['task', `/v1/tasks/${m.tasks.t3.id}`, m.tasks.t3],
    ['project', `/v1/projects/${m.projects.alpha.id}`, m.projects.alpha],
    ['workspace', `/v1/workspaces/${m.workspaces.alpha.id}`, m.workspaces.alpha],
    ['comment', `/v1/comments/${m.comments.c1.id}`, m.comments.c1],
    ['webhook', `/v1/webhooks/${m.webhooks[1].id}`, m.webhooks[1]],
  ];
  for (const [what, path, row] of rows) {
    const body = (await ana.client.get(path)).body;
    assert.equal(body.created_at, row.created_at, `${what}: created_at is unchanged`);
    assert.equal(uuidV7Millis(body.id), Date.parse(row.created_at), `${what}: UUID timestamp = created_at`);
  }
  const me = (await ana.client.get('/v1/users/me')).body;
  assert.equal(uuidV7Millis(me.id), Date.parse(m.users.ana.created_at), 'user UUID timestamp = created_at');
  const alpha = await uuidOf(ana, `/v1/workspaces/${m.workspaces.alpha.id}`);
  const events = (await ana.client.pageAll(`/v1/workspaces/${alpha}/activity`, { limit: 100 })).items;
  const t1Created = events.find((e) => e.type === 'task.created' && Date.parse(e.occurred_at) === Date.parse(m.events.t1Created.created_at));
  assert.ok(t1Created, 'the migrated task.created event is still listed');
  assert.equal(uuidV7Millis(t1Created.id), Date.parse(t1Created.occurred_at));
  for (const e of events) assertOnlyUuids(e, `event ${e.type}`);
});

test('[CR2-6] a legacy integer in a GET filter works during the window and is deprecated', { skip }, async () => {
  const ana = user('ana');
  const alpha = await uuidOf(ana, `/v1/workspaces/${m.workspaces.alpha.id}`);
  const cy = await uuidOf(ana, `/v1/users/${m.users.cy.id}`);
  const res = await ana.client.get(`/v1/workspaces/${alpha}/tasks`, { assignee_id: m.users.cy.id });
  expectDeprecated(res, 'tasks?assignee_id=<int>');
  const titles = res.body.data.map((x: Json) => x.title).sort();
  assert.deepEqual(titles, [m.tasks.t1.title, m.tasks.t3.title].sort());
  assert.ok(res.body.data.every((x: Json) => x.assignee_id === cy));
  const viaUuid = await ana.client.get(`/v1/workspaces/${alpha}/tasks`, { assignee_id: cy });
  expectCurrent(viaUuid, 'tasks?assignee_id=<uuid>');
  assert.deepEqual(viaUuid.body.data, res.body.data);
  const byActor = await ana.client.get(`/v1/workspaces/${alpha}/activity`, { actor_id: m.users.cy.id });
  expectDeprecated(byActor, 'activity?actor_id=<int>');
  assert.ok(byActor.body.data.length >= 1 && byActor.body.data.every((e: Json) => e.actor.id === cy));
});

test('[CR2-2] legacy ids on mutating requests: 404 in the path, 422 legacy_id_not_allowed in bodies', { skip }, async () => {
  const ana = user('ana');
  const t2 = await uuidOf(ana, `/v1/tasks/${m.tasks.t2.id}`);
  const dee = await uuidOf(ana, `/v1/users/${m.users.dee.id}`);
  expectError(await ana.client.patch(`/v1/tasks/${m.tasks.t2.id}`, { title: 'Via legacy' }), 404, 'not_found');
  expectError(await ana.client.delete(`/v1/tasks/${m.tasks.t2.id}`), 404, 'not_found');
  expectError(await ana.client.post(`/v1/tasks/${m.tasks.t2.id}/comments`, { body: 'Via legacy' }), 404, 'not_found');
  expectError(await ana.client.post(`/v1/projects/${m.projects.alpha.id}/tasks`, { title: 'Via legacy' }), 404, 'not_found');
  expectValidation(await ana.client.patch(`/v1/tasks/${t2}`, { assignee_id: m.users.dee.id }), 'assignee_id', 'legacy_id_not_allowed');
  const unchanged = (await ana.client.get(`/v1/tasks/${t2}`)).body;
  assert.equal(unchanged.assignee_id, null);
  const assigned = await ana.client.patch(`/v1/tasks/${t2}`, { assignee_id: dee });
  expectStatus(assigned, 200);
  assert.equal(assigned.body.assignee_id, dee);
  assert.equal(assigned.body.version, unchanged.version + 1);
});

test('[CR2-5] payloads and emails about migrated objects carry legacy_ids during the window; new objects have none', { skip }, async (t) => {
  const ana = user('ana');
  const beta = await uuidOf(ana, `/v1/workspaces/${m.workspaces.beta.id}`);
  const betaProject = await uuidOf(ana, `/v1/projects/${m.projects.beta.id}`);
  const betaTask = await uuidOf(ana, `/v1/tasks/${m.tasks.beta.id}`);
  const receiver = await startReceiver(ok());
  t.after(() => receiver.close());
  await createWebhook(ana, beta, { url: receiver.url, events: ['task.created', 'task.updated'] });
  expectStatus(await ana.client.patch(`/v1/tasks/${betaTask}`, { title: 'Migrated, edited' }), 200);
  const fresh = await createTask(ana, betaProject, { title: 'Created after migration' });
  await drainAll();
  const edited = receiver.requests.find((r) => r.json?.event === 'task.updated');
  assert.ok(edited, 'task.updated delivered');
  assert.equal(edited.json.data.task.id, betaTask);
  assertOnlyUuids(edited.json, 'payload of a migrated task');
  assert.equal(edited.json.legacy_ids?.task_id, m.tasks.beta.id, 'legacy_ids.task_id is the old integer');
  const created = receiver.requests.find((r) => r.json?.event === 'task.created');
  assert.equal(created?.json.data.task.id, fresh.id);
  assert.match(fresh.id, UUIDV7_RE);
  assert.ok(!('task_id' in (created?.json.legacy_ids ?? {})), 'a new task has no legacy task_id');

  const t2 = await uuidOf(ana, `/v1/tasks/${m.tasks.t2.id}`);
  const cy = await uuidOf(ana, `/v1/users/${m.users.cy.id}`);
  expectStatus(await ana.client.patch(`/v1/tasks/${t2}`, { assignee_id: cy }), 200);
  await drainAll();
  const mail = (await emails({ template: 'task_assigned', to: m.users.cy.email })).find((e) => e.data.task_id === t2);
  assert.ok(mail, 'task_assigned email for the migrated task');
  assertOnlyUuids(mail.data, 'email data');
  assert.equal(mail.data.legacy_ids?.task_id, m.tasks.t2.id);
});

test('[CR2-5] a task in a workspace created after the migration has no legacy_ids at all', { skip }, async (t) => {
  const zoe = await registerUser({ name: 'Zoe' });
  const ws = await createWorkspace(zoe);
  const project = await createProject(zoe, ws.id);
  const receiver = await startReceiver(ok());
  t.after(() => receiver.close());
  await createWebhook(zoe, ws.id, { url: receiver.url, events: ['task.created'] });
  const task = await createTask(zoe, project.id);
  await drainAll();
  assert.equal(receiver.requests.length, 1);
  assert.equal(receiver.requests[0].json.data.task.id, task.id);
  assert.ok(!('legacy_ids' in receiver.requests[0].json), 'legacy_ids absent for an object without one');
});

test('[CR2-M] a cursor issued before the migration is 400 invalid_cursor', { skip }, async () => {
  const ana = user('ana');
  const res = await ana.client.get(m.cursor.path, { ...m.cursor.query, cursor: m.cursor.cursor });
  expectError(res, 400, 'invalid_cursor');
  const project = await uuidOf(ana, `/v1/projects/${m.projects.alpha.id}`);
  const fresh = await ana.client.get(`/v1/projects/${project}/tasks`, m.cursor.query);
  expectStatus(fresh, 200);
  expectStatus(await ana.client.get(`/v1/projects/${project}/tasks`, { ...m.cursor.query, cursor: fresh.body.next_cursor }), 200);
});

test('[CR2-M] an idempotency record stored before the migration replays its stored body unchanged', { skip }, async () => {
  const ana = user('ana');
  const { key, path, body, status, text } = m.idempotency;
  const project = await uuidOf(ana, `/v1/projects/${m.projects.alpha.id}`);
  const before = (await ana.client.pageAll(`/v1/projects/${project}/tasks`, { limit: 100 })).items.length;
  const replay = await ana.client.post(path, body, { idempotencyKey: key });
  expectStatus(replay, status);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(replay.text, text, 'the stored integer body, byte for byte');
  const after = (await ana.client.pageAll(`/v1/projects/${project}/tasks`, { limit: 100 })).items.length;
  assert.equal(after, before, 'a replay creates nothing');
});

test('[CR2-M] after the natural 24-hour expiry the old key is unused: the legacy path is 404, the UUID path creates', { skip }, async () => {
  const ana = user('ana');
  const { key, path, body } = m.idempotency;
  await setClock(addSeconds(m.seededAt, DAY + 60));
  expectError(await ana.client.post(path, body, { idempotencyKey: key }), 404, 'not_found');
  const project = await uuidOf(ana, `/v1/projects/${m.projects.alpha.id}`);
  const created = await ana.client.post(`/v1/projects/${project}/tasks`, body, { idempotencyKey: key });
  expectStatus(created, 201);
  assert.equal(created.headers.get('idempotent-replayed'), null);
  assert.match(created.body.id, UUIDV7_RE);
});

test('[CR2-3] integer ids work until the Sunset instant and return 404 after it; UUIDs keep working', { skip }, async () => {
  const ana = user('ana');
  const sunset = await sunsetInstant();
  const t1 = (await ana.client.get(`/v1/tasks/${m.tasks.t1.id}`)).body.id;
  await setClock(new Date(sunset.getTime() - 1000).toISOString());
  expectDeprecated(await ana.client.get(`/v1/tasks/${m.tasks.t1.id}`), 'one second before Sunset');
  await setClock(new Date(sunset.getTime() + 1000).toISOString());
  expectError(await ana.client.get(`/v1/tasks/${m.tasks.t1.id}`), 404, 'not_found');
  expectError(await ana.client.get(`/v1/workspaces/${m.workspaces.alpha.id}`), 404, 'not_found');
  const alpha = (await ana.client.pageAll('/v1/workspaces')).items.find((w) => w.name === m.workspaces.alpha.name);
  const filtered = await ana.client.get(`/v1/workspaces/${alpha.id}/tasks`, { assignee_id: m.users.cy.id });
  assert.notEqual(filtered.headers.get('deprecation'), 'true', 'no legacy resolution after the sunset');
  expectCurrent(await ana.client.get(`/v1/tasks/${t1}`), 'UUID after Sunset');
});

test('[CR2-3] after the sunset, payloads and emails drop legacy_ids', { skip }, async (t) => {
  const ana = user('ana');
  expectError(await ana.client.get(`/v1/tasks/${m.tasks.t1.id}`), 404, 'not_found');
  const beta = (await ana.client.pageAll('/v1/workspaces')).items.find((w) => w.name === m.workspaces.beta.name);
  const tasks = (await ana.client.pageAll(`/v1/workspaces/${beta.id}/tasks`, { limit: 100 })).items;
  const migrated = tasks.find((x) => x.title === 'Migrated, edited');
  assert.ok(migrated, 'the migrated beta task');
  const receiver = await startReceiver(ok());
  t.after(() => receiver.close());
  await createWebhook(ana, beta.id, { url: receiver.url, events: ['task.updated'] });
  expectStatus(await ana.client.patch(`/v1/tasks/${migrated.id}`, { title: 'Edited after sunset' }), 200);
  await drainAll();
  const last = receiver.requests.at(-1);
  assert.equal(last?.json.data.task.id, migrated.id);
  assert.ok(!('legacy_ids' in (last?.json ?? {})), 'legacy_ids dropped after 30 days');
});
