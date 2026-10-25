import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus, TIMESTAMP_RE, type DetailMatch } from '../lib/assert.ts';
import { anonymous, nextIp, Client, type ApiResponse, type Json } from '../lib/client.ts';
import {
  addMember,
  createComment,
  createProject,
  createTask,
  createWorkspace,
  deleteOk,
  getOk,
  patchOk,
  postOk,
  registerUser,
  team,
  uniqueEmail,
} from '../lib/fixtures.ts';
import { byCreation, idsAsc } from '../lib/ids.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

function exactlyOneWinner(results: ApiResponse[], created: number, conflictCode: string, detail?: DetailMatch): void {
  const ok = results.filter((r) => r.status === created);
  assert.equal(ok.length, 1, `exactly one create may succeed, got ${results.map((r) => r.status).join(',')}`);
  for (const r of results.filter((x) => x.status !== created)) expectError(r, 409, conflictCode, detail);
}

test('[E1] project slug is unique only among non-deleted projects', async () => {
  const t = await team();
  const first = await createProject(t.owner, t.ws.id, { name: 'Website', slug: 'website' });
  await deleteOk(t.owner, `/v1/projects/${first.id}`);
  const second = await createProject(t.owner, t.ws.id, { name: 'Website again', slug: 'website' });
  assert.equal(second.slug, 'website');
  expectError(await t.owner.client.post(`/v1/projects/${first.id}/restore`), 409, 'slug_taken');
  expectError(await t.owner.client.get(`/v1/projects/${first.id}`), 410, 'gone');
  await deleteOk(t.owner, `/v1/projects/${second.id}`);
  const restored = await t.owner.client.post(`/v1/projects/${first.id}/restore`);
  expectStatus(restored, 200);
  assert.equal(restored.body.slug, 'website');
  assert.equal(restored.body.deleted_at, null);
});

test('[E1] workspace slug is unique only among non-deleted workspaces', async () => {
  const owner = await registerUser();
  const first = await createWorkspace(owner, { name: 'Acme Ops', slug: 'acme-ops' });
  await deleteOk(owner, `/v1/workspaces/${first.id}`);
  const second = await createWorkspace(owner, { name: 'Acme Ops 2', slug: 'acme-ops' });
  assert.equal(second.slug, 'acme-ops');
  expectError(await owner.client.post(`/v1/workspaces/${first.id}/restore`), 409, 'slug_taken');
  await deleteOk(owner, `/v1/workspaces/${second.id}`);
  const restored = await owner.client.post(`/v1/workspaces/${first.id}/restore`);
  expectStatus(restored, 200);
  assert.equal(restored.body.slug, 'acme-ops');
});

test('[E1] 20 concurrent project creates with the same slug yield exactly one project', async () => {
  const t = await team();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => t.owner.client.post(`/v1/workspaces/${t.ws.id}/projects`, { name: `Race ${i}`, slug: 'race' })),
  );
  exactlyOneWinner(results, 201, 'slug_taken');
  const list = await t.owner.client.pageAll(`/v1/workspaces/${t.ws.id}/projects`, { limit: 100 });
  assert.equal(list.items.filter((p) => p.slug === 'race').length, 1);
});

test('[E1] 20 concurrent workspace creates with the same slug yield exactly one workspace', async () => {
  const owner = await registerUser();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => owner.client.post('/v1/workspaces', { name: `Race ${i}`, slug: 'race-ops' })),
  );
  exactlyOneWinner(results, 201, 'slug_taken');
  const list = await owner.client.pageAll('/v1/workspaces', { limit: 100 });
  assert.equal(list.items.filter((w) => w.slug === 'race-ops').length, 1);
});

test('[E1] 20 concurrent registrations of one email (mixed case) yield exactly one user', async () => {
  const email = uniqueEmail('racer');
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      new Client(null, nextIp()).post('/v1/users', { email: i % 2 ? email.toUpperCase() : email, name: `Racer ${i}` }),
    ),
  );
  exactlyOneWinner(results, 201, 'email_taken');
});

test('[E1] a deactivated user email can be registered again', async () => {
  const user = await registerUser({ name: 'Leaver' });
  expectStatus(await user.client.delete('/v1/users/me'), 204);
  const again = await anonymous().post('/v1/users', { email: user.email, name: 'Returner' });
  expectStatus(again, 201);
  assert.notEqual(again.body.user.id, user.id);
});

test('[E2] project restore brings back what was visible at deletion, not individually deleted tasks', async () => {
  const t = await team();
  const t1 = await createTask(t.member, t.project.id, { title: 'T1' });
  const t2 = await createTask(t.member, t.project.id, { title: 'T2' });
  const c = await createComment(t.member, t2.id, 'on T2');
  await deleteOk(t.owner, `/v1/tasks/${t1.id}`);
  await deleteOk(t.owner, `/v1/projects/${t.project.id}`);
  for (const path of [`/v1/tasks/${t1.id}`, `/v1/tasks/${t2.id}`, `/v1/comments/${c.id}`, `/v1/projects/${t.project.id}`]) {
    expectError(await t.member.client.get(path), 410, 'gone');
  }
  expectStatus(await t.owner.client.post(`/v1/projects/${t.project.id}/restore`), 200);
  expectStatus(await t.member.client.get(`/v1/tasks/${t2.id}`), 200);
  expectStatus(await t.member.client.get(`/v1/comments/${c.id}`), 200);
  expectError(await t.member.client.get(`/v1/tasks/${t1.id}`), 410, 'gone');
  const comments = await getOk(t.member, `/v1/tasks/${t2.id}/comments`);
  assert.deepEqual(comments.data.map((x: Json) => x.id), [c.id]);
  const listed = await t.member.client.pageAll(`/v1/projects/${t.project.id}/tasks`, { limit: 100 });
  assert.deepEqual(listed.items.map((x) => x.id), [t2.id]);
  const restored = await postOk(t.owner, `/v1/tasks/${t1.id}/restore`);
  assert.equal(restored.deleted_at, null);
  expectStatus(await t.member.client.get(`/v1/tasks/${t1.id}`), 200);
});

test('[E2] workspace restore brings back what was visible at deletion only', async () => {
  const t = await team();
  const keep = await createTask(t.member, t.project.id, { title: 'Keep' });
  const gone = await createTask(t.member, t.project.id, { title: 'Gone' });
  const c = await createComment(t.member, keep.id, 'kept');
  const p2 = await createProject(t.owner, t.ws.id, { name: 'Abandoned' });
  const p2task = await createTask(t.owner, p2.id, { title: 'In abandoned' });
  await deleteOk(t.owner, `/v1/tasks/${gone.id}`);
  await deleteOk(t.owner, `/v1/projects/${p2.id}`);
  await deleteOk(t.owner, `/v1/workspaces/${t.ws.id}`);
  for (const path of [`/v1/workspaces/${t.ws.id}`, `/v1/projects/${t.project.id}`, `/v1/tasks/${keep.id}`, `/v1/comments/${c.id}`]) {
    expectError(await t.member.client.get(path), 410, 'gone');
  }
  expectStatus(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/restore`), 200);
  for (const path of [`/v1/workspaces/${t.ws.id}`, `/v1/projects/${t.project.id}`, `/v1/tasks/${keep.id}`, `/v1/comments/${c.id}`]) {
    expectStatus(await t.member.client.get(path), 200, path);
  }
  expectError(await t.member.client.get(`/v1/tasks/${gone.id}`), 410, 'gone');
  expectError(await t.member.client.get(`/v1/projects/${p2.id}`), 410, 'gone');
  expectError(await t.member.client.get(`/v1/tasks/${p2task.id}`), 410, 'gone');
  const projects = await t.member.client.pageAll(`/v1/workspaces/${t.ws.id}/projects`, { limit: 100 });
  assert.deepEqual(projects.items.map((p) => p.id), [t.project.id]);
});

test('[E3] deleted task: 410 for members (even viewers writing), 404 for non-members', async () => {
  const t = await team();
  const outsider = await registerUser({ name: 'Outsider' });
  await createWorkspace(outsider);
  const task = await createTask(t.member, t.project.id);
  const comment = await createComment(t.member, task.id, 'before deletion');
  await deleteOk(t.owner, `/v1/tasks/${task.id}`);
  expectError(await t.member.client.get(`/v1/tasks/${task.id}`), 410, 'gone');
  expectError(await t.viewer.client.get(`/v1/tasks/${task.id}`), 410, 'gone');
  expectError(await outsider.client.get(`/v1/tasks/${task.id}`), 404, 'not_found');
  expectError(await t.viewer.client.patch(`/v1/tasks/${task.id}`, { title: 'x' }), 410, 'gone');
  expectError(await t.member.client.patch(`/v1/tasks/${task.id}`, { title: 'x' }), 410, 'gone');
  expectError(await t.member.client.post(`/v1/tasks/${task.id}/comments`, { body: 'late' }), 410, 'gone');
  expectError(await t.member.client.get(`/v1/comments/${comment.id}`), 410, 'gone');
  expectError(await outsider.client.get(`/v1/comments/${comment.id}`), 404, 'not_found');
});

test('[E3] task in a deleted project is 410 for members and 404 for non-members', async () => {
  const t = await team();
  const outsider = await registerUser({ name: 'Outsider' });
  await createWorkspace(outsider);
  const p2 = await createProject(t.owner, t.ws.id);
  const task = await createTask(t.owner, p2.id);
  await deleteOk(t.owner, `/v1/projects/${p2.id}`);
  expectError(await t.member.client.get(`/v1/tasks/${task.id}`), 410, 'gone');
  expectError(await t.member.client.get(`/v1/projects/${p2.id}/tasks`), 410, 'gone');
  expectError(await t.member.client.get(`/v1/projects/${p2.id}/summary`), 410, 'gone');
  expectError(await t.member.client.post(`/v1/projects/${p2.id}/tasks`, { title: 'late' }), 410, 'gone');
  expectError(await outsider.client.get(`/v1/tasks/${task.id}`), 404, 'not_found');
});

test('[E4] restoring a task whose assignee was removed comes back unassigned', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id, { assignee_id: t.member.id });
  await deleteOk(t.owner, `/v1/tasks/${task.id}`);
  await deleteOk(t.owner, `/v1/workspaces/${t.ws.id}/members/${t.member.id}`);
  const restored = await postOk(t.owner, `/v1/tasks/${task.id}/restore`);
  assert.equal(restored.assignee_id, null);
  assert.equal(restored.deleted_at, null);
  assert.equal((await getOk(t.owner, `/v1/tasks/${task.id}`)).assignee_id, null);
});

test('[E4] restoring a task whose assignee was demoted to viewer comes back unassigned', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id, { assignee_id: t.member.id });
  await deleteOk(t.owner, `/v1/tasks/${task.id}`);
  await patchOk(t.owner, `/v1/workspaces/${t.ws.id}/members/${t.member.id}`, { role: 'viewer' });
  const restored = await postOk(t.owner, `/v1/tasks/${task.id}/restore`);
  assert.equal(restored.assignee_id, null);
});

test('[E4] restoring a task whose assignee is still assignable keeps the assignee', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id, { assignee_id: t.member.id });
  await deleteOk(t.owner, `/v1/tasks/${task.id}`);
  const restored = await postOk(t.owner, `/v1/tasks/${task.id}/restore`);
  assert.equal(restored.assignee_id, t.member.id);
});

test('[E5] task lists hide deleted tasks; include_deleted is admin-only and omits project-hidden tasks', async () => {
  const t = await team();
  const alive = await createTask(t.owner, t.project.id, { title: 'Zebra alive' });
  const single = await createTask(t.owner, t.project.id, { title: 'Zebra single' });
  const p2 = await createProject(t.owner, t.ws.id);
  const hidden = await createTask(t.owner, p2.id, { title: 'Zebra hidden' });
  await deleteOk(t.owner, `/v1/tasks/${single.id}`);
  await deleteOk(t.owner, `/v1/projects/${p2.id}`);

  const plain = await t.member.client.pageAll(`/v1/workspaces/${t.ws.id}/tasks`, { limit: 100 });
  assert.deepEqual(plain.items.map((x) => x.id), [alive.id]);
  expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}/tasks`, { include_deleted: 'true' }), 403, 'forbidden');
  expectError(await t.member.client.get(`/v1/projects/${t.project.id}/tasks`, { include_deleted: 'true' }), 403, 'forbidden');

  const withDeleted = await t.admin.client.pageAll(`/v1/workspaces/${t.ws.id}/tasks`, { limit: 100, include_deleted: 'true' });
  assert.deepEqual(withDeleted.items.map((x) => x.id).sort(), [alive.id, single.id].sort());
  const deletedOne = withDeleted.items.find((x) => x.id === single.id);
  assert.match(deletedOne.deleted_at, TIMESTAMP_RE);
  assert.ok(!withDeleted.items.some((x) => x.id === hidden.id), 'tasks hidden only by their deleted project stay omitted');

  const search = await t.member.client.get(`/v1/workspaces/${t.ws.id}/search`, { q: 'zebra' });
  expectStatus(search, 200);
  assert.deepEqual(search.body.data.map((r: Json) => r.task.id), [alive.id]);
});

test('[E5] project and comment lists: include_deleted is admin-only', async () => {
  const t = await team();
  const p2 = await createProject(t.owner, t.ws.id, { name: 'Old' });
  await deleteOk(t.owner, `/v1/projects/${p2.id}`);
  const projects = await t.member.client.pageAll(`/v1/workspaces/${t.ws.id}/projects`, { limit: 100 });
  assert.ok(!projects.items.some((p) => p.id === p2.id));
  expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}/projects`, { include_deleted: 'true' }), 403, 'forbidden');
  const adminProjects = await t.admin.client.pageAll(`/v1/workspaces/${t.ws.id}/projects`, { limit: 100, include_deleted: 'true' });
  const old = adminProjects.items.find((p) => p.id === p2.id);
  assert.ok(old, 'admin sees the deleted project with include_deleted');
  assert.match(old.deleted_at, TIMESTAMP_RE);

  const task = await createTask(t.member, t.project.id);
  const keep = await createComment(t.member, task.id, 'keep');
  const drop = await createComment(t.member, task.id, 'drop');
  await deleteOk(t.owner, `/v1/comments/${drop.id}`);
  const comments = await getOk(t.member, `/v1/tasks/${task.id}/comments`);
  assert.deepEqual(comments.data.map((c: Json) => c.id), [keep.id]);
  expectError(await t.member.client.get(`/v1/tasks/${task.id}/comments`, { include_deleted: 'true' }), 403, 'forbidden');
  const adminComments = await getOk(t.admin, `/v1/tasks/${task.id}/comments`, { include_deleted: 'true' });
  assert.deepEqual(adminComments.data.map((c: Json) => c.id), byCreation([keep, drop]).map((c) => c.id));
  assert.match(adminComments.data[1].deleted_at, TIMESTAMP_RE);
});

test('[E5] workspaces include_deleted returns only deleted workspaces the requester owns', async () => {
  const owner = await registerUser({ name: 'Owner' });
  const admin = await registerUser({ name: 'Admin' });
  const ws = await createWorkspace(owner);
  const live = await createWorkspace(owner);
  await addMember(owner, ws.id, admin, 'admin');
  await deleteOk(owner, `/v1/workspaces/${ws.id}`);

  const plain = await owner.client.pageAll('/v1/workspaces', { limit: 100 });
  assert.deepEqual(plain.items.map((w) => w.id), [live.id]);
  const mine = await owner.client.pageAll('/v1/workspaces', { limit: 100, include_deleted: 'true' });
  assert.deepEqual(mine.items.map((w) => w.id), idsAsc(ws.id, live.id));
  const deleted = mine.items.find((w) => w.id === ws.id);
  assert.match(deleted.deleted_at, TIMESTAMP_RE);
  assert.equal(deleted.my_role, 'owner');
  const adminView = await admin.client.pageAll('/v1/workspaces', { limit: 100, include_deleted: 'true' });
  assert.ok(!adminView.items.some((w) => w.id === ws.id), 'an admin of a deleted workspace does not get it back');
});
