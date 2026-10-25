import assert from 'node:assert/strict';
import { assertUnique, expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { advance, setClock } from '../lib/clock.ts';
import { idempotencyKey, type ApiResponse, type Json } from '../lib/client.ts';
import { crTest } from '../lib/cr.ts';
import { addMember, createComment, createTask, createTasks, createWebhook, getOk, registerUser, team, type Team } from '../lib/fixtures.ts';
import { assertOnlyUuids, compareIds, compareIdsDesc, idsDesc, UUIDV7_RE, uuidV7Millis, type Id } from '../lib/ids.ts';
import { createOrg, createWorkspaceIn, orgMembers } from '../lib/orgs.ts';
import { ok, startReceiver } from '../lib/receiver.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drainAll, emails } from '../lib/testmode.ts';

const test = crTest('CR-2');

freshDatabaseEachTest();

const T0 = '2026-05-04T09:15:30.250Z';

function bodyOf(res: ApiResponse, status = 200): Json {
  expectStatus(res, status);
  assertOnlyUuids(res.body, `${res.method} ${new URL(res.url).pathname}`);

  return res.body;
}

async function pages(t: Team, path: string, query: Record<string, string | number>): Promise<Id[]> {
  const all = await t.owner.client.pageAll(path, query);
  for (const p of all.pages) assertOnlyUuids(p.body);

  return all.items.map((x) => x.id);
}

test('[CR2-U] every id and *_id in API responses is a lowercase UUIDv7 string', async (t) => {
  const w = await team({ admins: 1, members: 1, viewers: 0 });
  const receiver = await startReceiver(ok());
  t.after(() => receiver.close());
  const hook = await createWebhook(w.owner, w.ws.id, { url: receiver.url, events: ['*'] });
  const task = await createTask(w.owner, w.project.id, { title: 'Opaque ids', assignee_id: w.member.id });
  const comment = await createComment(w.member, task.id, 'opaque');
  await drainAll();
  const deliveries = bodyOf(await w.owner.client.get(`/v1/webhooks/${hook.id}/deliveries`));
  const reads: [string, Json?][] = [
    ['/v1/users/me'],
    ['/v1/users/me/api-keys'],
    [`/v1/users/${w.member.id}`],
    ['/v1/workspaces'],
    [`/v1/workspaces/${w.ws.id}`],
    [`/v1/workspaces/${w.ws.id}/members`],
    [`/v1/workspaces/${w.ws.id}/projects`],
    [`/v1/workspaces/${w.ws.id}/tasks`],
    [`/v1/workspaces/${w.ws.id}/activity`],
    [`/v1/workspaces/${w.ws.id}/search`, { q: 'opaque' }],
    [`/v1/workspaces/${w.ws.id}/webhooks`],
    [`/v1/projects/${w.project.id}`],
    [`/v1/projects/${w.project.id}/summary`],
    [`/v1/tasks/${task.id}`],
    [`/v1/tasks/${task.id}/comments`],
    [`/v1/comments/${comment.id}`],
    [`/v1/webhooks/${hook.id}`],
    [`/v1/webhooks/${hook.id}/deliveries/${deliveries.data[0].id}`],
  ];
  for (const [path, query] of reads) bodyOf(await w.owner.client.get(path, query));
  for (const e of await emails()) assertOnlyUuids(e, `email ${e.template}`);
  for (const r of receiver.requests) {
    assertOnlyUuids(r.json, `webhook payload ${r.json?.event}`);
    assert.equal(r.headers['x-taskwell-delivery-id'], r.json.delivery_id, 'X-Taskwell-Delivery-Id carries the delivery UUID');
    assert.match(r.headers['x-taskwell-delivery-id'] ?? '', UUIDV7_RE);
  }
  assert.ok(receiver.requests.length >= 2);
  assert.ok(deliveries.data.every((d: Json) => d.webhook_id === hook.id));
});

test('[CR2-U] organizations, members, sole_owner details and created objects all carry UUIDv7 ids', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const bo = await registerUser({ name: 'Bo' });
  assert.match(ana.id as string, UUIDV7_RE);
  assert.match(ana.keyId as string, UUIDV7_RE);
  const org = bodyOf(await ana.client.post('/v1/organizations', { name: 'Uuid Holding' }), 201);
  const ws = await createWorkspaceIn(ana, org.id);
  assertOnlyUuids(ws);
  await addMember(ana, ws.id, bo, 'member');
  for (const m of await orgMembers(ana, org.id)) assertOnlyUuids(m);
  bodyOf(await ana.client.get(`/v1/organizations/${org.id}/workspaces`));
  bodyOf(await ana.client.post('/v1/users/me/api-keys', { name: 'ci' }), 201);
  const gone = await ana.client.delete('/v1/users/me');
  expectError(gone, 409, 'sole_owner');
  const detail = gone.body.error.details.find((d: Json) => d.code === 'sole_owner' && 'workspace_ids' in d);
  assert.deepEqual(detail.workspace_ids, [ws.id], 'workspace_ids are UUIDs');
});

test('[CR2-U] email dedupe keys embed the UUIDs of the objects they name', async () => {
  const w = await team({ admins: 0, members: 1, viewers: 0 });
  const task = await createTask(w.owner, w.project.id, { assignee_id: w.member.id });
  await drainAll();
  const [added] = await emails({ template: 'member_added', to: w.member.email });
  assert.match(added.dedupe_key, new RegExp(`^member_added:${w.ws.id}:${w.member.id}:[0-9a-f-]{36}$`));
  const [assigned] = await emails({ template: 'task_assigned', to: w.member.email });
  assert.match(assigned.dedupe_key, new RegExp(`^task_assigned:${task.id}:${w.member.id}:[0-9a-f-]{36}$`));
  assert.equal(assigned.data.task_id, task.id);
  assert.equal(assigned.data.workspace_id, w.ws.id);
});

test('[CR2-T] a new UUIDv7 carries the application clock at creation in its timestamp', async (t) => {
  await setClock(T0);
  const w = await team({ admins: 0, members: 1, viewers: 0 });
  const receiver = await startReceiver(ok());
  t.after(() => receiver.close());
  const hook = await createWebhook(w.owner, w.ws.id, { url: receiver.url, events: ['task.created'] });
  await advance(7);
  const task = await createTask(w.owner, w.project.id, { assignee_id: w.member.id });
  const comment = await createComment(w.member, task.id);
  await drainAll();
  const t0 = Date.parse(T0);
  for (const [what, id] of [['user', w.owner.id], ['api key', w.owner.keyId], ['workspace', w.ws.id], ['project', w.project.id], ['webhook', hook.id]] as [string, string][]) {
    assert.equal(uuidV7Millis(id), t0, `${what} UUID timestamp equals the clock at creation`);
  }
  for (const [what, id] of [['task', task.id], ['comment', comment.id]] as [string, string][]) {
    assert.equal(uuidV7Millis(id), t0 + 7000, `${what} UUID timestamp follows the advanced clock`);
  }
  const events = (await w.owner.client.pageAll(`/v1/workspaces/${w.ws.id}/activity`)).items;
  for (const e of events) assert.equal(uuidV7Millis(e.id), Date.parse(e.occurred_at), `event ${e.type} UUID timestamp equals occurred_at`);
  const [delivery] = (await getOk(w.owner, `/v1/webhooks/${hook.id}/deliveries`)).data;
  assert.equal(uuidV7Millis(delivery.id), Date.parse(delivery.created_at));
  for (const e of await emails()) assert.equal(uuidV7Millis(e.id), Date.parse(e.sent_at), `email ${e.template} UUID timestamp equals sent_at`);
  const org = await createOrg(w.owner);
  assert.equal(uuidV7Millis(org.id), t0 + 7000);
});

test('[CR2-4] two tasks created in the same millisecond have a deterministic order and page cleanly at limit=1', async () => {
  await setClock(T0);
  const w = await team({ admins: 0, members: 0, viewers: 0 });
  const [a, b] = await createTasks(w.owner, w.project.id, 2);
  assert.equal(a.created_at, b.created_at, 'same millisecond');
  const path = `/v1/projects/${w.project.id}/tasks`;
  const first = await pages(w, path, { sort: 'created_at', limit: 1 });
  assert.deepEqual(first, idsDesc(a.id, b.id), 'ties follow the UUID byte order, descending with created_at');
  assert.deepEqual(await pages(w, path, { sort: 'created_at', limit: 1 }), first, 'repeatable');
  assert.deepEqual(await pages(w, `/v1/workspaces/${w.ws.id}/tasks`, { sort: 'created_at', limit: 1 }), first);
});

test('[CR2-4] many same-millisecond tasks, created concurrently, page exactly once under every sort', async () => {
  await setClock(T0);
  const w = await team({ admins: 0, members: 0, viewers: 0 });
  const created = (await Promise.all(Array.from({ length: 12 }, (_, i) => w.owner.client.post(`/v1/projects/${w.project.id}/tasks`, { title: `Burst ${i}`, due_date: '2026-06-01' })))).map((r) => {
    expectStatus(r, 201);

    return r.body;
  });
  const ids = created.map((x) => x.id);
  assertUnique(ids, 'task ids');
  const path = `/v1/projects/${w.project.id}/tasks`;
  for (const [sort, order] of [['created_at', compareIdsDesc], ['updated_at', compareIdsDesc], ['due_date', compareIds]] as const) {
    const seen = await pages(w, path, { sort, limit: 5 });
    assert.deepEqual(seen, [...ids].sort(order), `sort=${sort} pages every task once in UUID tie order`);
  }
});

test('[CR2-2] integer ids are rejected on mutation: 404 in the path, 422 legacy_id_not_allowed in *_id fields', async () => {
  const w = await team({ admins: 0, members: 1, viewers: 0 });
  const task = await createTask(w.owner, w.project.id);
  expectError(await w.owner.client.patch('/v1/tasks/42', { title: 'x' }), 404, 'not_found');
  expectError(await w.owner.client.delete('/v1/tasks/42'), 404, 'not_found');
  expectError(await w.owner.client.post('/v1/projects/42/tasks', { title: 'x' }), 404, 'not_found');
  expectError(await w.owner.client.post(`/v1/workspaces/7/members`, { email: w.member.email, role: 'viewer' }), 404, 'not_found');
  expectValidation(await w.owner.client.patch(`/v1/tasks/${task.id}`, { assignee_id: 7 }), 'assignee_id', 'legacy_id_not_allowed');
  expectValidation(await w.owner.client.post(`/v1/projects/${w.project.id}/tasks`, { title: 'x', assignee_id: 7 }), 'assignee_id', 'legacy_id_not_allowed');
  expectValidation(await w.owner.client.patch(`/v1/tasks/${task.id}`, { project_id: 3 }), 'project_id', 'legacy_id_not_allowed');
  expectValidation(await w.owner.client.post(`/v1/workspaces/${w.ws.id}/transfer-ownership`, { user_id: 5 }), 'user_id', 'legacy_id_not_allowed');
  const okPatch = await w.owner.client.patch(`/v1/tasks/${task.id}`, { assignee_id: w.member.id });
  expectStatus(okPatch, 200);
  assert.equal(okPatch.body.assignee_id, w.member.id);
});

test('[CR2-5] payloads of objects created after the migration use UUIDs and carry no legacy_ids', async (t) => {
  const w = await team({ admins: 0, members: 1, viewers: 0 });
  const receiver = await startReceiver(ok());
  t.after(() => receiver.close());
  await createWebhook(w.owner, w.ws.id, { url: receiver.url, events: ['task.created', 'task.updated'] });
  const task = await createTask(w.owner, w.project.id, { assignee_id: w.member.id });
  expectStatus(await w.owner.client.patch(`/v1/tasks/${task.id}`, { title: 'Renamed' }), 200);
  await drainAll();
  assert.equal(receiver.requests.length, 2);
  for (const r of receiver.requests) {
    assert.equal(r.json.data.task.id, task.id);
    assert.ok(!('legacy_ids' in r.json), `a new object has no legacy_ids: ${r.text.slice(0, 300)}`);
  }
  const [mail] = await emails({ template: 'task_assigned', to: w.member.email });
  assert.ok(!('legacy_ids' in mail.data), 'email data for new objects has no legacy_ids');
});

test('[CR2-M] idempotent replays and cursors work with UUID ids', async () => {
  const w = await team({ admins: 0, members: 1, viewers: 0 });
  const key = idempotencyKey('uuid');
  const body = { title: 'Replay me', assignee_id: w.member.id };
  const first = await w.owner.client.post(`/v1/projects/${w.project.id}/tasks`, body, { idempotencyKey: key });
  expectStatus(first, 201);
  const replay = await w.owner.client.post(`/v1/projects/${w.project.id}/tasks`, { assignee_id: w.member.id, title: 'Replay me' }, { idempotencyKey: key });
  expectStatus(replay, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(replay.text, first.text, 'byte-identical replay');
  await createTasks(w.owner, w.project.id, 4);
  const page = await getOk(w.owner, `/v1/projects/${w.project.id}/tasks`, { limit: 2 });
  assert.equal(typeof page.next_cursor, 'string');
  const next = await w.owner.client.get(`/v1/projects/${w.project.id}/tasks`, { limit: 2, cursor: page.next_cursor });
  expectStatus(next, 200);
  assert.equal(next.body.data.filter((x: Json) => page.data.some((p: Json) => p.id === x.id)).length, 0);
});

test('[CR2-U] a malformed id in the path is 404', async () => {
  const w = await team({ admins: 0, members: 0, viewers: 0 });
  for (const bad of ['not-a-uuid', '0190a5d7-xxxx-7000-8000-000000000000', '1.5']) {
    expectError(await w.owner.client.get(`/v1/tasks/${bad}`), 404, 'not_found');
  }
  expectStatus(await w.owner.client.get(`/v1/projects/${w.project.id}`), 200);
});
