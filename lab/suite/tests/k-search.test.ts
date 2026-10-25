import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertUnique, expectError, expectStatus } from '../lib/assert.ts';
import { advance, setClock } from '../lib/clock.ts';
import type { Json } from '../lib/client.ts';
import { createComment, createProject, createTask, createWorkspace, deleteOk, patchOk, registerUser, team, type Team, type User } from '../lib/fixtures.ts';
import { compareIds, idsDesc } from '../lib/ids.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

async function search(user: User, wsId: number, q: string, extra: Record<string, string | number> = {}): Promise<Json[]> {
  const res = await user.client.get(`/v1/workspaces/${wsId}/search`, { q, ...extra });
  expectStatus(res, 200, `search q=${q}`);

  return res.body.data;
}

function summary(rows: Json[]): [number, string][] {
  return rows.map((r) => [r.task.id, r.match]);
}

interface Corpus extends Team {
  prefix: Json;
  inner: Json;
  description: Json;
  comment: Json;
  deletedCommentOnly: Json;
  deletedTask: Json;
  hiddenByProject: Json;
}

// SPEC 11: one phrase, substring match after NFKC + case folding, best match per task, ranked.
async function corpus(): Promise<Corpus> {
  const t = await team({ admins: 0, members: 1, viewers: 1 });
  const by = t.member;
  const prefix = await createTask(by, t.project.id, { title: 'Login page broken' });
  await createComment(by, prefix.id, 'login works on staging');
  const inner = await createTask(by, t.project.id, { title: 'Fix the login button' });
  const description = await createTask(by, t.project.id, { title: 'Header glitch', description: 'SSO LOGIN fails on Safari' });
  const comment = await createTask(by, t.project.id, { title: 'Misc' });
  await createComment(by, comment.id, 'see login logs');
  await createComment(by, comment.id, 'login again after deploy');
  const deletedCommentOnly = await createTask(by, t.project.id, { title: 'Other' });
  const doomed = await createComment(by, deletedCommentOnly.id, 'login mention to be deleted');
  await deleteOk(by, `/v1/comments/${doomed.id}`);
  const deletedTask = await createTask(by, t.project.id, { title: 'Login deleted task' });
  await deleteOk(by, `/v1/tasks/${deletedTask.id}`);
  const doomedProject = await createProject(by, t.ws.id, { name: 'Doomed' });
  const hiddenByProject = await createTask(by, doomedProject.id, { title: 'Login in a deleted project' });
  await deleteOk(t.owner, `/v1/projects/${doomedProject.id}`);
  const elsewhere = await registerUser();
  const otherWs = await createWorkspace(elsewhere);
  const otherProject = await createProject(elsewhere, otherWs.id);
  await createTask(elsewhere, otherProject.id, { title: 'Login elsewhere' });

  return { ...t, prefix, inner, description, comment, deletedCommentOnly, deletedTask, hiddenByProject };
}

test('[K1] each matching task appears once, ranked title_prefix, title, description, comment', async () => {
  const c = await corpus();
  const rows = await search(c.member, c.ws.id, 'login');
  assert.deepEqual(summary(rows), [
    [c.prefix.id, 'title_prefix'],
    [c.inner.id, 'title'],
    [c.description.id, 'description'],
    [c.comment.id, 'comment'],
  ]);
  const fresh = await c.member.client.get(`/v1/tasks/${c.prefix.id}`);
  assert.deepEqual(rows[0].task, fresh.body, 'search items carry the full task object');
});

test('[K1] substring semantics: q=ogin finds the same tasks, now both titles rank as title', async () => {
  const c = await corpus();
  const rows = await search(c.member, c.ws.id, 'ogin');
  const byId = new Map(summary(rows));
  assert.deepEqual([...byId.keys()].sort(compareIds), [c.prefix.id, c.inner.id, c.description.id, c.comment.id].sort(compareIds));
  assert.equal(byId.get(c.prefix.id), 'title');
  assert.equal(byId.get(c.inner.id), 'title');
  assert.deepEqual(rows.slice(2).map((r) => r.match), ['description', 'comment']);
  const [first, second] = rows;
  const ordered = first.task.updated_at > second.task.updated_at || (first.task.updated_at === second.task.updated_at && first.task.id > second.task.id);
  assert.ok(ordered, 'within a rank: updated_at desc, then id desc');
});

test('[K1] deleted tasks, deleted comments, deleted projects and other workspaces never match', async () => {
  const c = await corpus();
  const ids = (await search(c.owner, c.ws.id, 'login')).map((r) => r.task.id);
  for (const hidden of [c.deletedCommentOnly, c.deletedTask, c.hiddenByProject]) assert.ok(!ids.includes(hidden.id), `task ${hidden.title} must not match`);
  assert.equal(ids.length, 4);
});

test('[K1] restoring a deleted comment makes it count again', async () => {
  const t = await team({ admins: 0, members: 1, viewers: 0 });
  const task = await createTask(t.member, t.project.id, { title: 'Quiet' });
  const c = await createComment(t.member, task.id, 'kangaroo sighting');
  await deleteOk(t.member, `/v1/comments/${c.id}`);
  assert.deepEqual(await search(t.member, t.ws.id, 'kangaroo'), []);
  expectStatus(await t.member.client.post(`/v1/comments/${c.id}/restore`), 200);
  assert.deepEqual(summary(await search(t.member, t.ws.id, 'kangaroo')), [[task.id, 'comment']]);
});

test('[K1] within a rank results are ordered updated_at desc, then id desc', async () => {
  await setClock('2026-04-01T09:00:00Z');
  const t = await team({ admins: 0, members: 1, viewers: 0 });
  const a = await createTask(t.member, t.project.id, { title: 'Deploy alpha' });
  const b = await createTask(t.member, t.project.id, { title: 'Deploy beta' });
  const c = await createTask(t.member, t.project.id, { title: 'Deploy gamma' });
  assert.deepEqual((await search(t.member, t.ws.id, 'deploy')).map((r) => r.task.id), idsDesc(a.id, b.id, c.id));
  await advance(5);
  await patchOk(t.member, `/v1/tasks/${a.id}`, { estimate_minutes: 10 });
  assert.deepEqual((await search(t.member, t.ws.id, 'deploy')).map((r) => r.task.id), [a.id, ...idsDesc(b.id, c.id)]);
});

test('[K1] results are cursor-paginated without repeats', async () => {
  const c = await corpus();
  const full = await search(c.member, c.ws.id, 'login');
  const paged = await c.member.client.pageAll(`/v1/workspaces/${c.ws.id}/search`, { q: 'login', limit: 2 });
  assert.equal(paged.pages.length, 2);
  assert.equal(paged.pages[0].body.data.length, 2);
  assert.equal(paged.pages[1].body.next_cursor, null);
  assertUnique(paged.items.map((r) => r.task.id), 'search results across pages');
  assert.deepEqual(summary(paged.items), summary(full));
});

test('[K1] viewers may search; non-members get 404; q shorter than 2 characters is 400', async () => {
  const c = await corpus();
  assert.equal((await search(c.viewer, c.ws.id, 'login')).length, 4);
  const outsider = await registerUser();
  expectError(await outsider.client.get(`/v1/workspaces/${c.ws.id}/search`, { q: 'login' }), 404, 'not_found');
  expectError(await c.member.client.get(`/v1/workspaces/${c.ws.id}/search`, { q: 'a' }), 400, 'invalid_query');
  expectError(await c.member.client.get(`/v1/workspaces/${c.ws.id}/search`, { q: '  a  ' }), 400, 'invalid_query');
  expectError(await c.member.client.get(`/v1/workspaces/${c.ws.id}/search`, { q: 'x'.repeat(101) }), 400, 'invalid_query');
  assert.equal((await search(c.member, c.ws.id, 'x'.repeat(100))).length, 0);
});

test('[K1] comments by deactivated users still count', async () => {
  const t = await team({ admins: 0, members: 2, viewers: 0 });
  const task = await createTask(t.members[0], t.project.id, { title: 'Crossing' });
  await createComment(t.members[1], task.id, 'zebra crossing repainted');
  expectStatus(await t.members[1].client.delete('/v1/users/me'), 204);
  assert.deepEqual(summary(await search(t.members[0], t.ws.id, 'zebra')), [[task.id, 'comment']]);
});

test('[K1] the query is one phrase, case-folded, trimmed and NFKC-normalised', async () => {
  const t = await team({ admins: 0, members: 1, viewers: 0 });
  const task = await createTask(t.member, t.project.id, { title: 'Login page broken' });
  const ligature = await createTask(t.member, t.project.id, { title: 'ﬁx the Straße sign' });
  assert.deepEqual(await search(t.member, t.ws.id, 'login broken'), []);
  assert.deepEqual(summary(await search(t.member, t.ws.id, 'page broken')), [[task.id, 'title']]);
  assert.deepEqual(summary(await search(t.member, t.ws.id, 'LOGIN')), [[task.id, 'title_prefix']]);
  assert.deepEqual(summary(await search(t.member, t.ws.id, '   login   ')), [[task.id, 'title_prefix']]);
  assert.deepEqual(summary(await search(t.member, t.ws.id, 'fix the')), [[ligature.id, 'title_prefix']]);
  assert.deepEqual(summary(await search(t.member, t.ws.id, 'STRASSE')), [[ligature.id, 'title']]);
});
