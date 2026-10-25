import assert from 'node:assert/strict';
import { expectError, expectStatus } from '../lib/assert.ts';
import type { Json } from '../lib/client.ts';
import { crTest } from '../lib/cr.ts';
import { activity, addMember, createProject, createTask, getOk, registerUser, type User } from '../lib/fixtures.ts';
import type { Id } from '../lib/ids.ts';
import { addOrgMember, createOrg, createWorkspaceIn, orgRoleOf } from '../lib/orgs.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

const test = crTest('CR-1');

freshDatabaseEachTest();

interface AccessWorld {
  org: Json;
  ana: User;
  bo: User;
  dee: User;
  w1: Json;
  w2: Json;
  p1: Json;
  p2: Json;
}

// Ana owns the org and both workspaces; Bo is org_admin and in no workspace; Dee is org_member and member of both.
async function accessWorld(): Promise<AccessWorld> {
  const ana = await registerUser({ name: 'Ana' });
  const bo = await registerUser({ name: 'Bo' });
  const dee = await registerUser({ name: 'Dee' });
  const org = await createOrg(ana);
  await addOrgMember(ana, org.id, bo, 'org_admin');
  await addOrgMember(ana, org.id, dee, 'org_member');
  const w1 = await createWorkspaceIn(ana, org.id);
  const w2 = await createWorkspaceIn(ana, org.id);
  await addMember(ana, w1.id, dee, 'member');
  await addMember(ana, w2.id, dee, 'member');
  const p1 = await createProject(ana, w1.id);
  const p2 = await createProject(ana, w2.id);

  return { org, ana, bo, dee, w1, w2, p1, p2 };
}

async function eventIds(user: User, wsId: Id): Promise<Set<Id>> {
  return new Set((await activity(user, wsId)).map((e) => e.id));
}

test('[CR1-3] an org_admin outside workspace W reads its tasks and search but gets 403 on writes', async () => {
  const w = await accessWorld();
  const task = await createTask(w.ana, w.p1.id, { title: 'Invoice export broken' });
  const list = await w.bo.client.get(`/v1/workspaces/${w.w1.id}/tasks`);
  expectStatus(list, 200);
  assert.deepEqual(list.body.data.map((t: Json) => t.id), [task.id]);
  const found = await w.bo.client.get(`/v1/workspaces/${w.w1.id}/search`, { q: 'invoice' });
  expectStatus(found, 200);
  assert.deepEqual(found.body.data.map((r: Json) => r.task.id), [task.id]);
  expectStatus(await w.bo.client.get(`/v1/tasks/${task.id}`), 200);
  expectError(await w.bo.client.patch(`/v1/tasks/${task.id}`, { status: 'done' }), 403, 'forbidden');
  expectError(await w.bo.client.post(`/v1/projects/${w.p1.id}/tasks`, { title: 'Intruder' }), 403, 'forbidden');
  expectError(await w.bo.client.post(`/v1/tasks/${task.id}/comments`, { body: 'Intruder' }), 403, 'forbidden');
  expectError(await w.bo.client.post(`/v1/tasks/${task.id}/claim`), 403, 'forbidden');
  const after = await getOk(w.ana, `/v1/tasks/${task.id}`);
  assert.equal(after.status, 'open');
  assert.equal(after.version, task.version);
});

test('[CR1-3] an org_member outside workspace W gets 404, as a non-member did in v1', async () => {
  const w = await accessWorld();
  const eve = await registerUser({ name: 'Eve' });
  await addOrgMember(w.ana, w.org.id, eve, 'org_member');
  const task = await createTask(w.ana, w.p1.id);
  expectError(await eve.client.get(`/v1/workspaces/${w.w1.id}/tasks`), 404, 'not_found');
  expectError(await eve.client.get(`/v1/tasks/${task.id}`), 404, 'not_found');
  expectError(await eve.client.get(`/v1/workspaces/${w.w1.id}/search`, { q: 'task' }), 404, 'not_found');
});

test('[CR1-4] removing U from the org removes U from every org workspace and unassigns with the remover as actor', async () => {
  const w = await accessWorld();
  const own = await createTask(w.dee, w.p1.id, { title: 'Dee wrote this' });
  const t1 = await createTask(w.ana, w.p1.id, { title: 'W1 assigned', assignee_id: w.dee.id });
  const t2 = await createTask(w.ana, w.p2.id, { title: 'W2 assigned', assignee_id: w.dee.id });
  const t3 = await createTask(w.ana, w.p2.id, { title: 'W2 assigned too', assignee_id: w.dee.id });
  const marks = { w1: await eventIds(w.ana, w.w1.id), w2: await eventIds(w.ana, w.w2.id) };

  expectStatus(await w.bo.client.delete(`/v1/organizations/${w.org.id}/members/${w.dee.id}`), 204);

  expectError(await w.dee.client.get(`/v1/workspaces/${w.w1.id}`), 404, 'not_found');
  expectError(await w.dee.client.get(`/v1/workspaces/${w.w2.id}/tasks`), 404, 'not_found');
  expectError(await w.dee.client.get(`/v1/tasks/${own.id}`), 404, 'not_found');
  expectError(await w.dee.client.get(`/v1/organizations/${w.org.id}`), 404, 'not_found');
  for (const task of [t1, t2, t3]) {
    const now = await getOk(w.ana, `/v1/tasks/${task.id}`);
    assert.equal(now.assignee_id, null, `task ${task.id} unassigned`);
    assert.equal(now.version, task.version + 1);
  }
  for (const [wsId, mark, tasks] of [[w.w1.id, marks.w1, [t1]], [w.w2.id, marks.w2, [t2, t3]]] as [Id, Set<Id>, Json[]][]) {
    const fresh = (await activity(w.ana, wsId)).filter((e) => !mark.has(e.id));
    const updates = fresh.filter((e) => e.type === 'task.updated');
    assert.deepEqual(updates.map((e) => e.target.id).sort(), tasks.map((t) => t.id).sort());
    for (const e of updates) {
      assert.equal(e.actor.id, w.bo.id, 'task.updated is authored by the remover');
      assert.deepEqual(e.changes, { assignee_id: { from: w.dee.id, to: null } });
    }
    const removed = fresh.filter((e) => e.type === 'member.removed');
    assert.equal(removed.length, 1, 'the workspace records the v1 member.removed event');
    assert.deepEqual(removed[0].target, { type: 'member', id: w.dee.id });
    assert.equal(removed[0].actor.id, w.bo.id);
  }
});

test('[CR1-5] removing a user who owns an org workspace is 409 sole_owner listing it, and nothing changes', async () => {
  const w = await accessWorld();
  const owned = await createWorkspaceIn(w.dee, w.org.id);
  const assigned = await createTask(w.ana, w.p1.id, { assignee_id: w.dee.id });
  const marks = await eventIds(w.ana, w.w1.id);
  const res = await w.ana.client.delete(`/v1/organizations/${w.org.id}/members/${w.dee.id}`);
  expectError(res, 409, 'sole_owner');
  const detail = (res.body.error.details ?? []).find((d: Json) => d.code === 'sole_owner');
  assert.ok(detail, `expected a sole_owner detail: ${res.text}`);
  assert.deepEqual(detail.workspace_ids, [owned.id]);

  assert.equal(await orgRoleOf(w.ana, w.org.id, w.dee), 'org_member');
  expectStatus(await w.dee.client.get(`/v1/workspaces/${w.w1.id}`), 200);
  expectStatus(await w.dee.client.get(`/v1/workspaces/${w.w2.id}`), 200);
  assert.equal((await getOk(w.dee, `/v1/workspaces/${owned.id}`)).owner_id, w.dee.id);
  const task = await getOk(w.ana, `/v1/tasks/${assigned.id}`);
  assert.equal(task.assignee_id, w.dee.id);
  assert.equal(task.version, assigned.version);
  const fresh = (await activity(w.ana, w.w1.id)).filter((e) => !marks.has(e.id));
  assert.deepEqual(fresh, [], 'a rejected removal records no events');
});
