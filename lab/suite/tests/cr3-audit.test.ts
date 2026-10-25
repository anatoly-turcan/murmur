import assert from 'node:assert/strict';
import { assertUnique, expectError, expectStatus } from '../lib/assert.ts';
import { advance, setClock } from '../lib/clock.ts';
import { anonymous, idempotencyKey, type ApiResponse, type Json } from '../lib/client.ts';
import { assertActorIs, assertEntryShape, audit, auditTeam, requestId, userOriginated, workspaceAudit, type AuditTeam } from '../lib/audit.ts';
import { crTest } from '../lib/cr.ts';
import { addMember, createComment, createTask, deleteOk, getOk, registerUser, uniqueEmail, uniqueName } from '../lib/fixtures.ts';
import { compareIdsDesc, type Id } from '../lib/ids.ts';
import { addOrgMember, createWorkspaceIn, setPlan } from '../lib/orgs.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drainAll } from '../lib/testmode.ts';

const test = crTest('CR-3');

freshDatabaseEachTest();

function withoutOverdue(task: Json): Json {
  const { overdue: _ignored, ...rest } = task;

  return rest;
}

async function entriesFor(t: AuditTeam, res: ApiResponse): Promise<Json[]> {
  return workspaceAudit(t.owner, t.ws.id, { request_id: requestId(res) });
}

async function only(t: AuditTeam, res: ApiResponse): Promise<Json> {
  const entries = userOriginated(await entriesFor(t, res));
  assert.equal(entries.length, 1, `exactly one entry for ${res.method} ${new URL(res.url).pathname}: ${JSON.stringify(entries).slice(0, 600)}`);
  assertEntryShape(entries[0]);

  return entries[0];
}

function assertSorted(entries: Json[]): void {
  for (let i = 1; i < entries.length; i += 1) {
    const [a, b] = [entries[i - 1], entries[i]];
    assert.ok(a.occurred_at > b.occurred_at || (a.occurred_at === b.occurred_at && compareIdsDesc(a.id, b.id) < 0), `entries ${i - 1} and ${i} break occurred_at desc, id desc`);
  }
}

test('[CR3-1] a PATCH of status and labels writes one update entry with an exact diff, versions and the request id', async () => {
  const t = await auditTeam();
  const task = await createTask(t.member, t.project.id, { title: 'Audit me', labels: ['ui'] });
  const before = await getOk(t.owner, `/v1/tasks/${task.id}`);
  const res = await t.member.client.patch(`/v1/tasks/${task.id}`, { status: 'done', labels: ['bug', 'ui'] });
  expectStatus(res, 200);
  const e = await only(t, res);
  assert.equal(e.action, 'update');
  assert.deepEqual(e.resource, { type: 'task', id: task.id });
  assert.deepEqual(e.diff, { status: { from: 'open', to: 'done' }, labels: { from: ['ui'], to: ['bug', 'ui'] } });
  assert.equal(e.before.version, e.after.version - 1);
  assert.deepEqual(withoutOverdue(e.before), withoutOverdue(before), 'before is the GET representation');
  assert.deepEqual(withoutOverdue(e.after), withoutOverdue(res.body), 'after is the representation the PATCH returned');
  assert.equal(e.request_id, res.headers.get('x-request-id'));
  assert.equal(e.workspace_id, t.ws.id);
  assert.equal(e.organization_id, t.org.id);
  assert.equal(e.ip, t.member.client.ip);
  assertActorIs(e, t.member);
  const forTask = await workspaceAudit(t.owner, t.ws.id, { resource_id: task.id });
  assert.deepEqual(forTask.map((x) => x.action), ['update', 'create']);
});

test('[CR3-1] PATCH {} writes an entry with an empty diff whose snapshots differ only in version and updated_at', async () => {
  await setClock('2026-07-01T09:00:00Z');
  const t = await auditTeam();
  const task = await createTask(t.owner, t.project.id);
  await advance(60);
  const res = await t.owner.client.patch(`/v1/tasks/${task.id}`, {});
  expectStatus(res, 200);
  const e = await only(t, res);
  assert.equal(e.action, 'update');
  assert.deepEqual(e.diff, {});
  assert.equal(e.after.version, e.before.version + 1);
  const { version: _bv, updated_at: _bu, ...beforeRest } = withoutOverdue(e.before);
  const { version: _av, updated_at: _au, ...afterRest } = withoutOverdue(e.after);
  assert.deepEqual(afterRest, beforeRest);
});

test('[CR3-2] an idempotent replay and rejected requests add no entries', async () => {
  const t = await auditTeam();
  const key = idempotencyKey('audit');
  const body = { title: 'Created once' };
  const first = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, body, { idempotencyKey: key });
  expectStatus(first, 201);
  const count = async (): Promise<number> => (await workspaceAudit(t.owner, t.ws.id)).length;
  await drainAll();
  const baseline = await count();
  const replay = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, body, { idempotencyKey: key });
  expectStatus(replay, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(await count(), baseline, 'a replay writes no entry');
  assert.equal((await workspaceAudit(t.owner, t.ws.id, { resource_id: first.body.id })).length, 1);

  const stale = await t.owner.client.patch(`/v1/tasks/${first.body.id}`, { status: 'done' }, { ifMatch: 99 });
  expectError(stale, 409, 'version_conflict');
  expectError(await t.viewer.client.patch(`/v1/tasks/${first.body.id}`, { status: 'done' }), 403, 'forbidden');
  expectError(await t.owner.client.patch(`/v1/tasks/${first.body.id}`, { status: 'later' }), 422, 'validation_failed');
  expectError(await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'x', priority: 'high' }), 422, 'validation_failed');
  assert.equal(await count(), baseline, 'no 4xx writes an entry');
});

test('[CR3-3] removing a member assigned to three tasks yields four entries sharing one request id', async () => {
  const t = await auditTeam();
  const tasks: Json[] = [];
  for (let i = 0; i < 3; i += 1) tasks.push(await createTask(t.owner, t.project.id, { title: `Bo ${i}`, assignee_id: t.member.id }));
  const res = await t.admin.client.delete(`/v1/workspaces/${t.ws.id}/members/${t.member.id}`);
  expectStatus(res, 204);
  const rid = requestId(res);
  const entries = await workspaceAudit(t.owner, t.ws.id, { request_id: rid });
  assert.equal(entries.length, 4, JSON.stringify(entries).slice(0, 800));
  assert.ok(entries.every((e) => e.request_id === rid));
  const taskEntries = entries.filter((e) => e.resource.type === 'task');
  assert.deepEqual(taskEntries.map((e) => e.resource.id).sort(), tasks.map((x) => x.id).sort());
  for (const e of taskEntries) {
    assert.equal(e.action, 'update');
    assert.deepEqual(e.diff, { assignee_id: { from: t.member.id, to: null } });
    assertActorIs(e, t.admin);
  }
  const membership = entries.filter((e) => e.resource.type !== 'task');
  assert.equal(membership.length, 1);
  assert.equal(membership[0].action, 'delete');
  assert.match(membership[0].resource.type, /^member(ship)?$/);
});

test('[CR3-4] viewers and members get 403, removed members 404, non-members 404 on the workspace audit', async () => {
  const t = await auditTeam();
  const task = await createTask(t.owner, t.project.id);
  const [entry] = await workspaceAudit(t.owner, t.ws.id, { resource_id: task.id });
  const outsider = await registerUser({ name: 'Oz' });
  expectError(await t.viewer.client.get(`/v1/workspaces/${t.ws.id}/audit`), 403, 'forbidden');
  expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}/audit`), 403, 'forbidden');
  expectError(await outsider.client.get(`/v1/workspaces/${t.ws.id}/audit`), 404, 'not_found');
  expectError(await outsider.client.get(`/v1/audit/${entry.id}`), 404, 'not_found');
  expectStatus(await t.admin.client.get(`/v1/workspaces/${t.ws.id}/audit`), 200);
  const single = await t.admin.client.get(`/v1/audit/${entry.id}`);
  expectStatus(single, 200);
  assert.deepEqual(single.body, entry);
  await deleteOk(t.owner, `/v1/workspaces/${t.ws.id}/members/${t.admin.id}`);
  expectError(await t.admin.client.get(`/v1/workspaces/${t.ws.id}/audit`), 404, 'not_found');
  expectError(await t.admin.client.get(`/v1/audit/${entry.id}`), 404, 'not_found');
});

test('[CR3-4] admins still read entries of a soft-deleted task and of a soft-deleted workspace', async () => {
  const t = await auditTeam();
  const task = await createTask(t.owner, t.project.id);
  await deleteOk(t.owner, `/v1/tasks/${task.id}`);
  const forTask = await workspaceAudit(t.admin, t.ws.id, { resource_id: task.id });
  assert.deepEqual(forTask.map((e) => e.action), ['delete', 'create']);
  expectStatus(await t.admin.client.get(`/v1/audit/${forTask[1].id}`), 200);
  const del = await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`);
  expectStatus(del, 204);
  const res = await t.admin.client.get(`/v1/workspaces/${t.ws.id}/audit`, { limit: 100 });
  expectStatus(res, 200, 'audit of a deleted workspace stays readable by admins');
  assert.ok(res.body.data.some((e: Json) => e.request_id === requestId(del) && e.action === 'delete'));
  expectStatus(await t.admin.client.get(`/v1/audit/${forTask[0].id}`), 200);
  expectError(await t.viewer.client.get(`/v1/workspaces/${t.ws.id}/audit`), 403, 'forbidden');
});

interface Mutation {
  label: string;
  run: () => Promise<ApiResponse>;
  action: string;
  type: RegExp;
  id: () => Id;
}

test('[CR3-M] every workspace mutation writes one entry with the right action and resource', async () => {
  const t = await auditTeam();
  const ids: Record<string, Id> = {};
  const extra = await registerUser({ name: 'Fay' });
  const keep = (name: string, res: ApiResponse): ApiResponse => {
    if (res.body?.id !== undefined) ids[name] ??= res.body.id;

    return res;
  };
  const o = t.owner.client;
  const mutations: Mutation[] = [
    { label: 'create project', run: async () => keep('project', await o.post(`/v1/workspaces/${t.ws.id}/projects`, { name: uniqueName('Audit') })), action: 'create', type: /^project$/, id: () => ids.project },
    { label: 'update project', run: () => o.patch(`/v1/projects/${ids.project}`, { description: 'x' }), action: 'update', type: /^project$/, id: () => ids.project },
    { label: 'create task', run: async () => keep('task', await o.post(`/v1/projects/${ids.project}/tasks`, { title: 'Audited' })), action: 'create', type: /^task$/, id: () => ids.task },
    { label: 'update task', run: () => o.patch(`/v1/tasks/${ids.task}`, { title: 'Audited 2' }), action: 'update', type: /^task$/, id: () => ids.task },
    { label: 'claim task', run: () => t.member.client.post(`/v1/tasks/${ids.task}/claim`), action: 'claim', type: /^task$/, id: () => ids.task },
    { label: 'create comment', run: async () => keep('comment', await o.post(`/v1/tasks/${ids.task}/comments`, { body: 'audit' })), action: 'create', type: /^comment$/, id: () => ids.comment },
    { label: 'update comment', run: () => o.patch(`/v1/comments/${ids.comment}`, { body: 'audit 2' }), action: 'update', type: /^comment$/, id: () => ids.comment },
    { label: 'delete comment', run: () => o.delete(`/v1/comments/${ids.comment}`), action: 'delete', type: /^comment$/, id: () => ids.comment },
    { label: 'restore comment', run: () => o.post(`/v1/comments/${ids.comment}/restore`), action: 'restore', type: /^comment$/, id: () => ids.comment },
    { label: 'delete task', run: () => o.delete(`/v1/tasks/${ids.task}`), action: 'delete', type: /^task$/, id: () => ids.task },
    { label: 'restore task', run: () => o.post(`/v1/tasks/${ids.task}/restore`), action: 'restore', type: /^task$/, id: () => ids.task },
    { label: 'delete project', run: () => o.delete(`/v1/projects/${ids.project}`), action: 'delete', type: /^project$/, id: () => ids.project },
    { label: 'restore project', run: () => o.post(`/v1/projects/${ids.project}/restore`), action: 'restore', type: /^project$/, id: () => ids.project },
    { label: 'add member', run: () => o.post(`/v1/workspaces/${t.ws.id}/members`, { email: extra.email, role: 'member' }), action: 'create', type: /^member(ship)?$/, id: () => extra.id },
    { label: 'change role', run: () => o.patch(`/v1/workspaces/${t.ws.id}/members/${extra.id}`, { role: 'admin' }), action: 'update', type: /^member(ship)?$/, id: () => extra.id },
    { label: 'remove member', run: () => o.delete(`/v1/workspaces/${t.ws.id}/members/${extra.id}`), action: 'delete', type: /^member(ship)?$/, id: () => extra.id },
    { label: 'create webhook', run: async () => keep('webhook', await o.post(`/v1/workspaces/${t.ws.id}/webhooks`, { url: 'http://127.0.0.1:9/a', events: ['task.created'] })), action: 'create', type: /^webhook$/, id: () => ids.webhook },
    { label: 'update webhook', run: () => o.patch(`/v1/webhooks/${ids.webhook}`, { active: false }), action: 'update', type: /^webhook$/, id: () => ids.webhook },
    { label: 'delete webhook', run: () => o.delete(`/v1/webhooks/${ids.webhook}`), action: 'delete', type: /^webhook$/, id: () => ids.webhook },
    { label: 'update workspace', run: () => o.patch(`/v1/workspaces/${t.ws.id}`, { name: uniqueName('Renamed') }), action: 'update', type: /^workspace$/, id: () => t.ws.id },
    { label: 'delete workspace', run: () => o.delete(`/v1/workspaces/${t.ws.id}`), action: 'delete', type: /^workspace$/, id: () => t.ws.id },
    { label: 'restore workspace', run: () => o.post(`/v1/workspaces/${t.ws.id}/restore`), action: 'restore', type: /^workspace$/, id: () => t.ws.id },
  ];
  const requestIds: string[] = [];
  for (const m of mutations) {
    const res = await m.run();
    assert.ok(res.status >= 200 && res.status < 300, `${m.label}: ${res.status} ${res.text.slice(0, 200)}`);
    requestIds.push(requestId(res));
    const target = userOriginated(await entriesFor(t, res)).filter((x) => x.resource?.id === m.id());
    assert.equal(target.length, 1, `${m.label}: exactly one entry for the target resource`);
    const e = target[0];
    assertEntryShape(e);
    assert.equal(e.action, m.action, `${m.label}: action`);
    assert.match(e.resource.type, m.type, `${m.label}: resource.type`);
    assert.equal(e.resource.id, m.id(), `${m.label}: resource.id`);
  }
  assertUnique(requestIds, 'X-Request-Id values');
  await addOrgMember(t.owner, t.org.id, t.admin, 'org_member');
  const transfer = await o.post(`/v1/workspaces/${t.ws.id}/transfer-ownership`, { user_id: t.admin.id });
  expectStatus(transfer, 200);
  const transferEntries = userOriginated(await entriesFor(t, transfer));
  assert.ok(transferEntries.some((e) => e.action === 'transfer' && e.resource.type === 'workspace' && e.resource.id === t.ws.id), 'transfer entry');
});

test('[CR3-F] filters combine with cursors; a cursor is bound to its filters and its endpoint', async () => {
  const t = await auditTeam();
  const tasks: Json[] = [];
  for (let i = 0; i < 6; i += 1) tasks.push(await createTask(i % 2 ? t.member : t.owner, t.project.id, { title: `Filter ${i}` }));
  for (const task of tasks) expectStatus(await t.owner.client.patch(`/v1/tasks/${task.id}`, { status: 'in_progress' }), 200);
  const all = await workspaceAudit(t.owner, t.ws.id);
  assertSorted(all);
  for (const e of all) assertEntryShape(e);
  const byMember = await workspaceAudit(t.owner, t.ws.id, { actor_id: t.member.id, resource_type: 'task', action: 'create' });
  assert.equal(byMember.length, 3);
  assert.ok(byMember.every((e) => e.action === 'create' && e.resource.type === 'task'));
  const updates = await t.owner.client.pageAll(`/v1/workspaces/${t.ws.id}/audit`, { action: 'update', resource_type: 'task', limit: 4 });
  assert.equal(updates.items.length, 6);
  assert.equal(updates.pages.length, 2);
  const window = all.filter((e) => e.resource.type === 'task');
  const since = window.at(-1).occurred_at;
  const bounded = await workspaceAudit(t.owner, t.ws.id, { since, until: '2999-01-01T00:00:00.000Z', resource_type: 'task' });
  assert.equal(bounded.length, window.length);
  const page = await t.owner.client.get(`/v1/workspaces/${t.ws.id}/audit`, { action: 'update', limit: 2 });
  expectStatus(page, 200);
  expectError(await t.owner.client.get(`/v1/workspaces/${t.ws.id}/audit`, { action: 'create', limit: 2, cursor: page.body.next_cursor }), 400, 'invalid_cursor');
  expectError(await t.owner.client.get(`/v1/workspaces/${t.ws.id}/activity`, { limit: 2, cursor: page.body.next_cursor }), 400, 'cursor_mismatched');
  expectError(await t.owner.client.get(`/v1/workspaces/${t.ws.id}/audit`, { action: 'explode' }), 400, 'invalid_query');
});

test('[CR3-S] the organization audit covers every workspace and org-level mutations; org_admin+ only', async () => {
  const t = await auditTeam();
  const orgAdmin = await registerUser({ name: 'Orla' });
  const orgMember = await registerUser({ name: 'Omar' });
  await addOrgMember(t.owner, t.org.id, orgAdmin, 'org_admin');
  await addOrgMember(t.owner, t.org.id, orgMember, 'org_member');
  const second = await createWorkspaceIn(t.owner, t.org.id);
  const a = await createTask(t.owner, t.project.id);
  const planRes = await t.owner.client.patch(`/v1/organizations/${t.org.id}`, { plan: 'team' });
  expectStatus(planRes, 200);
  const entries = await audit(orgAdmin, `/v1/organizations/${t.org.id}/audit`);
  const workspaces = new Set(entries.map((e) => e.workspace_id));
  assert.ok(workspaces.has(t.ws.id) && workspaces.has(second.id), 'entries of both workspaces');
  assert.ok(entries.some((e) => e.resource.id === a.id && e.action === 'create'));
  const plan = entries.find((e) => e.request_id === requestId(planRes));
  assert.ok(plan, 'the plan change is audited at org level');
  assert.equal(plan.resource.type, 'organization');
  assert.equal(plan.workspace_id, null);
  assert.deepEqual(plan.diff.plan, { from: 'business', to: 'team' });
  expectError(await orgMember.client.get(`/v1/organizations/${t.org.id}/audit`), 403, 'forbidden');
  const outsider = await registerUser({ name: 'Oz' });
  expectError(await outsider.client.get(`/v1/organizations/${t.org.id}/audit`), 404, 'not_found');
  await setPlan(t.owner, t.org.id, 'business');
});

test('[CR3-S] /v1/users/me/audit lists only my own actions in workspaces I still belong to', async () => {
  const t = await auditTeam();
  const other = await createWorkspaceIn(t.owner, t.org.id);
  await addMember(t.owner, other.id, t.member, 'member');
  const mine = await createTask(t.member, t.project.id, { title: 'Mine' });
  await createTask(t.owner, t.project.id, { title: 'Not mine' });
  const otherProject = await t.owner.client.post(`/v1/workspaces/${other.id}/projects`, { name: uniqueName('Other') });
  const elsewhere = await createTask(t.member, otherProject.body.id, { title: 'Mine elsewhere' });
  await createComment(t.member, mine.id, 'mine too');
  const seen = await audit(t.member, '/v1/users/me/audit');
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((e) => (e.actor.type === 'api_key' ? e.api_key_id === t.member.keyId : e.actor.id === t.member.id)), 'only my actions');
  assert.ok(seen.some((e) => e.resource.id === elsewhere.id), 'across workspaces');
  await deleteOk(t.owner, `/v1/workspaces/${other.id}/members/${t.member.id}`);
  const after = await audit(t.member, '/v1/users/me/audit');
  assert.ok(!after.some((e) => e.workspace_id === other.id), 'entries of a workspace I left disappear');
  assert.ok(after.some((e) => e.resource.id === mine.id));
});

test('[CR3-9] every mutating response carries a distinct X-Request-Id', async () => {
  const t = await auditTeam();
  const task = await createTask(t.owner, t.project.id);
  const calls: [string, () => Promise<ApiResponse>][] = [
    ['register', () => anonymous().post('/v1/users', { email: uniqueEmail('rid'), name: 'Rid' })],
    ['api key', () => t.owner.client.post('/v1/users/me/api-keys', { name: 'ci' })],
    ['user patch', () => t.owner.client.patch('/v1/users/me', { name: 'Ana B' })],
    ['task patch', () => t.owner.client.patch(`/v1/tasks/${task.id}`, { title: 'Rid' })],
    ['comment', () => t.owner.client.post(`/v1/tasks/${task.id}/comments`, { body: 'rid' })],
    ['org patch', () => t.owner.client.patch(`/v1/organizations/${t.org.id}`, { name: uniqueName('Rid Org') })],
    ['task delete', () => t.owner.client.delete(`/v1/tasks/${task.id}`)],
  ];
  const seen: string[] = [];
  for (const [label, call] of calls) {
    const res = await call();
    assert.ok(res.status >= 200 && res.status < 300, `${label}: ${res.status}`);
    seen.push(requestId(res));
  }
  assertUnique(seen, 'request ids');
});

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)];
}

test('[CR3-9] task POST and PATCH stay within 150 ms at p99 with auditing enabled', async () => {
  const t = await auditTeam();
  const creates: number[] = [];
  const patches: number[] = [];
  for (let i = 0; i < 200; i += 1) {
    const res = await t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, { title: `Timed ${i}` });
    expectStatus(res, 201);
    creates.push(res.durationMs);
    const patch = await t.owner.client.patch(`/v1/tasks/${res.body.id}`, { status: 'in_progress' });
    expectStatus(patch, 200);
    patches.push(patch.durationMs);
  }
  assert.ok(p99(creates) < 150, `POST p99 ${p99(creates).toFixed(1)} ms`);
  assert.ok(p99(patches) < 150, `PATCH p99 ${p99(patches).toFixed(1)} ms`);
  const created = await workspaceAudit(t.owner, t.ws.id, { resource_type: 'task', action: 'create' });
  assert.equal(created.length, 200);
});
