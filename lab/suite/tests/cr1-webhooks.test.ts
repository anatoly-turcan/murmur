import assert from 'node:assert/strict';
import { expectStatus } from '../lib/assert.ts';
import { advance, setClock } from '../lib/clock.ts';
import type { Json } from '../lib/client.ts';
import { crTest } from '../lib/cr.ts';
import { addMember, createProject, createTask, need, registerUser, type User } from '../lib/fixtures.ts';
import { addOrgMember, createOrg, createWorkspaceIn } from '../lib/orgs.ts';
import { assertSigned, fail, ok, startReceiver, type Receiver } from '../lib/receiver.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drainAll, emails, tickAndDrain } from '../lib/testmode.ts';

const test = crTest('CR-1');

freshDatabaseEachTest();

async function orgHook(t: { after: (fn: () => unknown) => void }, owner: User, orgId: Json, events: string[], receiver?: Receiver): Promise<{ hook: Json; receiver: Receiver }> {
  const r = receiver ?? (await startReceiver(ok()));
  t.after(() => r.close());
  const hook = need(await owner.client.post(`/v1/organizations/${orgId}/webhooks`, { url: r.url, events }), 201, 'create org webhook');

  return { hook, receiver: r };
}

test('[CR1-7] an org "*" webhook gets events of two workspaces in global creation order, one delivery in flight', async (t) => {
  await setClock('2026-04-01T10:00:00Z');
  const ana = await registerUser({ name: 'Ana' });
  const org = await createOrg(ana);
  const w1 = await createWorkspaceIn(ana, org.id);
  const w2 = await createWorkspaceIn(ana, org.id);
  const p1 = await createProject(ana, w1.id);
  const p2 = await createProject(ana, w2.id);
  const receiver = await startReceiver((_req, i) => (i === 0 ? fail(500) : ok(40)));
  const { hook } = await orgHook(t, ana, org.id, ['*'], receiver);
  const created: Json[] = [];
  for (let i = 0; i < 6; i += 1) created.push(await createTask(ana, (i % 2 ? p2 : p1).id, { title: `Interleaved ${i}` }));

  await drainAll();
  assert.equal(receiver.requests.length, 1, 'the failed first delivery blocks the endpoint across workspaces');
  await advance(30);
  await drainAll();
  await receiver.waitForCount(7, 15_000);
  const seq = receiver.requests.slice(1).map((r) => [r.json?.workspace_id, r.json?.data?.task?.id]);
  assert.deepEqual(seq, created.map((x, i) => [(i % 2 ? w2 : w1).id, x.id]), 'creation order across workspaces');
  assert.deepEqual(receiver.requests[0].json?.data?.task?.id, created[0].id);
  assert.equal(receiver.maxInFlight, 1, 'one delivery in flight per org endpoint');
  for (let i = 1; i < receiver.requests.length; i += 1) {
    const prev = receiver.requests[i - 1];
    assert.ok(prev.respondedAt !== null && receiver.requests[i].receivedAt >= prev.respondedAt, `request ${i} overlapped request ${i - 1}`);
  }
  if (typeof hook.secret === 'string') for (const r of receiver.requests) assertSigned(hook.secret, r);
});

test('[CR1-7] org webhooks receive org events; workspace events only with "*"', async (t) => {
  const ana = await registerUser({ name: 'Ana' });
  const bo = await registerUser({ name: 'Bo' });
  const cy = await registerUser({ name: 'Cy' });
  const org = await createOrg(ana);
  const ws = await createWorkspaceIn(ana, org.id);
  const project = await createProject(ana, ws.id);
  const star = await orgHook(t, ana, org.id, ['*']);
  const orgOnly = await orgHook(t, ana, org.id, ['org_member.added']);
  await addOrgMember(ana, org.id, bo, 'org_member');
  await createTask(ana, project.id, { title: 'Workspace event' });
  await addOrgMember(ana, org.id, cy, 'org_member');
  await drainAll();
  assert.deepEqual(star.receiver.requests.map((r) => r.json?.event), ['org_member.added', 'task.created', 'org_member.added']);
  assert.deepEqual(orgOnly.receiver.requests.map((r) => r.json?.event), ['org_member.added', 'org_member.added']);
});

test('[CR1-EV] digest data.organizations lists the organizations whose tasks appear', async () => {
  await setClock('2026-06-10T07:30:00Z');
  const ana = await registerUser({ name: 'Ana', timezone: 'UTC' });
  const bo = await registerUser({ name: 'Bo', timezone: 'UTC' });
  const idle = await registerUser({ name: 'Idle', timezone: 'UTC' });
  const org = await createOrg(ana);
  const other = await createOrg(ana);
  const ws = await createWorkspaceIn(ana, org.id);
  await createWorkspaceIn(ana, other.id);
  await addMember(ana, ws.id, bo, 'member');
  await addMember(ana, ws.id, idle, 'member');
  const project = await createProject(ana, ws.id);
  await createTask(ana, project.id, { title: 'Due today', assignee_id: bo.id, due_date: '2026-06-10' });
  await setClock('2026-06-10T08:05:00Z');
  await tickAndDrain();
  const [digest] = await emails({ template: 'daily_digest', to: bo.email });
  assert.ok(digest, 'Bo gets a digest');
  assert.equal(digest.data.due_today.length, 1);
  assert.deepEqual(digest.data.organizations, [{ id: org.id, name: org.name }]);
  const [quiet] = await emails({ template: 'daily_digest', to: idle.email });
  assert.ok(quiet, 'a digest is sent even when empty');
  assert.deepEqual(quiet.data.organizations, [], 'no tasks, no organizations');
  expectStatus(await ana.client.get(`/v1/organizations/${org.id}`), 200);
});
