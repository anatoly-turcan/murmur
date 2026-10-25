import assert from 'node:assert/strict';
import { expectError, expectRateLimitHeaders, expectStatus } from '../lib/assert.ts';
import { setClock } from '../lib/clock.ts';
import { Client, type ApiResponse, type Json } from '../lib/client.ts';
import { crTest } from '../lib/cr.ts';
import { addMember, createProject, createTask, registerUser, registerUsers, uniqueEmail, type User } from '../lib/fixtures.ts';
import type { Id } from '../lib/ids.ts';
import { addOrgMember, createOrg, createWorkspaceIn, setPlan } from '../lib/orgs.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

const test = crTest('CR-1');

freshDatabaseEachTest();

function expectPlanLimit(res: ApiResponse, limit: number): void {
  expectError(res, 422, 'validation_failed');
  const first = res.body.error.details[0];
  assert.equal(first.code, 'plan_limit_exceeded', `details[0].code: ${res.text}`);
  assert.equal(first.limit, limit, `details[0].limit: ${res.text}`);
}

async function orgWorkspaces(user: User, orgId: Id): Promise<Json[]> {
  return (await user.client.pageAll(`/v1/organizations/${orgId}/workspaces`, { limit: 100 })).items;
}

async function workspaceMembers(user: User, wsId: Id): Promise<Json[]> {
  return (await user.client.pageAll(`/v1/workspaces/${wsId}/members`, { limit: 100 })).items;
}

async function webhookCount(user: User, wsId: Id): Promise<number> {
  return (await user.client.pageAll(`/v1/workspaces/${wsId}/webhooks`, { limit: 100 })).items.length;
}

function postMember(owner: User, wsId: Id, user: User): Promise<ApiResponse> {
  return owner.client.post(`/v1/workspaces/${wsId}/members`, { email: user.email, role: 'member' });
}

function postHook(owner: User, wsId: Id, i: number): Promise<ApiResponse> {
  return owner.client.post(`/v1/workspaces/${wsId}/webhooks`, { url: `http://127.0.0.1:9/limit-${i}`, events: ['task.created'] });
}

test('[CR1-2] a free org rejects a 4th workspace with plan_limit_exceeded; billing upgrades to team and it succeeds', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const bill = await registerUser({ name: 'Bill' });
  const adm = await registerUser({ name: 'Adam' });
  const org = await createOrg(ana);
  await addOrgMember(ana, org.id, bill, 'billing');
  await addOrgMember(ana, org.id, adm, 'org_admin');
  for (let i = 0; i < 3; i += 1) await createWorkspaceIn(ana, org.id);
  const fourth = { name: 'Fourth', organization_id: org.id };
  expectPlanLimit(await ana.client.post('/v1/workspaces', fourth), 3);
  assert.equal((await orgWorkspaces(ana, org.id)).length, 3, 'the rejected request created nothing');
  expectError(await adm.client.patch(`/v1/organizations/${org.id}`, { plan: 'team' }), 403, 'forbidden');
  expectPlanLimit(await ana.client.post('/v1/workspaces', fourth), 3);
  await setPlan(bill, org.id, 'team');
  expectStatus(await ana.client.post('/v1/workspaces', fourth), 201);
  assert.equal((await orgWorkspaces(ana, org.id)).length, 4);
});

test('[CR1-L] free plan: the 11th workspace member and the 3rd webhook are rejected', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const org = await createOrg(ana);
  const ws = await createWorkspaceIn(ana, org.id);
  const people = await registerUsers(10, { name: 'Joiner' });
  for (const u of people.slice(0, 9)) await addMember(ana, ws.id, u, 'member');
  assert.equal((await workspaceMembers(ana, ws.id)).length, 10, 'owner plus nine members');
  expectPlanLimit(await postMember(ana, ws.id, people[9]), 10);
  assert.equal((await workspaceMembers(ana, ws.id)).length, 10);
  for (let i = 0; i < 2; i += 1) expectStatus(await postHook(ana, ws.id, i), 201);
  expectPlanLimit(await postHook(ana, ws.id, 2), 2);
  assert.equal(await webhookCount(ana, ws.id), 2);
});

test('[CR1-L] lowering a plan deletes nothing and only blocks further growth', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const org = await createOrg(ana);
  await setPlan(ana, org.id, 'team');
  const spaces: Json[] = [];
  for (let i = 0; i < 4; i += 1) spaces.push(await createWorkspaceIn(ana, org.id));
  const ws = spaces[0];
  const people = await registerUsers(11, { name: 'Crowd' });
  for (const u of people.slice(0, 10)) await addMember(ana, ws.id, u, 'member');
  for (let i = 0; i < 3; i += 1) expectStatus(await postHook(ana, ws.id, i), 201);
  const project = await createProject(ana, ws.id);
  const task = await createTask(ana, project.id, { assignee_id: people[0].id });

  const lowered = await setPlan(ana, org.id, 'free');
  assert.equal(lowered.limits.max_workspaces, 3);
  assert.equal((await orgWorkspaces(ana, org.id)).length, 4);
  assert.equal((await workspaceMembers(ana, ws.id)).length, 11);
  assert.equal(await webhookCount(ana, ws.id), 3);
  expectStatus(await ana.client.get(`/v1/tasks/${task.id}`), 200);
  expectPlanLimit(await ana.client.post('/v1/workspaces', { name: 'Fifth', organization_id: org.id }), 3);
  expectPlanLimit(await postMember(ana, ws.id, people[10]), 10);
  expectPlanLimit(await postHook(ana, ws.id, 3), 2);
  expectStatus(await ana.client.patch(`/v1/tasks/${task.id}`, { title: 'Still editable' }), 200);
});

// SPEC 6.8 windows: freezing at :00 makes Retry-After 60.
test('[CR1-6] 301 workspace-scoped requests by different keys in one org and minute yield exactly one 429', async () => {
  await setClock('2026-06-01T09:59:00Z');
  const ana = await registerUser({ name: 'Ana' });
  const org = await createOrg(ana);
  const w1 = await createWorkspaceIn(ana, org.id);
  const w2 = await createWorkspaceIn(ana, org.id);
  const others = await registerUsers(4, { name: 'Caller' });
  await addMember(ana, w1.id, others[0], 'member');
  await addMember(ana, w1.id, others[1], 'member');
  await addMember(ana, w2.id, others[2], 'member');
  await addMember(ana, w2.id, others[3], 'member');
  const t1 = await createTask(ana, (await createProject(ana, w1.id)).id);
  const t2 = await createTask(ana, (await createProject(ana, w2.id)).id);
  const streams: [Client, Id][] = [
    [new Client(ana.key), t1.id],
    [new Client(ana.key), t2.id],
    [new Client(others[0].key), t1.id],
    [new Client(others[1].key), t1.id],
    [new Client(others[2].key), t2.id],
    [new Client(others[3].key), t2.id],
  ];
  await setClock('2026-06-01T10:00:00Z');
  const results: ApiResponse[] = [];
  for (let i = 0; i < 301; i += 20) {
    const batch = Array.from({ length: Math.min(20, 301 - i) }, (_, j) => {
      const [client, taskId] = streams[(i + j) % streams.length];

      return client.get(`/v1/tasks/${taskId}`);
    });
    results.push(...(await Promise.all(batch)));
  }
  const limited = results.filter((r) => r.status === 429);
  assert.equal(results.filter((r) => r.status === 200).length, 300, `statuses: ${JSON.stringify(results.map((r) => r.status))}`);
  assert.equal(limited.length, 1);
  expectError(limited[0], 429, 'rate_limited');
  assert.equal(limited[0].headers.get('retry-after'), '60');
  const h = expectRateLimitHeaders(limited[0]);
  assert.equal(h.limit, 300, 'RateLimit-Limit reports the organization bucket');
  assert.equal(h.remaining, 0);
  const outside = await registerUser({ name: 'Elsewhere', email: uniqueEmail('elsewhere') });
  const otherOrg = await createOrg(outside);
  const ws = await createWorkspaceIn(outside, otherOrg.id);
  expectStatus(await outside.client.get(`/v1/workspaces/${ws.id}`), 200, 'another organization has its own bucket');
});
