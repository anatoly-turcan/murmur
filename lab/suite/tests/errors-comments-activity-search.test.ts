import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { createComment, createTask, registerUser, team, type Team } from '../lib/fixtures.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

async function withComment(spec: Parameters<typeof team>[0] = {}): Promise<Team & { task: any; comment: any }> {
  const t = await team(spec);
  const task = await createTask(t.member, t.project.id, { title: 'Login redirect loop' });
  const comment = await createComment(t.member, task.id, 'Reproduced on staging.');

  return { ...t, task, comment };
}

test('[ERR] POST /v1/tasks/{id}/comments → 403 forbidden (viewer)', async () => {
  const t = await withComment();
  expectError(await t.viewer.client.post(`/v1/tasks/${t.task.id}/comments`, { body: 'hi' }), 403, 'forbidden');
});

test('[ERR] POST /v1/tasks/{id}/comments → 410 gone (task deleted)', async () => {
  const t = await withComment();
  expectStatus(await t.member.client.delete(`/v1/tasks/${t.task.id}`), 204);
  expectError(await t.member.client.post(`/v1/tasks/${t.task.id}/comments`, { body: 'hi' }), 410, 'gone');
});

test('[ERR] POST /v1/tasks/{id}/comments → 422 required (body missing)', async () => {
  const t = await withComment();
  expectValidation(await t.member.client.post(`/v1/tasks/${t.task.id}/comments`, {}), 'body', 'required');
});

test('[ERR] POST /v1/tasks/{id}/comments → 422 too_long (body 10001 chars)', async () => {
  const t = await withComment();
  expectValidation(await t.member.client.post(`/v1/tasks/${t.task.id}/comments`, { body: 'c'.repeat(10_001) }), 'body', 'too_long');
});

test('[ERR] GET /v1/tasks/{id}/comments → 403 forbidden (include_deleted as member)', async () => {
  const t = await withComment();
  expectError(await t.member.client.get(`/v1/tasks/${t.task.id}/comments`, { include_deleted: 'true' }), 403, 'forbidden');
  expectStatus(await t.admin.client.get(`/v1/tasks/${t.task.id}/comments`, { include_deleted: 'true' }), 200);
});

test('[ERR] GET /v1/tasks/{id}/comments → 410 gone (task deleted)', async () => {
  const t = await withComment();
  expectStatus(await t.member.client.delete(`/v1/tasks/${t.task.id}`), 204);
  expectError(await t.viewer.client.get(`/v1/tasks/${t.task.id}/comments`), 410, 'gone');
});

test('[ERR] GET /v1/comments/{id} → 410 gone / 404 not_found', async () => {
  const t = await withComment();
  const outsider = await registerUser({ name: 'Oz' });
  expectError(await outsider.client.get(`/v1/comments/${t.comment.id}`), 404, 'not_found');
  expectStatus(await t.member.client.delete(`/v1/comments/${t.comment.id}`), 204);
  expectError(await t.viewer.client.get(`/v1/comments/${t.comment.id}`), 410, 'gone');
});

test('[ERR] PATCH /v1/comments/{id} → 403 forbidden (non-author, including the owner)', async () => {
  const t = await withComment({ members: 2 });
  for (const actor of [t.owner, t.admin, t.members[1], t.viewer]) {
    expectError(await actor.client.patch(`/v1/comments/${t.comment.id}`, { body: 'Rewritten' }), 403, 'forbidden');
  }
  const now = await t.member.client.get(`/v1/comments/${t.comment.id}`);
  assert.equal(now.body.body, 'Reproduced on staging.');
  assert.equal(now.body.edited, false);
});

test('[ERR] PATCH /v1/comments/{id} → 409 version_conflict', async () => {
  const t = await withComment();
  expectStatus(await t.member.client.patch(`/v1/comments/${t.comment.id}`, { body: 'Edited once' }), 200);
  const res = await t.member.client.patch(`/v1/comments/${t.comment.id}`, { body: 'Stale' }, { ifMatch: 1 });
  expectError(res, 409, 'version_conflict', { path: 'version', code: 'stale', current_version: 2 });
});

test('[ERR] PATCH /v1/comments/{id} → 410 gone', async () => {
  const t = await withComment();
  expectStatus(await t.member.client.delete(`/v1/comments/${t.comment.id}`), 204);
  expectError(await t.member.client.patch(`/v1/comments/${t.comment.id}`, { body: 'Ghost' }), 410, 'gone');
});

test('[ERR] PATCH /v1/comments/{id} → 422 too_short (blank body)', async () => {
  const t = await withComment();
  expectValidation(await t.member.client.patch(`/v1/comments/${t.comment.id}`, { body: '   ' }), 'body', 'too_short');
});

test('[ERR] DELETE /v1/comments/{id} → 403 forbidden (member non-author, viewer)', async () => {
  const t = await withComment({ members: 2 });
  expectError(await t.members[1].client.delete(`/v1/comments/${t.comment.id}`), 403, 'forbidden');
  expectError(await t.viewer.client.delete(`/v1/comments/${t.comment.id}`), 403, 'forbidden');
  expectStatus(await t.member.client.get(`/v1/comments/${t.comment.id}`), 200);
});

test('[ERR] DELETE /v1/comments/{id} → 410 gone (already deleted)', async () => {
  const t = await withComment();
  expectStatus(await t.member.client.delete(`/v1/comments/${t.comment.id}`), 204);
  expectError(await t.member.client.delete(`/v1/comments/${t.comment.id}`), 410, 'gone');
});

test('[ERR] POST /v1/comments/{id}/restore → 403 forbidden (member non-author)', async () => {
  const t = await withComment({ members: 2 });
  expectStatus(await t.admin.client.delete(`/v1/comments/${t.comment.id}`), 204);
  expectError(await t.members[1].client.post(`/v1/comments/${t.comment.id}/restore`), 403, 'forbidden');
  expectError(await t.viewer.client.post(`/v1/comments/${t.comment.id}/restore`), 403, 'forbidden');
});

test('[ERR] POST /v1/comments/{id}/restore → 409 not_deleted', async () => {
  const t = await withComment();
  expectError(await t.member.client.post(`/v1/comments/${t.comment.id}/restore`), 409, 'not_deleted');
});

for (const [name, value] of [['target_type', 'bogus'], ['since', 'notatime'], ['until', '2026-13-45T00:00:00Z'], ['actor_id', 'abc'], ['target_id', 'x'], ['type', 'task.exploded']]) {
  test(`[ERR] GET /v1/workspaces/{id}/activity → 400 invalid_query (${name}=${value})`, async () => {
    const t = await team();
    expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}/activity`, { [name]: value }), 400, 'invalid_query');
  });
}

test('[ERR] GET /v1/workspaces/{id}/activity → 410 gone (workspace deleted)', async () => {
  const t = await team();
  expectStatus(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`), 204);
  expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}/activity`), 410, 'gone');
});

test('[ERR] GET /v1/workspaces/{id}/activity → 404 not_found (non-member)', async () => {
  const t = await team();
  const outsider = await registerUser({ name: 'Oz' });
  expectError(await outsider.client.get(`/v1/workspaces/${t.ws.id}/activity`), 404, 'not_found');
});

for (const [what, q] of [['missing', undefined], ['one character', 'a'], ['one character after trimming', '  a  '], ['101 characters', 'q'.repeat(101)]]) {
  test(`[ERR] GET /v1/workspaces/{id}/search → 400 invalid_query (q ${what})`, async () => {
    const t = await team();
    expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}/search`, { q }), 400, 'invalid_query');
  });
}

test('[ERR] GET /v1/workspaces/{id}/search → 404 not_found (non-member)', async () => {
  const t = await team();
  const outsider = await registerUser({ name: 'Oz' });
  expectError(await outsider.client.get(`/v1/workspaces/${t.ws.id}/search`, { q: 'login' }), 404, 'not_found');
});

test('[ERR] GET /v1/workspaces/{id}/search → 410 gone (workspace deleted)', async () => {
  const t = await team();
  expectStatus(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`), 204);
  expectError(await t.viewer.client.get(`/v1/workspaces/${t.ws.id}/search`, { q: 'login' }), 410, 'gone');
});
