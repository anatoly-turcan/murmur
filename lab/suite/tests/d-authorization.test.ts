import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus } from '../lib/assert.ts';
import { Client, type ApiResponse, type Json } from '../lib/client.ts';
import { ENDPOINTS, fill, fillBody, label, objectWorld, slots, type ObjectWorld } from '../lib/endpoints.ts';
import { compareIds, type Id } from '../lib/ids.ts';
import {
  activity,
  createComment,
  createProject,
  createTask,
  createWebhook,
  createWorkspace,
  deleteOk,
  getOk,
  need,
  registerUser,
  team,
  type Team,
  type User,
} from '../lib/fixtures.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

function normalised(res: ApiResponse): string {
  return JSON.stringify(res.body).replace(/\d+/g, 'N');
}

async function versions(w: ObjectWorld): Promise<Json> {
  const { owner, ids } = w;
  const ws = await getOk(owner, `/v1/workspaces/${ids.ws}`);
  const project = await getOk(owner, `/v1/projects/${ids.project}`);
  const task = await getOk(owner, `/v1/tasks/${ids.task}`);
  const comment = await getOk(owner, `/v1/comments/${ids.comment}`);
  const hook = await getOk(owner, `/v1/webhooks/${ids.webhook}`);
  const members = await owner.client.pageAll(`/v1/workspaces/${ids.ws}/members`);
  const projects = await owner.client.pageAll(`/v1/workspaces/${ids.ws}/projects`);

  return {
    ws: [ws.version, ws.name, ws.owner_id],
    project: [project.version, project.name],
    task: [task.version, task.title, task.assignee_id],
    comment: [comment.version, comment.body],
    hook: [hook.active, hook.updated_at],
    members: members.items.map((m) => [m.user.id, m.role]),
    projects: projects.items.map((p) => p.id),
  };
}

// SPEC 5.1: a non-member gets 404, indistinguishable from a nonexistent object, and nothing changes.
for (const endpoint of ENDPOINTS.filter((e) => e.workspaceScoped)) {
  test(`[D1] non-member ${label(endpoint)} → 404 indistinguishable from nonexistent`, async () => {
    const w = await objectWorld();
    const before = await versions(w);
    const body = fillBody(endpoint.body, w.outsider);
    const real = await w.outsider.client.request(endpoint.method, fill(endpoint.path, w.ids), { body });
    const ghost = await w.outsider.client.request(endpoint.method, fill(endpoint.path, {}), { body });
    expectError(ghost, 404, 'not_found');
    expectError(real, 404, 'not_found');
    assert.equal(normalised(real), normalised(ghost), 'non-member response must equal the nonexistent-object response');
    assert.ok(slots(endpoint.path).length > 0);
    assert.deepEqual(await versions(w), before, 'a rejected non-member request must not change anything');
  });
}

test('[D1] former member gets 404 for the task and comment they created', async () => {
  const w = await objectWorld();
  await deleteOk(w.owner, `/v1/workspaces/${w.ids.ws}/members/${w.member.id}`);
  for (const path of [`/v1/tasks/${w.ids.task}`, `/v1/comments/${w.ids.comment}`, `/v1/projects/${w.ids.project}`, `/v1/workspaces/${w.ids.ws}`]) {
    expectError(await w.member.client.get(path), 404, 'not_found');
  }
  expectError(await w.member.client.get(`/v1/workspaces/${w.ids.ws}/search`, { q: 'login' }), 404, 'not_found');
  expectError(await w.member.client.patch(`/v1/comments/${w.ids.comment}`, { body: 'mine' }), 404, 'not_found');
});

test('[D1] GET /v1/users/{id} is visible only while a non-deleted workspace is shared', async () => {
  const w = await objectWorld();
  const shared = await w.owner.client.get(`/v1/users/${w.member.id}`);
  expectStatus(shared, 200);
  assert.deepEqual(Object.keys(shared.body).sort(), ['created_at', 'id', 'name']);
  assert.equal(shared.body.name, 'Bo');
  expectError(await w.outsider.client.get(`/v1/users/${w.member.id}`), 404, 'not_found');
  expectStatus(await w.outsider.client.get(`/v1/users/${w.outsider.id}`), 200);
  await deleteOk(w.owner, `/v1/workspaces/${w.ids.ws}`);
  expectError(await w.owner.client.get(`/v1/users/${w.member.id}`), 404, 'not_found');
});

async function assignedTo(t: Team, user: User, n: number): Promise<Json[]> {
  const tasks: Json[] = [];
  for (let i = 0; i < n; i += 1) tasks.push(await createTask(t.owner, t.project.id, { title: `Assigned ${i}`, assignee_id: user.id }));

  return tasks;
}

async function expectUnassigned(t: Team, tasks: Json[], actor: User, seenEvents: Set<Id>, user: User): Promise<Json[]> {
  for (const task of tasks) {
    const now = await getOk(t.owner, `/v1/tasks/${task.id}`);
    assert.equal(now.assignee_id, null, `task ${task.id} must be unassigned`);
    assert.equal(now.version, task.version + 1, `task ${task.id} version must increase by exactly one`);
  }
  const fresh = (await activity(t.owner, t.ws.id)).filter((e) => !seenEvents.has(e.id));
  const updates = fresh.filter((e) => e.type === 'task.updated');
  assert.deepEqual(updates.map((e) => e.target.id).sort(), tasks.map((x) => x.id).sort());
  for (const e of updates) {
    assert.equal(e.actor.id, actor.id, 'unassignment events carry the remover as actor');
    assert.deepEqual(e.changes, { assignee_id: { from: user.id, to: null } });
  }

  return fresh;
}

async function eventMark(t: Team): Promise<Set<Id>> {
  return new Set((await activity(t.owner, t.ws.id)).map((e) => e.id));
}

test('[D2] removing a member is immediate and unassigns their tasks with events by the remover', async () => {
  const t = await team({ members: 1 });
  const bo = t.member;
  const own = await createTask(bo, t.project.id, { title: 'Bo created this' });
  const tasks = await assignedTo(t, bo, 3);
  const mark = await eventMark(t);
  await deleteOk(t.admin, `/v1/workspaces/${t.ws.id}/members/${bo.id}`);
  expectError(await bo.client.get(`/v1/tasks/${own.id}`), 404, 'not_found');
  expectError(await bo.client.get(`/v1/workspaces/${t.ws.id}`), 404, 'not_found');
  const fresh = await expectUnassigned(t, tasks, t.admin, mark, bo);
  assert.deepEqual(fresh.map((e) => e.type).sort(), ['member.removed', 'task.updated', 'task.updated', 'task.updated']);
  const removed = fresh.find((e) => e.type === 'member.removed');
  assert.deepEqual(removed.target, { type: 'member', id: bo.id });
});

test('[D2] demoting a member to viewer unassigns their tasks', async () => {
  const t = await team({ members: 1 });
  const cy = t.member;
  const tasks = await assignedTo(t, cy, 2);
  const mark = await eventMark(t);
  const res = await t.admin.client.patch(`/v1/workspaces/${t.ws.id}/members/${cy.id}`, { role: 'viewer' });
  expectStatus(res, 200);
  assert.equal(res.body.role, 'viewer');
  const fresh = await expectUnassigned(t, tasks, t.admin, mark, cy);
  assert.deepEqual(fresh.map((e) => e.type).sort(), ['member.role_changed', 'task.updated', 'task.updated']);
  expectStatus(await cy.client.get(`/v1/tasks/${tasks[0].id}`), 200);
});

test('[D2] leaving the workspace is immediate and unassigns with the leaver as actor', async () => {
  const t = await team({ members: 1 });
  const bo = t.member;
  const tasks = await assignedTo(t, bo, 2);
  const mark = await eventMark(t);
  await deleteOk(bo, `/v1/workspaces/${t.ws.id}/members/${bo.id}`);
  expectError(await bo.client.get(`/v1/tasks/${tasks[0].id}`), 404, 'not_found');
  await expectUnassigned(t, tasks, bo, mark, bo);
});

test('[D2] deactivation removes memberships and unassigns, actor shown as Deleted user', async () => {
  const t = await team({ members: 1 });
  const bo = t.member;
  const tasks = await assignedTo(t, bo, 2);
  const mark = await eventMark(t);
  expectStatus(await bo.client.delete('/v1/users/me'), 204);
  const fresh = await expectUnassigned(t, tasks, bo, mark, bo);
  for (const e of fresh.filter((x) => x.type === 'task.updated')) {
    assert.deepEqual(e.actor, { id: bo.id, name: 'Deleted user', deleted: true });
  }
  assert.ok(fresh.some((e) => e.type === 'member.removed' && e.target.id === bo.id), 'member.removed expected');
  const members = await t.owner.client.pageAll(`/v1/workspaces/${t.ws.id}/members`);
  assert.ok(!members.items.some((m) => m.user.id === bo.id));
});

test('[D2] concurrent assignment and removal never leave a non-member assignee', async () => {
  const t = await team({ members: 1 });
  const bo = t.member;
  const tasks: Json[] = [];
  for (let i = 0; i < 20; i += 1) tasks.push(await createTask(t.owner, t.project.id, { title: `Race ${i}` }));
  const results = await Promise.all([
    ...tasks.map((task) => t.admin.client.patch(`/v1/tasks/${task.id}`, { assignee_id: bo.id })),
    t.owner.client.delete(`/v1/workspaces/${t.ws.id}/members/${bo.id}`),
  ]);
  const removal = results.pop()!;
  expectStatus(removal, 204);
  for (const r of results) {
    if (r.status !== 200) expectError(r, 422, 'validation_failed', { path: 'assignee_id', code: 'not_assignable' });
  }
  const all = await t.owner.client.pageAll(`/v1/workspaces/${t.ws.id}/tasks`, { limit: 100 });
  const stuck = all.items.filter((x) => x.assignee_id === bo.id).map((x) => x.id);
  assert.deepEqual(stuck, [], 'no task may stay assigned to a removed member (SPEC 3.11 #2)');
});

interface RoleWorld extends Team {
  admin2: User;
  member2: User;
  task: Json;
}

async function roles(): Promise<RoleWorld> {
  const t = await team({ admins: 2, members: 2, viewers: 1 });
  const task = await createTask(t.owner, t.project.id, { title: 'Owner task' });

  return { ...t, admin2: t.admins[1], member2: t.members[1], task };
}

async function expectRoleStatus(cases: [string, User, () => Promise<ApiResponse>, number | number[]][]): Promise<void> {
  const failures: string[] = [];
  for (const [who, , call, expected] of cases) {
    const res = await call();
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(res.status)) failures.push(`${who}: expected ${allowed.join('|')}, got ${res.status} ${res.text.slice(0, 200)}`);
    else if (res.status === 403 && res.body?.error?.code !== 'forbidden') failures.push(`${who}: 403 must carry code forbidden`);
  }
  assert.deepEqual(failures, []);
}

test('[D3] every role can read workspace, members, projects, tasks, comments, activity, summary, search', async () => {
  const w = await roles();
  const comment = await createComment(w.owner, w.task.id, 'login comment');
  const paths = [
    `/v1/workspaces/${w.ws.id}`,
    `/v1/workspaces/${w.ws.id}/members`,
    `/v1/workspaces/${w.ws.id}/projects`,
    `/v1/projects/${w.project.id}`,
    `/v1/projects/${w.project.id}/tasks`,
    `/v1/workspaces/${w.ws.id}/tasks`,
    `/v1/tasks/${w.task.id}`,
    `/v1/tasks/${w.task.id}/comments`,
    `/v1/comments/${comment.id}`,
    `/v1/workspaces/${w.ws.id}/activity`,
    `/v1/projects/${w.project.id}/summary`,
    `/v1/workspaces/${w.ws.id}/search?q=login`,
  ];
  for (const user of [w.owner, w.admin, w.member, w.viewer]) {
    for (const path of paths) expectStatus(await user.client.get(path), 200, `${user.name} GET ${path}`);
  }
  const roleOf = async (u: User) => (await getOk(u, `/v1/workspaces/${w.ws.id}`)).my_role;
  assert.deepEqual(await Promise.all([w.owner, w.admin, w.member, w.viewer].map(roleOf)), ['owner', 'admin', 'member', 'viewer']);
});

test('[D3] update workspace: owner and admin yes, member and viewer 403', async () => {
  const w = await roles();
  const patch = (u: User, name: string) => () => u.client.patch(`/v1/workspaces/${w.ws.id}`, { name });
  await expectRoleStatus([
    ['owner', w.owner, patch(w.owner, 'Renamed by owner'), 200],
    ['admin', w.admin, patch(w.admin, 'Renamed by admin'), 200],
    ['member', w.member, patch(w.member, 'Nope'), 403],
    ['viewer', w.viewer, patch(w.viewer, 'Nope'), 403],
  ]);
});

test('[D3] delete and restore workspace: owner only', async () => {
  const w = await roles();
  const del = (u: User) => () => u.client.delete(`/v1/workspaces/${w.ws.id}`);
  const restore = (u: User) => () => u.client.post(`/v1/workspaces/${w.ws.id}/restore`);
  await expectRoleStatus([
    ['admin delete', w.admin, del(w.admin), 403],
    ['member delete', w.member, del(w.member), 403],
    ['viewer delete', w.viewer, del(w.viewer), 403],
    ['admin restore (not deleted)', w.admin, restore(w.admin), 403],
    ['owner delete', w.owner, del(w.owner), 204],
    ['admin restore', w.admin, restore(w.admin), 403],
    ['member restore', w.member, restore(w.member), 403],
    ['owner restore', w.owner, restore(w.owner), 200],
  ]);
});

test('[D3] transfer ownership: owner only', async () => {
  const w = await roles();
  const transfer = (u: User) => () => u.client.post(`/v1/workspaces/${w.ws.id}/transfer-ownership`, { user_id: w.member2.id });
  await expectRoleStatus([
    ['admin', w.admin, transfer(w.admin), 403],
    ['member', w.member, transfer(w.member), 403],
    ['viewer', w.viewer, transfer(w.viewer), 403],
    ['owner', w.owner, transfer(w.owner), 200],
  ]);
});

test('[D3] add members: admin may add member/viewer but not admin; member and viewer 403', async () => {
  const w = await roles();
  const fresh = await Promise.all(Array.from({ length: 6 }, () => registerUser()));
  const add = (u: User, target: User, role: string) => () => u.client.post(`/v1/workspaces/${w.ws.id}/members`, { email: target.email, role });
  await expectRoleStatus([
    ['owner adds member', w.owner, add(w.owner, fresh[0], 'member'), 201],
    ['admin adds member', w.admin, add(w.admin, fresh[1], 'member'), 201],
    ['admin adds viewer', w.admin, add(w.admin, fresh[2], 'viewer'), 201],
    ['admin adds admin', w.admin, add(w.admin, fresh[3], 'admin'), 403],
    ['member adds member', w.member, add(w.member, fresh[4], 'member'), 403],
    ['viewer adds viewer', w.viewer, add(w.viewer, fresh[5], 'viewer'), 403],
    ['owner adds admin', w.owner, add(w.owner, fresh[3], 'admin'), 201],
  ]);
});

test('[D3] change roles: admins only among member/viewer; owner may promote and demote admins', async () => {
  const w = await roles();
  const role = (u: User, target: User, r: string) => () => u.client.patch(`/v1/workspaces/${w.ws.id}/members/${target.id}`, { role: r });
  await expectRoleStatus([
    ['owner member→viewer', w.owner, role(w.owner, w.member2, 'viewer'), 200],
    ['admin viewer→member', w.admin, role(w.admin, w.member2, 'member'), 200],
    ['member changes member', w.member, role(w.member, w.member2, 'viewer'), 403],
    ['viewer changes member', w.viewer, role(w.viewer, w.member2, 'viewer'), 403],
    ['admin promotes to admin', w.admin, role(w.admin, w.member2, 'admin'), 403],
    ['admin demotes admin', w.admin, role(w.admin, w.admin2, 'member'), 403],
    ['admin changes owner', w.admin, role(w.admin, w.owner, 'member'), 403],
    ['owner changes own role', w.owner, role(w.owner, w.owner, 'admin'), 409],
    ['owner promotes', w.owner, role(w.owner, w.member2, 'admin'), 200],
    ['owner demotes admin', w.owner, role(w.owner, w.admin2, 'member'), 200],
  ]);
  const members = await w.owner.client.pageAll(`/v1/workspaces/${w.ws.id}/members`);
  const byId = new Map(members.items.map((m) => [m.user.id, m.role]));
  assert.equal(byId.get(w.member2.id), 'admin');
  assert.equal(byId.get(w.admin2.id), 'member');
  assert.equal(byId.get(w.owner.id), 'owner');
});

test('[D3] remove members: admin removes members but not admins or the owner', async () => {
  const w = await roles();
  const remove = (u: User, target: User) => () => u.client.delete(`/v1/workspaces/${w.ws.id}/members/${target.id}`);
  await expectRoleStatus([
    ['member removes member', w.member, remove(w.member, w.member2), 403],
    ['viewer removes member', w.viewer, remove(w.viewer, w.member2), 403],
    ['admin removes admin', w.admin, remove(w.admin, w.admin2), 403],
    ['admin removes owner', w.admin, remove(w.admin, w.owner), 403],
    ['admin removes member', w.admin, remove(w.admin, w.member2), 204],
    ['owner removes admin', w.owner, remove(w.owner, w.admin2), 204],
  ]);
});

test('[D3] leaving: admin, member and viewer may leave; the owner gets 409 sole_owner', async () => {
  const w = await roles();
  const leave = (u: User) => () => u.client.delete(`/v1/workspaces/${w.ws.id}/members/${u.id}`);
  await expectRoleStatus([
    ['admin', w.admin, leave(w.admin), 204],
    ['member', w.member, leave(w.member), 204],
    ['viewer', w.viewer, leave(w.viewer), 204],
  ]);
  expectError(await w.owner.client.delete(`/v1/workspaces/${w.ws.id}/members/${w.owner.id}`), 409, 'sole_owner');
});

test('[D3] projects: member+ create and update; admin+ delete and restore; viewer nothing', async () => {
  const w = await roles();
  const create = (u: User) => () => u.client.post(`/v1/workspaces/${w.ws.id}/projects`, { name: `By ${u.name}` });
  const update = (u: User) => () => u.client.patch(`/v1/projects/${w.project.id}`, { description: `by ${u.name}` });
  const del = (u: User, id: number) => () => u.client.delete(`/v1/projects/${id}`);
  const restore = (u: User, id: number) => () => u.client.post(`/v1/projects/${id}/restore`);
  const p2 = await createProject(w.member, w.ws.id, { name: 'Member project' });
  await expectRoleStatus([
    ['owner create', w.owner, create(w.owner), 201],
    ['admin create', w.admin, create(w.admin), 201],
    ['member create', w.member, create(w.member), 201],
    ['viewer create', w.viewer, create(w.viewer), 403],
    ['owner update', w.owner, update(w.owner), 200],
    ['admin update', w.admin, update(w.admin), 200],
    ['member update', w.member, update(w.member), 200],
    ['viewer update', w.viewer, update(w.viewer), 403],
    ['member deletes own project', w.member, del(w.member, p2.id), 403],
    ['viewer delete', w.viewer, del(w.viewer, p2.id), 403],
    ['admin delete', w.admin, del(w.admin, p2.id), 204],
    ['member restore', w.member, restore(w.member, p2.id), 403],
    ['viewer restore', w.viewer, restore(w.viewer, p2.id), 403],
    ['admin restore', w.admin, restore(w.admin, p2.id), 200],
    ['owner delete', w.owner, del(w.owner, p2.id), 204],
    ['owner restore', w.owner, restore(w.owner, p2.id), 200],
  ]);
});

test('[D3] tasks: member+ create, update any field and claim; viewer 403', async () => {
  const w = await roles();
  const create = (u: User) => () => u.client.post(`/v1/projects/${w.project.id}/tasks`, { title: `By ${u.name}` });
  const update = (u: User) => () => u.client.patch(`/v1/tasks/${w.task.id}`, { labels: [u.name.replace(/\s+/g, '-').slice(0, 40)], estimate_minutes: 5 });
  const t2 = await createTask(w.owner, w.project.id, { title: 'Claim me' });
  const t3 = await createTask(w.owner, w.project.id, { title: 'Claim me too' });
  await expectRoleStatus([
    ['owner create', w.owner, create(w.owner), 201],
    ['admin create', w.admin, create(w.admin), 201],
    ['member create', w.member, create(w.member), 201],
    ['viewer create', w.viewer, create(w.viewer), 403],
    ['owner update', w.owner, update(w.owner), 200],
    ['admin update', w.admin, update(w.admin), 200],
    ['member updates owner task', w.member, update(w.member), 200],
    ['viewer update', w.viewer, update(w.viewer), 403],
    ['viewer claim', w.viewer, () => w.viewer.client.post(`/v1/tasks/${t2.id}/claim`), 403],
    ['member claim', w.member, () => w.member.client.post(`/v1/tasks/${t2.id}/claim`), 200],
    ['admin claim', w.admin, () => w.admin.client.post(`/v1/tasks/${t3.id}/claim`), 200],
  ]);
});

test('[D3] delete task: member only as creator or assignee; admin and owner any; viewer 403', async () => {
  const w = await roles();
  const byOwner = await createTask(w.owner, w.project.id, { title: 'Owner made' });
  const byMember = await createTask(w.member, w.project.id, { title: 'Member made' });
  const assignedToMember = await createTask(w.owner, w.project.id, { title: 'Member assigned', assignee_id: w.member.id });
  const forAdmin = await createTask(w.member2, w.project.id, { title: 'Admin deletes' });
  const forOwner = await createTask(w.member2, w.project.id, { title: 'Owner deletes' });
  const del = (u: User, id: number) => () => u.client.delete(`/v1/tasks/${id}`);
  await expectRoleStatus([
    ['member, neither creator nor assignee', w.member, del(w.member, byOwner.id), 403],
    ['viewer', w.viewer, del(w.viewer, byOwner.id), 403],
    ['member creator', w.member, del(w.member, byMember.id), 204],
    ['member assignee', w.member, del(w.member, assignedToMember.id), 204],
    ['admin', w.admin, del(w.admin, forAdmin.id), 204],
    ['owner', w.owner, del(w.owner, forOwner.id), 204],
  ]);
  const restore = (u: User, id: number) => () => u.client.post(`/v1/tasks/${id}/restore`);
  await expectRoleStatus([
    ['member2 restores member task', w.member2, restore(w.member2, byMember.id), 403],
    ['viewer restores', w.viewer, restore(w.viewer, byMember.id), 403],
    ['member creator restores', w.member, restore(w.member, byMember.id), 200],
    ['member assignee restores', w.member, restore(w.member, assignedToMember.id), 200],
    ['admin restores', w.admin, restore(w.admin, forAdmin.id), 200],
  ]);
});

test('[D3] assignment: owner, admin and member can be assigned; viewer is not assignable', async () => {
  const w = await roles();
  for (const u of [w.owner, w.admin, w.member]) {
    const res = await w.admin.client.patch(`/v1/tasks/${w.task.id}`, { assignee_id: u.id });
    expectStatus(res, 200, `assign ${u.name}`);
    assert.equal(res.body.assignee_id, u.id);
  }
  const viewer = await w.admin.client.patch(`/v1/tasks/${w.task.id}`, { assignee_id: w.viewer.id });
  expectError(viewer, 422, 'validation_failed', { path: 'assignee_id', code: 'not_assignable' });
});

test('[D3] comments: viewer cannot comment; only the author edits, even the owner cannot', async () => {
  const w = await roles();
  expectError(await w.viewer.client.post(`/v1/tasks/${w.task.id}/comments`, { body: 'no' }), 403, 'forbidden');
  const c = await createComment(w.member, w.task.id, 'member wrote this');
  const edit = (u: User) => () => u.client.patch(`/v1/comments/${c.id}`, { body: `edited by ${u.name}` });
  await expectRoleStatus([
    ['owner edits member comment', w.owner, edit(w.owner), 403],
    ['admin edits member comment', w.admin, edit(w.admin), 403],
    ['member2 edits member comment', w.member2, edit(w.member2), 403],
    ['viewer edits', w.viewer, edit(w.viewer), 403],
    ['author edits', w.member, edit(w.member), 200],
  ]);
  for (const u of [w.owner, w.admin]) expectStatus(await u.client.post(`/v1/tasks/${w.task.id}/comments`, { body: 'ok' }), 201);
});

test('[D3] delete and restore comments: admin+ any, member only own, viewer none', async () => {
  const w = await roles();
  const c1 = await createComment(w.member, w.task.id, 'one');
  const c2 = await createComment(w.member, w.task.id, 'two');
  const c3 = await createComment(w.member2, w.task.id, 'three');
  const del = (u: User, id: number) => () => u.client.delete(`/v1/comments/${id}`);
  const restore = (u: User, id: number) => () => u.client.post(`/v1/comments/${id}/restore`);
  await expectRoleStatus([
    ['member2 deletes member comment', w.member2, del(w.member2, c1.id), 403],
    ['viewer deletes', w.viewer, del(w.viewer, c1.id), 403],
    ['author deletes', w.member, del(w.member, c1.id), 204],
    ['member2 restores member comment', w.member2, restore(w.member2, c1.id), 403],
    ['author restores', w.member, restore(w.member, c1.id), 200],
    ['admin deletes member comment', w.admin, del(w.admin, c2.id), 204],
    ['admin restores', w.admin, restore(w.admin, c2.id), 200],
    ['owner deletes member2 comment', w.owner, del(w.owner, c3.id), 204],
    ['owner restores', w.owner, restore(w.owner, c3.id), 200],
  ]);
});

test('[D3] webhooks and deliveries: admin+ only', async () => {
  const w = await roles();
  const hook = await createWebhook(w.owner, w.ws.id, { url: 'http://127.0.0.1:9/hook', events: ['*'] });
  await createTask(w.owner, w.project.id, { title: 'Make a delivery' });
  const deliveries = await getOk(w.owner, `/v1/webhooks/${hook.id}/deliveries`);
  const delivery = deliveries.data[0];
  assert.ok(delivery, 'a delivery must be listed right after the triggering request (SPEC 8.1)');
  const calls = (u: User): [string, () => Promise<ApiResponse>][] => [
    ['create', () => u.client.post(`/v1/workspaces/${w.ws.id}/webhooks`, { url: 'http://127.0.0.1:9/x', events: ['task.created'] })],
    ['list', () => u.client.get(`/v1/workspaces/${w.ws.id}/webhooks`)],
    ['get', () => u.client.get(`/v1/webhooks/${hook.id}`)],
    ['update', () => u.client.patch(`/v1/webhooks/${hook.id}`, { events: ['*'] })],
    ['deliveries', () => u.client.get(`/v1/webhooks/${hook.id}/deliveries`)],
    ['delivery', () => u.client.get(`/v1/webhooks/${hook.id}/deliveries/${delivery.id}`)],
  ];
  const cases: [string, User, () => Promise<ApiResponse>, number | number[]][] = [];
  for (const u of [w.member, w.viewer]) {
    for (const [name, call] of calls(u)) cases.push([`${u.name} ${name}`, u, call, 403]);
    cases.push([`${u.name} redeliver`, u, () => u.client.post(`/v1/webhooks/${hook.id}/deliveries/${delivery.id}/redeliver`), 403]);
    cases.push([`${u.name} delete`, u, () => u.client.delete(`/v1/webhooks/${hook.id}`), 403]);
  }
  for (const u of [w.owner, w.admin]) {
    for (const [name, call] of calls(u)) cases.push([`${u.name} ${name}`, u, call, name === 'create' ? 201 : 200]);
  }
  cases.push(['admin delete', w.admin, () => w.admin.client.delete(`/v1/webhooks/${hook.id}`), 204]);
  await expectRoleStatus(cases);
});

test('[D4] revoking another key takes effect immediately', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const created = await ana.client.post('/v1/users/me/api-keys', { name: 'ci' });
  expectStatus(created, 201);
  assert.match(created.body.secret, /^twl_[A-Za-z0-9]{40}$/);
  const k2 = new Client(created.body.secret);
  expectStatus(await k2.get('/v1/users/me'), 200);
  expectStatus(await ana.client.delete(`/v1/users/me/api-keys/${created.body.id}`), 204);
  expectError(await k2.get('/v1/users/me'), 401, 'invalid_api_key');
  expectStatus(await ana.client.delete(`/v1/users/me/api-keys/${created.body.id}`), 204);
  const keys = await getOk(ana, '/v1/users/me/api-keys');
  const revoked = keys.data.find((k: Json) => k.id === created.body.id);
  assert.ok(revoked.revoked_at, 'revoked key stays listed with revoked_at');
  for (const k of keys.data) assert.equal('secret' in k, false, 'listed keys never contain secret');
});

test('[D4] revoking the key used for the request returns 204 and the key stops working', async () => {
  const ana = await registerUser({ name: 'Ana' });
  expectStatus(await ana.client.delete(`/v1/users/me/api-keys/${ana.keyId}`), 204);
  expectError(await ana.client.get('/v1/users/me'), 401, 'invalid_api_key');
});

test('[D4] deactivation invalidates every key of the user', async () => {
  const bo = await registerUser({ name: 'Bo' });
  const extra = need(await bo.client.post('/v1/users/me/api-keys', { name: 'second' }), 201, 'second key');
  expectStatus(await bo.client.delete('/v1/users/me'), 204);
  expectError(await bo.client.get('/v1/users/me'), 401, 'invalid_api_key');
  expectError(await new Client(extra.secret).get('/v1/users/me'), 401, 'invalid_api_key');
});

test('[D5] transfer ownership is one atomic step with exactly two events', async () => {
  const t = await team({ admins: 0, members: 1, viewers: 0 });
  const before = await getOk(t.owner, `/v1/workspaces/${t.ws.id}`);
  const mark = await eventMark(t);
  const res = await t.owner.client.post(`/v1/workspaces/${t.ws.id}/transfer-ownership`, { user_id: t.member.id });
  expectStatus(res, 200);
  assert.equal(res.body.owner_id, t.member.id);
  assert.equal(res.body.version, before.version + 1);
  assert.equal(res.headers.get('etag'), `"${before.version + 1}"`);
  const members = await t.owner.client.pageAll(`/v1/workspaces/${t.ws.id}/members`);
  assert.deepEqual(members.items.filter((m) => m.role === 'owner').map((m) => m.user.id), [t.member.id]);
  assert.equal(members.items.find((m) => m.user.id === t.owner.id).role, 'admin');
  const fresh = (await activity(t.owner, t.ws.id)).filter((e) => !mark.has(e.id));
  assert.deepEqual(fresh.map((e) => e.type).sort(), ['member.role_changed', 'ownership.transferred']);
  assert.deepEqual(fresh.find((e) => e.type === 'ownership.transferred').target, { type: 'member', id: t.member.id });
  assert.deepEqual(fresh.find((e) => e.type === 'member.role_changed').target, { type: 'member', id: t.owner.id });
  assert.equal((await getOk(t.member, `/v1/workspaces/${t.ws.id}`)).my_role, 'owner');
});

test('[D5] transfer to a viewer succeeds; to a non-member is 422 not_member', async () => {
  const t = await team({ admins: 0, members: 0, viewers: 1 });
  const stranger = await registerUser();
  const bad = await t.owner.client.post(`/v1/workspaces/${t.ws.id}/transfer-ownership`, { user_id: stranger.id });
  expectError(bad, 422, 'validation_failed', { path: 'user_id', code: 'not_member' });
  const res = await t.owner.client.post(`/v1/workspaces/${t.ws.id}/transfer-ownership`, { user_id: t.viewer.id });
  expectStatus(res, 200);
  assert.equal(res.body.owner_id, t.viewer.id);
});

test('[D5] owner cannot leave and cannot deactivate while owning any workspace, deleted or not', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const live = await createWorkspace(ana);
  const gone = await createWorkspace(ana);
  await deleteOk(ana, `/v1/workspaces/${gone.id}`);
  expectError(await ana.client.delete(`/v1/workspaces/${live.id}/members/${ana.id}`), 409, 'sole_owner');
  const res = await ana.client.delete('/v1/users/me');
  expectError(res, 409, 'sole_owner');
  const detail = res.body.error.details?.find((d: Json) => d.code === 'sole_owner');
  assert.ok(detail, `sole_owner detail expected: ${res.text}`);
  assert.equal(detail.path, 'workspaces');
  assert.deepEqual([...detail.workspace_ids].sort(compareIds), [live.id, gone.id].sort(compareIds));
  expectStatus(await ana.client.get('/v1/users/me'), 200);
});

test('[D5] deactivation is 409 sole_owner even when the only owned workspace is soft-deleted', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const gone = await createWorkspace(ana);
  await deleteOk(ana, `/v1/workspaces/${gone.id}`);
  const res = await ana.client.delete('/v1/users/me');
  expectError(res, 409, 'sole_owner', { path: 'workspaces', code: 'sole_owner', workspace_ids: [gone.id] });
  expectStatus(await ana.client.get('/v1/users/me'), 200);
});

test('[D5] an admin removing or demoting the owner gets 403; the owner leaving gets 409', async () => {
  const t = await team({ admins: 1, members: 0, viewers: 0 });
  expectError(await t.admin.client.delete(`/v1/workspaces/${t.ws.id}/members/${t.owner.id}`), 403, 'forbidden');
  expectError(await t.admin.client.patch(`/v1/workspaces/${t.ws.id}/members/${t.owner.id}`, { role: 'admin' }), 403, 'forbidden');
  expectError(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}/members/${t.owner.id}`), 409, 'sole_owner');
  expectError(await t.owner.client.patch(`/v1/workspaces/${t.ws.id}/members/${t.owner.id}`, { role: 'admin' }), 409, 'sole_owner');
  assert.equal((await getOk(t.owner, `/v1/workspaces/${t.ws.id}`)).owner_id, t.owner.id);
});

test('[D5] 20 concurrent transfers leave exactly one owner', async () => {
  const t = await team({ admins: 0, members: 20, viewers: 0 });
  const results = await Promise.all(
    t.members.map((m) => t.owner.client.post(`/v1/workspaces/${t.ws.id}/transfer-ownership`, { user_id: m.id })),
  );
  const winners = results.filter((r) => r.status === 200);
  assert.equal(winners.length, 1, `exactly one transfer may succeed, got ${results.map((r) => r.status).join(',')}`);
  for (const r of results) if (r.status !== 200) expectError(r, 403, 'forbidden');
  const members = await t.owner.client.pageAll(`/v1/workspaces/${t.ws.id}/members`);
  const owners = members.items.filter((m) => m.role === 'owner');
  assert.equal(owners.length, 1, 'exactly one owner (SPEC 3.11 #1)');
  assert.equal(owners[0].user.id, winners[0].body.owner_id);
  assert.equal((await getOk(t.owner, `/v1/workspaces/${t.ws.id}`)).owner_id, winners[0].body.owner_id);
});

test('[D6] deactivated author shows as Deleted user; email can be registered again', async () => {
  const t = await team({ admins: 0, members: 1, viewers: 0 });
  const bo = t.member;
  const task = await createTask(t.owner, t.project.id, { title: 'Discuss' });
  const comment = await createComment(bo, task.id, 'Bo was here');
  expectStatus(await bo.client.delete('/v1/users/me'), 204);
  const deleted = { id: bo.id, name: 'Deleted user', deleted: true };
  const list = await getOk(t.owner, `/v1/tasks/${task.id}/comments`);
  assert.deepEqual(list.data.find((c: Json) => c.id === comment.id).author, deleted);
  assert.deepEqual((await getOk(t.owner, `/v1/comments/${comment.id}`)).author, deleted);
  const events = await activity(t.owner, t.ws.id, { actor_id: bo.id });
  assert.ok(events.length > 0, 'events by the deactivated user stay listed');
  for (const e of events) assert.deepEqual(e.actor, deleted);
  expectError(await t.owner.client.get(`/v1/users/${bo.id}`), 404, 'not_found');
  const again = await registerUser({ email: bo.email, name: 'Bo again' });
  assert.notEqual(again.id, bo.id);
  expectError(await bo.client.get('/v1/users/me'), 401, 'invalid_api_key');
});

test('[D6] deactivated user cannot be added as a member', async () => {
  const t = await team({ admins: 0, members: 0, viewers: 0 });
  const bo = await registerUser({ name: 'Bo' });
  expectStatus(await bo.client.delete('/v1/users/me'), 204);
  const res = await t.owner.client.post(`/v1/workspaces/${t.ws.id}/members`, { email: bo.email, role: 'member' });
  expectError(res, 422, 'validation_failed', { path: 'email', code: 'user_not_found' });
});
