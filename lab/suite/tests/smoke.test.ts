import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTimestamps, expectError, expectStatus, assertUnique } from '../lib/assert.ts';
import { advance, clearClock, setClock, utcDatePlusDays } from '../lib/clock.ts';
import { anonymous, etagVersion } from '../lib/client.ts';
import { addMember, createComment, createProject, createTask, createWorkspace, registerUser, uniqueEmail, type User } from '../lib/fixtures.ts';
import { assertPublicId, idFromHeader, idPattern } from '../lib/ids.ts';
import { assertSigned, ok, startReceiver } from '../lib/receiver.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drainAll, emails, tickAndDrain } from '../lib/testmode.ts';

freshDatabaseEachTest();

async function people(): Promise<{ ana: User; bo: User; cy: User }> {
  const ana = await registerUser({ name: 'Ana', timezone: 'Europe/Athens' });
  const bo = await registerUser({ name: 'Bo', timezone: 'America/New_York' });
  const cy = await registerUser({ name: 'Cy', timezone: 'Asia/Tokyo' });

  return { ana, bo, cy };
}

async function acme() {
  const p = await people();
  const ws = await createWorkspace(p.ana, { name: 'Acme Ops' });
  await addMember(p.ana, ws.id, p.bo, 'member');
  await addMember(p.ana, ws.id, p.cy, 'viewer');

  return { ...p, ws };
}

async function website() {
  const a = await acme();
  const project = await createProject(a.bo, a.ws.id, { name: 'Website' });
  const task = await createTask(a.bo, project.id, {
    title: 'Fix login redirect',
    labels: ['bug'],
    due_date: utcDatePlusDays(7),
    estimate_minutes: 90,
    budget: { currency: 'USD', amount: '120.5' },
  });

  return { ...a, project, task };
}

test('[SMOKE-1] register and read yourself', async () => {
  const email = uniqueEmail('ana');
  const res = await anonymous().post('/v1/users', { email, name: 'Ana', timezone: 'Europe/Athens' });
  expectStatus(res, 201);
  const { user, api_key } = res.body;
  assertPublicId(user.id, 'user.id');
  assert.equal(user.email, email);
  assert.equal(user.name, 'Ana');
  assert.equal(user.timezone, 'Europe/Athens');
  assert.equal(user.digest_enabled, true);
  assert.match(api_key.secret, /^twl_[A-Za-z0-9]{40}$/);
  assert.equal(api_key.prefix, api_key.secret.slice(0, 12));
  assert.equal(api_key.name, 'default');
  assertTimestamps(res.body);

  const me = await anonymous().get('/v1/users/me', undefined, { key: api_key.secret });
  expectStatus(me, 200);
  assert.deepEqual(me.body, user);

  for (const [name, timezone] of [['Bo', 'America/New_York'], ['Cy', 'Asia/Tokyo']]) {
    const other = await anonymous().post('/v1/users', { email: uniqueEmail(name), name, timezone });
    expectStatus(other, 201);
    assert.equal(other.body.user.timezone, timezone);
  }
});

test('[SMOKE-2] create a workspace and invite people', async () => {
  const { ana, bo, cy } = await people();
  const res = await ana.client.post('/v1/workspaces', { name: 'Acme Ops' });
  expectStatus(res, 201);
  assert.equal(res.body.slug, 'acme-ops');
  assert.equal(res.body.owner_id, ana.id);
  assert.equal(res.body.my_role, 'owner');
  assert.equal(res.body.version, 1);
  assert.equal(res.body.deleted_at, null);
  const wsId = res.body.id;

  const addBo = await ana.client.post(`/v1/workspaces/${wsId}/members`, { email: bo.email, role: 'member' });
  expectStatus(addBo, 201);
  assert.deepEqual(addBo.body.user, { id: bo.id, name: 'Bo', email: bo.email });
  assert.equal(addBo.body.role, 'member');
  const addCy = await ana.client.post(`/v1/workspaces/${wsId}/members`, { email: cy.email, role: 'viewer' });
  expectStatus(addCy, 201);

  const members = await ana.client.get(`/v1/workspaces/${wsId}/members`);
  expectStatus(members, 200);
  assert.deepEqual(
    members.body.data.map((m: any) => [m.user.id, m.role]),
    [[ana.id, 'owner'], [bo.id, 'member'], [cy.id, 'viewer']],
  );
  assert.equal(members.body.next_cursor, null);

  const boList = await bo.client.get('/v1/workspaces');
  expectStatus(boList, 200);
  const listed = boList.body.data.find((w: any) => w.id === wsId);
  assert.ok(listed, 'Bo must see the workspace');
  assert.equal(listed.my_role, 'member');
});

test('[SMOKE-3] welcome email', async () => {
  const { bo, cy, ws } = await acme();
  await drainAll();
  const sent = await emails({ template: 'member_added' });
  assert.equal(sent.length, 2, `expected two member_added emails, got ${JSON.stringify(sent)}`);
  assert.deepEqual(sent.map((e) => e.to).sort(), [bo.email, cy.email].sort());
  for (const e of sent) {
    assert.equal(e.template, 'member_added');
    assert.equal(e.data.workspace_name, 'Acme Ops');
    assert.equal(e.data.workspace_id, ws.id);
    const userId = e.to === bo.email ? bo.id : cy.id;
    assert.match(e.dedupe_key, new RegExp(`^member_added:${ws.id}:${userId}:${idPattern().source.slice(1, -1)}$`));
    assertTimestamps(e);
  }
});

test('[SMOKE-4] project and task', async () => {
  const { bo, ws } = await acme();
  const project = await bo.client.post(`/v1/workspaces/${ws.id}/projects`, { name: 'Website' });
  expectStatus(project, 201);
  assert.equal(project.body.slug, 'website');
  assert.equal(project.body.creator_id, bo.id);

  const due = utcDatePlusDays(7);
  const res = await bo.client.post(`/v1/projects/${project.body.id}/tasks`, {
    title: 'Fix login redirect',
    labels: ['bug'],
    due_date: due,
    estimate_minutes: 90,
    budget: { currency: 'USD', amount: '120.5' },
  });
  expectStatus(res, 201);
  const task = res.body;
  assert.equal(task.status, 'open');
  assert.equal(task.overdue, false);
  assert.deepEqual(task.labels, ['bug']);
  assert.equal(task.due_date, due);
  assert.equal(task.estimate_minutes, 90);
  assert.deepEqual(task.budget, { currency: 'USD', amount: '120.50', amount_minor: '12050' });
  assert.equal(task.project_id, project.body.id);
  assert.equal(task.workspace_id, ws.id);
  assert.equal(task.creator_id, bo.id);
  assert.equal(task.assignee_id, null);
  assert.equal(task.version, 1);
  assert.equal(task.completed_at, null);

  const got = await bo.client.get(`/v1/tasks/${task.id}`);
  expectStatus(got, 200);
  assert.deepEqual(got.body, task);
  assert.equal(got.headers.get('etag'), '"1"');
});

test('[SMOKE-5] viewer is read-only', async () => {
  const { cy, task } = await website();
  expectStatus(await cy.client.get(`/v1/tasks/${task.id}`), 200);
  expectError(await cy.client.patch(`/v1/tasks/${task.id}`, { title: 'x' }), 403, 'forbidden');
  expectError(await cy.client.post(`/v1/tasks/${task.id}/comments`, { body: 'hi' }), 403, 'forbidden');
});

test('[SMOKE-6] claim, update and the activity feed', async () => {
  const { ana, ws, task } = await website();
  const claim = await ana.client.post(`/v1/tasks/${task.id}/claim`);
  expectStatus(claim, 200);
  assert.equal(claim.body.assignee_id, ana.id);
  assert.equal(claim.body.version, 2);
  assert.equal(etagVersion(claim), 2);

  const patch = await ana.client.patch(`/v1/tasks/${task.id}`, { status: 'in_progress' }, { ifMatch: '"2"' });
  expectStatus(patch, 200);
  assert.equal(patch.body.version, 3);
  assert.equal(patch.body.status, 'in_progress');

  const feed = await ana.client.get(`/v1/workspaces/${ws.id}/activity`);
  expectStatus(feed, 200);
  const events = feed.body.data;
  assert.deepEqual(
    events.map((e: any) => e.type),
    ['task.updated', 'task.updated', 'task.created', 'project.created', 'member.added', 'member.added', 'workspace.created'],
  );
  assert.deepEqual(events[0].changes, { status: { from: 'open', to: 'in_progress' } });
  assert.deepEqual(events[0].target, { type: 'task', id: task.id });
  assert.deepEqual(events[1].changes.assignee_id, { from: null, to: ana.id });
  assert.deepEqual(events[1].actor, { id: ana.id, name: 'Ana', deleted: false });
  assert.deepEqual(events[6].changes, {});
  assertTimestamps(events);
});

test('[SMOKE-7] comment and notification', async () => {
  const { ana, bo, task } = await website();
  expectStatus(await ana.client.post(`/v1/tasks/${task.id}/claim`), 200);
  const res = await bo.client.post(`/v1/tasks/${task.id}/comments`, { body: 'Reproduced on staging.' });
  expectStatus(res, 201);
  assert.deepEqual(res.body.author, { id: bo.id, name: 'Bo', deleted: false });
  assert.equal(res.body.edited, false);
  assert.equal(res.body.body, 'Reproduced on staging.');
  assert.equal(res.body.task_id, task.id);

  await drainAll();
  const sent = await emails({ template: 'comment_added' });
  assert.equal(sent.length, 1, `expected exactly one comment_added email, got ${JSON.stringify(sent)}`);
  assert.equal(sent[0].to, ana.email);
  assert.equal(sent[0].dedupe_key, `comment_added:${res.body.id}:${ana.id}`);
  assert.equal(sent[0].data.comment_id, res.body.id);
  assert.equal(sent[0].data.task_id, task.id);
  assert.equal(sent[0].data.author_name, 'Bo');
  assert.equal(sent[0].data.body, 'Reproduced on staging.');
});

test('[SMOKE-8] idempotent create', async () => {
  const { bo, project } = await website();
  const first = await bo.client.post(`/v1/projects/${project.id}/tasks`, { title: 'Idempotent task' }, { idempotencyKey: 'smoke-8' });
  const second = await bo.client.post(`/v1/projects/${project.id}/tasks`, { title: 'Idempotent task' }, { idempotencyKey: 'smoke-8' });
  expectStatus(first, 201);
  expectStatus(second, 201);
  assert.notEqual(first.headers.get('idempotent-replayed'), 'true');
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(second.body, first.body);

  const all = await bo.client.pageAll(`/v1/projects/${project.id}/tasks`, { limit: 100 });
  assert.equal(all.items.filter((t) => t.title === 'Idempotent task').length, 1);
});

test('[SMOKE-9] paginated listing', async () => {
  const { bo, project } = await website();
  await createTask(bo, project.id, { title: 'Idempotent task' });
  for (let i = 0; i < 25; i += 1) await createTask(bo, project.id, { title: `Bulk ${i}` });

  const sizes: number[] = [];
  const seen: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 3; page += 1) {
    const res = await bo.client.get(`/v1/projects/${project.id}/tasks`, cursor ? { limit: 10, cursor } : { limit: 10 });
    expectStatus(res, 200);
    sizes.push(res.body.data.length);
    seen.push(...res.body.data);
    cursor = res.body.next_cursor;
    if (page < 2) assert.equal(typeof cursor, 'string', 'next_cursor must be a string while more items remain');
  }
  assert.deepEqual(sizes, [10, 10, 7]);
  assert.equal(cursor, null);
  assertUnique(seen.map((t) => t.id), 'task ids across pages');
  for (let i = 1; i < seen.length; i += 1) {
    const [a, b] = [seen[i - 1], seen[i]];
    const ordered = a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id);
    assert.ok(ordered, `newest first: ${a.id}@${a.created_at} must precede ${b.id}@${b.created_at}`);
  }
});

test('[SMOKE-10] soft delete and restore', async () => {
  const { ana, bo, project, task } = await website();
  expectStatus(await ana.client.delete(`/v1/tasks/${task.id}`), 204);
  expectError(await bo.client.get(`/v1/tasks/${task.id}`), 410, 'gone');
  const listed = await bo.client.pageAll(`/v1/projects/${project.id}/tasks`, { limit: 100 });
  assert.ok(!listed.items.some((t) => t.id === task.id), 'deleted task must not be listed');

  const restored = await ana.client.post(`/v1/tasks/${task.id}/restore`);
  expectStatus(restored, 200);
  assert.equal(restored.body.deleted_at, null);
  assert.equal(restored.body.id, task.id);
  const again = await bo.client.pageAll(`/v1/projects/${project.id}/tasks`, { limit: 100 });
  assert.ok(again.items.some((t) => t.id === task.id), 'restored task must be listed again');
});

test('[SMOKE-11] webhook delivery', async (t) => {
  const { ana, bo, ws, project } = await website();
  const receiver = await startReceiver(ok());
  t.after(() => receiver.close());
  const hookRes = await ana.client.post(`/v1/workspaces/${ws.id}/webhooks`, { url: receiver.url, events: ['task.created'] });
  expectStatus(hookRes, 201);
  const hook = hookRes.body;
  assert.equal(typeof hook.secret, 'string');
  assert.ok(hook.secret.length >= 32);
  assert.equal(hook.active, true);
  assert.deepEqual(hook.events, ['task.created']);

  const task = await createTask(bo, project.id, { title: 'Webhook me' });
  await drainAll();
  assert.equal(receiver.requests.length, 1, 'receiver must get exactly one POST');
  const req = receiver.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['x-taskwell-event'], 'task.created');
  assert.match(req.headers['x-taskwell-delivery-id'] ?? '', idPattern());
  assertSigned(hook.secret, req);
  assert.equal(req.json.data.task.id, task.id);

  const deliveries = await ana.client.get(`/v1/webhooks/${hook.id}/deliveries`);
  expectStatus(deliveries, 200);
  assert.equal(deliveries.body.data.length, 1);
  const d = deliveries.body.data[0];
  assert.equal(d.id, idFromHeader(req.headers['x-taskwell-delivery-id']));
  assert.equal(d.status, 'succeeded');
  assert.equal(d.attempts.length, 1);
  assert.equal(d.attempts[0].outcome, 'success');
  assert.equal(d.attempts[0].status_code, 200);
});

test('[SMOKE-12] search', async () => {
  const { bo, ws, project } = await website();
  const task = await createTask(bo, project.id, { title: 'Login redirect loop', description: 'Happens after SSO' });
  await createComment(bo, task.id, 'Also on mobile');
  const search = async (q: string) => {
    const res = await bo.client.get(`/v1/workspaces/${ws.id}/search`, { q });
    expectStatus(res, 200);

    return res.body.data.filter((r: any) => r.task.id === task.id);
  };
  for (const [q, match] of [['login', 'title_prefix'], ['redirect', 'title'], ['sso', 'description'], ['mobile', 'comment']]) {
    const hits = await search(q);
    assert.equal(hits.length, 1, `q=${q} must return the task once`);
    assert.equal(hits[0].match, match, `q=${q}`);
    assert.equal(hits[0].task.title, 'Login redirect loop');
  }
  const none = await bo.client.get(`/v1/workspaces/${ws.id}/search`, { q: 'zzzz' });
  expectStatus(none, 200);
  assert.deepEqual(none.body.data, []);
});

test('[SMOKE-13] daily digest with the test clock', async () => {
  const { ana, bo, cy } = await people();
  await setClock('2027-06-10T04:30:00Z');
  const digests = async () => (await emails({ template: 'daily_digest' })).filter((e) => [ana.email, bo.email, cy.email].includes(e.to));

  await tickAndDrain();
  let sent = await digests();
  assert.deepEqual(sent.map((e) => e.to), [cy.email], 'only Cy (13:30 Tokyo) gets a digest at 04:30Z');
  assert.equal(sent[0].data.date, '2027-06-10');
  assert.equal(sent[0].subject, 'Your Taskwell digest for 2027-06-10');

  await advance(3600);
  await tickAndDrain();
  sent = await digests();
  assert.equal(sent.length, 2);
  const anaDigest = sent.find((e) => e.to === ana.email);
  assert.ok(anaDigest, 'Ana (08:30 Athens) must get her digest at 05:30Z');
  assert.equal(anaDigest.data.date, '2027-06-10');
  assert.equal(anaDigest.data.timezone, 'Europe/Athens');
  assert.equal(anaDigest.dedupe_key, `daily_digest:${ana.id}:2027-06-10`);
  assert.deepEqual(anaDigest.data.overdue, []);
  assert.deepEqual(anaDigest.data.due_today, []);
  assert.equal(anaDigest.data.activity_count, 0);

  await advance(36_000);
  await tickAndDrain();
  sent = await digests();
  assert.equal(sent.length, 3);
  const boDigest = sent.find((e) => e.to === bo.email);
  assert.ok(boDigest, 'Bo (11:30 New York) must get his digest at 15:30Z');
  assert.equal(boDigest.data.timezone, 'America/New_York');

  await tickAndDrain();
  assert.equal((await digests()).length, 3, 'a second tick in the same minute must not add digests');
  await clearClock();
});
