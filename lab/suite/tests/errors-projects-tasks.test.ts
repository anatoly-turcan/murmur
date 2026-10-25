import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { createProject, createTask, createWorkspace, registerUser, team } from '../lib/fixtures.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

test('[ERR] POST /v1/workspaces/{id}/projects → 403 forbidden (viewer)', async () => {
  const t = await team();
  expectError(await t.viewer.client.post(`/v1/workspaces/${t.ws.id}/projects`, { name: 'Nope' }), 403, 'forbidden');
});

test('[ERR] POST /v1/workspaces/{id}/projects → 409 slug_taken', async () => {
  const t = await team();
  await createProject(t.owner, t.ws.id, { name: 'Website', slug: 'website' });
  expectError(await t.member.client.post(`/v1/workspaces/${t.ws.id}/projects`, { name: 'Other', slug: 'website' }), 409, 'slug_taken');
});

test('[ERR] POST /v1/workspaces/{id}/projects → 410 gone (workspace deleted)', async () => {
  const t = await team();
  expectStatus(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`), 204);
  expectError(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/projects`, { name: 'Late' }), 410, 'gone');
});

test('[ERR] POST /v1/workspaces/{id}/projects → 422 required (name missing)', async () => {
  const t = await team();
  expectValidation(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/projects`, { description: 'no name' }), 'name', 'required');
});

test('[ERR] GET /v1/workspaces/{id}/projects → 403 forbidden (include_deleted as member)', async () => {
  const t = await team();
  expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}/projects`, { include_deleted: 'true' }), 403, 'forbidden');
  expectStatus(await t.admin.client.get(`/v1/workspaces/${t.ws.id}/projects`, { include_deleted: 'true' }), 200);
});

test('[ERR] GET /v1/projects/{id} → 410 gone (project deleted)', async () => {
  const t = await team();
  expectStatus(await t.admin.client.delete(`/v1/projects/${t.project.id}`), 204);
  expectError(await t.viewer.client.get(`/v1/projects/${t.project.id}`), 410, 'gone');
});

test('[ERR] GET /v1/projects/{id} → 410 gone (workspace deleted)', async () => {
  const t = await team();
  expectStatus(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`), 204);
  expectError(await t.member.client.get(`/v1/projects/${t.project.id}`), 410, 'gone');
});

test('[ERR] PATCH /v1/projects/{id} → 403 forbidden (viewer)', async () => {
  const t = await team();
  expectError(await t.viewer.client.patch(`/v1/projects/${t.project.id}`, { name: 'Nope' }), 403, 'forbidden');
});

test('[ERR] PATCH /v1/projects/{id} → 409 version_conflict', async () => {
  const t = await team();
  expectStatus(await t.member.client.patch(`/v1/projects/${t.project.id}`, { name: 'Edited' }), 200);
  const res = await t.member.client.patch(`/v1/projects/${t.project.id}`, { name: 'Stale' }, { ifMatch: 1 });
  expectError(res, 409, 'version_conflict', { path: 'version', code: 'stale', current_version: 2 });
});

test('[ERR] PATCH /v1/projects/{id} → 410 gone', async () => {
  const t = await team();
  expectStatus(await t.admin.client.delete(`/v1/projects/${t.project.id}`), 204);
  expectError(await t.member.client.patch(`/v1/projects/${t.project.id}`, { name: 'Ghost' }), 410, 'gone');
});

test('[ERR] PATCH /v1/projects/{id} → 422 too_long (description 5001 chars)', async () => {
  const t = await team();
  expectValidation(await t.member.client.patch(`/v1/projects/${t.project.id}`, { description: 'd'.repeat(5001) }), 'description', 'too_long');
});

test('[ERR] DELETE /v1/projects/{id} → 403 forbidden (member)', async () => {
  const t = await team();
  expectError(await t.member.client.delete(`/v1/projects/${t.project.id}`), 403, 'forbidden');
});

test('[ERR] DELETE /v1/projects/{id} → 410 gone (already deleted)', async () => {
  const t = await team();
  expectStatus(await t.admin.client.delete(`/v1/projects/${t.project.id}`), 204);
  expectError(await t.admin.client.delete(`/v1/projects/${t.project.id}`), 410, 'gone');
});

test('[ERR] POST /v1/projects/{id}/restore → 403 forbidden (member)', async () => {
  const t = await team();
  expectStatus(await t.admin.client.delete(`/v1/projects/${t.project.id}`), 204);
  expectError(await t.member.client.post(`/v1/projects/${t.project.id}/restore`), 403, 'forbidden');
});

test('[ERR] POST /v1/projects/{id}/restore → 409 not_deleted', async () => {
  const t = await team();
  expectError(await t.admin.client.post(`/v1/projects/${t.project.id}/restore`), 409, 'not_deleted');
});

test('[ERR] POST /v1/projects/{id}/restore → 409 slug_taken', async () => {
  const t = await team();
  const first = await createProject(t.owner, t.ws.id, { name: 'Website', slug: 'website' });
  expectStatus(await t.owner.client.delete(`/v1/projects/${first.id}`), 204);
  await createProject(t.owner, t.ws.id, { name: 'Website again', slug: 'website' });
  expectError(await t.owner.client.post(`/v1/projects/${first.id}/restore`), 409, 'slug_taken');
});

test('[ERR] GET /v1/projects/{id}/summary → 410 gone / 404 not_found', async () => {
  const t = await team();
  const outsider = await registerUser({ name: 'Oz' });
  expectError(await outsider.client.get(`/v1/projects/${t.project.id}/summary`), 404, 'not_found');
  expectStatus(await t.admin.client.delete(`/v1/projects/${t.project.id}`), 204);
  expectError(await t.member.client.get(`/v1/projects/${t.project.id}/summary`), 410, 'gone');
});

test('[ERR] POST /v1/projects/{id}/tasks → 403 forbidden (viewer)', async () => {
  const t = await team();
  expectError(await t.viewer.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'Nope' }), 403, 'forbidden');
});

test('[ERR] POST /v1/projects/{id}/tasks → 410 gone (project deleted)', async () => {
  const t = await team();
  expectStatus(await t.admin.client.delete(`/v1/projects/${t.project.id}`), 204);
  expectError(await t.member.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'Late' }), 410, 'gone');
});

test('[ERR] POST /v1/projects/{id}/tasks → 422 not_assignable (viewer assignee)', async () => {
  const t = await team();
  expectValidation(await t.member.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'x', assignee_id: t.viewer.id }), 'assignee_id', 'not_assignable');
});

test('[ERR] POST /v1/projects/{id}/tasks → 422 not_assignable (non-member assignee)', async () => {
  const t = await team();
  const outsider = await registerUser({ name: 'Oz' });
  expectValidation(await t.member.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'x', assignee_id: outsider.id }), 'assignee_id', 'not_assignable');
});

test('[ERR] POST /v1/projects/{id}/tasks → 422 invalid_date (2026-02-30)', async () => {
  const t = await team();
  expectValidation(await t.member.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'x', due_date: '2026-02-30' }), 'due_date', 'invalid_date');
});

test('[ERR] POST /v1/projects/{id}/tasks → 422 duplicate (labels, index of second)', async () => {
  const t = await team();
  const res = await t.member.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'x', labels: ['bug', 'auth', 'BUG'] });
  expectValidation(res, 'labels[2]', 'duplicate');
});

test('[ERR] POST /v1/projects/{id}/tasks → 422 too_many_items (21 labels)', async () => {
  const t = await team();
  const labels = Array.from({ length: 21 }, (_, i) => `label-${i}`);
  expectValidation(await t.member.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'x', labels }), 'labels', 'too_many_items');
});

test('[ERR] POST /v1/projects/{id}/tasks → 422 required (title missing)', async () => {
  const t = await team();
  expectValidation(await t.member.client.post(`/v1/projects/${t.project.id}/tasks`, { description: 'untitled' }), 'title', 'required');
});

test('[ERR] POST /v1/projects/{id}/tasks → 422 out_of_range (estimate_minutes)', async () => {
  const t = await team();
  for (const estimate_minutes of [-1, 100_001]) {
    expectValidation(await t.member.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'x', estimate_minutes }), 'estimate_minutes', 'out_of_range');
  }
});

test('[ERR] POST /v1/projects/{id}/tasks → 422 invalid_enum (status)', async () => {
  const t = await team();
  expectValidation(await t.member.client.post(`/v1/projects/${t.project.id}/tasks`, { title: 'x', status: 'later' }), 'status', 'invalid_enum');
});

test('[ERR] GET /v1/projects/{id}/tasks → 403 forbidden (include_deleted as member)', async () => {
  const t = await team();
  expectError(await t.member.client.get(`/v1/projects/${t.project.id}/tasks`, { include_deleted: 'true' }), 403, 'forbidden');
});

for (const [name, value] of [['status', 'later'], ['assignee_id', 'abc'], ['due_before', 'notadate'], ['due_after', '2026-02-30'], ['sort', 'title'], ['overdue', 'maybe']]) {
  test(`[ERR] GET /v1/projects/{id}/tasks → 400 invalid_query (${name}=${value})`, async () => {
    const t = await team();
    expectError(await t.member.client.get(`/v1/projects/${t.project.id}/tasks`, { [name]: value }), 400, 'invalid_query');
  });
}

test('[ERR] GET /v1/projects/{id}/tasks → 400 invalid_cursor (filters changed)', async () => {
  const t = await team();
  for (let i = 0; i < 3; i += 1) await createTask(t.member, t.project.id, { labels: ['bug'] });
  const first = await t.member.client.get(`/v1/projects/${t.project.id}/tasks`, { status: 'open', limit: 1 });
  expectStatus(first, 200);
  const cursor = first.body.next_cursor;
  assert.equal(typeof cursor, 'string');
  expectError(await t.member.client.get(`/v1/projects/${t.project.id}/tasks`, { status: 'done', limit: 1, cursor }), 400, 'invalid_cursor');
  expectStatus(await t.member.client.get(`/v1/projects/${t.project.id}/tasks`, { status: 'open', limit: 1, cursor }), 200);
});

test('[ERR] GET /v1/workspaces/{id}/tasks → 403 forbidden (include_deleted as member)', async () => {
  const t = await team();
  expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}/tasks`, { include_deleted: 'true' }), 403, 'forbidden');
});

for (const [name, value] of [['project_id', 'abc'], ['status', 'open,later'], ['assignee_id', 'someone'], ['sort', 'priority']]) {
  test(`[ERR] GET /v1/workspaces/{id}/tasks → 400 invalid_query (${name}=${value})`, async () => {
    const t = await team();
    expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}/tasks`, { [name]: value }), 400, 'invalid_query');
  });
}

test('[ERR] GET /v1/workspaces/{id}/tasks → 400 invalid_cursor (sort changed)', async () => {
  const t = await team();
  for (let i = 0; i < 3; i += 1) await createTask(t.member, t.project.id);
  const first = await t.member.client.get(`/v1/workspaces/${t.ws.id}/tasks`, { limit: 1 });
  expectStatus(first, 200);
  const cursor = first.body.next_cursor;
  assert.equal(typeof cursor, 'string');
  expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}/tasks`, { limit: 1, cursor, sort: 'due_date' }), 400, 'invalid_cursor');
});

test('[ERR] GET /v1/tasks/{id} → 410 gone / 404 not_found', async () => {
  const t = await team();
  const outsider = await registerUser({ name: 'Oz' });
  const task = await createTask(t.member, t.project.id);
  expectStatus(await t.member.client.delete(`/v1/tasks/${task.id}`), 204);
  expectError(await t.viewer.client.get(`/v1/tasks/${task.id}`), 410, 'gone');
  expectError(await outsider.client.get(`/v1/tasks/${task.id}`), 404, 'not_found');
});

test('[ERR] GET /v1/tasks/{id} → 410 gone (project deleted)', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id);
  expectStatus(await t.admin.client.delete(`/v1/projects/${t.project.id}`), 204);
  expectError(await t.member.client.get(`/v1/tasks/${task.id}`), 410, 'gone');
});

test('[ERR] PATCH /v1/tasks/{id} → 403 forbidden (viewer)', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id);
  expectError(await t.viewer.client.patch(`/v1/tasks/${task.id}`, { title: 'Nope' }), 403, 'forbidden');
});

test('[ERR] PATCH /v1/tasks/{id} → 409 version_conflict', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id);
  expectStatus(await t.member.client.patch(`/v1/tasks/${task.id}`, { title: 'Fresh' }), 200);
  expectStatus(await t.member.client.patch(`/v1/tasks/${task.id}`, { title: 'Fresher' }), 200);
  const res = await t.member.client.patch(`/v1/tasks/${task.id}`, { title: 'Stale' }, { ifMatch: 2 });
  expectError(res, 409, 'version_conflict', { path: 'version', code: 'stale', current_version: 3 });
  const now = await t.member.client.get(`/v1/tasks/${task.id}`);
  assert.equal(now.body.title, 'Fresher');
});

test('[ERR] PATCH /v1/tasks/{id} → 410 gone', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id);
  expectStatus(await t.member.client.delete(`/v1/tasks/${task.id}`), 204);
  expectError(await t.member.client.patch(`/v1/tasks/${task.id}`, { title: 'Ghost' }), 410, 'gone');
});

test('[ERR] PATCH /v1/tasks/{id} → 422 invalid_project (project of another workspace)', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id);
  const elsewhere = await createWorkspace(t.owner);
  const foreign = await createProject(t.owner, elsewhere.id);
  expectValidation(await t.owner.client.patch(`/v1/tasks/${task.id}`, { project_id: foreign.id }), 'project_id', 'invalid_project');
});

test('[ERR] PATCH /v1/tasks/{id} → 422 invalid_project (deleted project)', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id);
  const doomed = await createProject(t.owner, t.ws.id);
  expectStatus(await t.owner.client.delete(`/v1/projects/${doomed.id}`), 204);
  expectValidation(await t.owner.client.patch(`/v1/tasks/${task.id}`, { project_id: doomed.id }), 'project_id', 'invalid_project');
});

test('[ERR] PATCH /v1/tasks/{id} → 422 invalid_enum (status)', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id);
  expectValidation(await t.member.client.patch(`/v1/tasks/${task.id}`, { status: 'blocked' }), 'status', 'invalid_enum');
});

test('[ERR] POST /v1/tasks/{id}/claim → 403 forbidden (viewer)', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id);
  expectError(await t.viewer.client.post(`/v1/tasks/${task.id}/claim`), 403, 'forbidden');
});

test('[ERR] POST /v1/tasks/{id}/claim → 409 already_assigned (someone else)', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id, { assignee_id: t.admin.id });
  const res = await t.member.client.post(`/v1/tasks/${task.id}/claim`);
  expectError(res, 409, 'already_assigned', { path: 'assignee_id', code: 'already_assigned', assignee_id: t.admin.id });
});

test('[ERR] POST /v1/tasks/{id}/claim → 409 already_assigned (requester is the assignee)', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id);
  expectStatus(await t.member.client.post(`/v1/tasks/${task.id}/claim`), 200);
  const res = await t.member.client.post(`/v1/tasks/${task.id}/claim`);
  expectError(res, 409, 'already_assigned', { path: 'assignee_id', code: 'already_assigned', assignee_id: t.member.id });
});

test('[ERR] POST /v1/tasks/{id}/claim → 410 gone', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id);
  expectStatus(await t.member.client.delete(`/v1/tasks/${task.id}`), 204);
  expectError(await t.member.client.post(`/v1/tasks/${task.id}/claim`), 410, 'gone');
});

test('[ERR] DELETE /v1/tasks/{id} → 403 forbidden (member neither creator nor assignee)', async () => {
  const t = await team({ members: 2 });
  const task = await createTask(t.members[0], t.project.id);
  expectError(await t.members[1].client.delete(`/v1/tasks/${task.id}`), 403, 'forbidden');
  expectStatus(await t.members[1].client.get(`/v1/tasks/${task.id}`), 200);
});

test('[ERR] DELETE /v1/tasks/{id} → 409 version_conflict', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id);
  expectStatus(await t.member.client.patch(`/v1/tasks/${task.id}`, {}), 200);
  const res = await t.member.client.delete(`/v1/tasks/${task.id}`, { ifMatch: 1 });
  expectError(res, 409, 'version_conflict', { path: 'version', code: 'stale', current_version: 2 });
  expectStatus(await t.member.client.get(`/v1/tasks/${task.id}`), 200);
});

test('[ERR] DELETE /v1/tasks/{id} → 410 gone (already deleted)', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id);
  expectStatus(await t.member.client.delete(`/v1/tasks/${task.id}`), 204);
  expectError(await t.member.client.delete(`/v1/tasks/${task.id}`), 410, 'gone');
});

test('[ERR] POST /v1/tasks/{id}/restore → 403 forbidden (member neither creator nor assignee)', async () => {
  const t = await team({ members: 2 });
  const task = await createTask(t.members[0], t.project.id);
  expectStatus(await t.members[0].client.delete(`/v1/tasks/${task.id}`), 204);
  expectError(await t.members[1].client.post(`/v1/tasks/${task.id}/restore`), 403, 'forbidden');
});

test('[ERR] POST /v1/tasks/{id}/restore → 409 not_deleted', async () => {
  const t = await team();
  const task = await createTask(t.member, t.project.id);
  expectError(await t.member.client.post(`/v1/tasks/${task.id}/restore`), 409, 'not_deleted');
});
