import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTimestamps, expectStatus } from '../lib/assert.ts';
import { advance, getClock, setClock } from '../lib/clock.ts';
import type { Json } from '../lib/client.ts';
import {
  addMember,
  createComment,
  createProject,
  createTask,
  createWebhook,
  createWorkspace,
  getOk,
  patchOk,
  registerUser,
  type User,
} from '../lib/fixtures.ts';
import { assertSigned, fail, ok, startReceiver } from '../lib/receiver.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drainAll, emails, jobs, tickAndDrain } from '../lib/testmode.ts';

freshDatabaseEachTest();

async function digestsFor(user: User): Promise<Json[]> {
  return emails({ template: 'daily_digest', to: user.email });
}

function checkDigest(email: Json, user: User, date: string, timezone: string): void {
  assert.equal(email.to, user.email);
  assert.equal(email.template, 'daily_digest');
  assert.equal(email.subject, `Your Taskwell digest for ${date}`);
  assert.equal(email.dedupe_key, `daily_digest:${user.id}:${date}`);
  assert.equal(email.data.date, date);
  assert.equal(email.data.timezone, timezone);
  assert.ok(Array.isArray(email.data.overdue), 'data.overdue must be an array');
  assert.ok(Array.isArray(email.data.due_today), 'data.due_today must be an array');
  assert.equal(typeof email.data.activity_count, 'number');
}

async function expectDigestDates(user: User, dates: string[], note: string): Promise<Json[]> {
  const sent = await digestsFor(user);
  assert.deepEqual(sent.map((e) => e.data?.date), dates, note);

  return sent;
}

async function digestScenario(zone: string, steps: Array<[string, string[]]>): Promise<void> {
  await setClock(steps[0][0]);
  const user = await registerUser({ name: 'Dee', timezone: zone });
  for (const [at, dates] of steps) {
    await setClock(at);
    await tickAndDrain();
    const sent = await expectDigestDates(user, dates, `${zone} at ${at}`);
    sent.forEach((e, i) => checkDigest(e, user, dates[i], zone));
  }
}

// SPEC 10.2
test('[B1] digest at 08:00 America/New_York across spring-forward', async () => {
  await digestScenario('America/New_York', [
    ['2026-03-07T12:30:00Z', []],
    ['2026-03-07T13:00:00Z', ['2026-03-07']],
    ['2026-03-08T12:30:00Z', ['2026-03-07', '2026-03-08']],
  ]);
});

test('[B1] digest at 08:00 Europe/Athens on the day summer time starts', async () => {
  await digestScenario('Europe/Athens', [
    ['2026-03-29T04:30:00Z', []],
    ['2026-03-29T05:30:00Z', ['2026-03-29']],
  ]);
});

test('[B1] digest at 08:00 Australia/Sydney on the day daylight saving ends', async () => {
  await digestScenario('Australia/Sydney', [
    ['2026-04-04T21:30:00Z', []],
    ['2026-04-04T22:00:00Z', ['2026-04-05']],
  ]);
});

async function reminderWorld(creatorZone = 'America/New_York') {
  const owner = await registerUser({ name: 'Ana', timezone: creatorZone });
  const tokyo = await registerUser({ name: 'Kenji', timezone: 'Asia/Tokyo' });
  const ws = await createWorkspace(owner);
  await addMember(owner, ws.id, tokyo, 'member');
  const project = await createProject(owner, ws.id);

  return { owner, tokyo, ws, project };
}

async function taskDue(): Promise<Json[]> {
  return emails({ template: 'task_due' });
}

// SPEC 10.3
test('[B2] due reminder at 09:00 in the assignee timezone, exactly once', async () => {
  await setClock('2026-05-09T20:00:00Z');
  const { owner, tokyo, ws, project } = await reminderWorld();
  const task = await createTask(owner, project.id, { title: 'Ship release notes', due_date: '2026-05-10', assignee_id: tokyo.id });

  await setClock('2026-05-09T23:30:00Z');
  await tickAndDrain();
  assert.deepEqual(await taskDue(), [], 'no reminder at 08:30 JST');

  await setClock('2026-05-10T00:00:00Z');
  await tickAndDrain();
  let sent = await taskDue();
  assert.equal(sent.length, 1, `one reminder at 09:00 JST, got ${JSON.stringify(sent)}`);
  assert.equal(sent[0].to, tokyo.email);
  assert.equal(sent[0].dedupe_key, `task_due:${task.id}:2026-05-10`);
  assert.deepEqual(
    { task_id: sent[0].data.task_id, task_title: sent[0].data.task_title, due_date: sent[0].data.due_date, workspace_id: sent[0].data.workspace_id },
    { task_id: task.id, task_title: 'Ship release notes', due_date: '2026-05-10', workspace_id: ws.id },
  );

  await tickAndDrain();
  sent = await taskDue();
  assert.equal(sent.length, 1, 'a second tick must not send another reminder');
});

test('[B2] missed due date is never reminded later; a new due date is eligible again', async () => {
  await setClock('2026-05-11T05:00:00Z');
  const { owner, tokyo, project } = await reminderWorld();
  const task = await createTask(owner, project.id, { due_date: '2026-05-10', assignee_id: tokyo.id });
  await tickAndDrain();
  assert.deepEqual(await taskDue(), [], 'due date already passed in Tokyo; no catch-up reminder');

  await patchOk(owner, `/v1/tasks/${task.id}`, { due_date: '2026-05-11' });
  await tickAndDrain();
  const sent = await taskDue();
  assert.equal(sent.length, 1, `one reminder for the new due date, got ${JSON.stringify(sent)}`);
  assert.equal(sent[0].dedupe_key, `task_due:${task.id}:2026-05-11`);
  assert.equal(sent[0].to, tokyo.email);
});

test('[B2] done and unassigned tasks get no reminder', async () => {
  await setClock('2026-05-09T20:00:00Z');
  const { owner, tokyo, project } = await reminderWorld();
  await createTask(owner, project.id, { due_date: '2026-05-10', assignee_id: tokyo.id, status: 'done' });
  await createTask(owner, project.id, { due_date: '2026-05-10' });
  const live = await createTask(owner, project.id, { due_date: '2026-05-10', assignee_id: tokyo.id });
  await setClock('2026-05-10T01:00:00Z');
  await tickAndDrain();
  const sent = await taskDue();
  assert.deepEqual(sent.map((e) => e.dedupe_key), [`task_due:${live.id}:2026-05-10`]);
});

async function overdueWorld() {
  await setClock('2026-05-10T22:00:00Z');
  const owner = await registerUser({ name: 'Ana', timezone: 'UTC' });
  const tokyo = await registerUser({ name: 'Kenji', timezone: 'Asia/Tokyo' });
  const ny = await registerUser({ name: 'Nia', timezone: 'America/New_York' });
  const ws = await createWorkspace(owner);
  await addMember(owner, ws.id, tokyo, 'member');
  await addMember(owner, ws.id, ny, 'member');
  const project = await createProject(owner, ws.id);

  return { owner, tokyo, ny, ws, project };
}

// SPEC 3.6, 7.5
test('[B3] overdue is relative to the requesting user local date', async () => {
  const { owner, tokyo, ny, project } = await overdueWorld();
  const task = await createTask(owner, project.id, { due_date: '2026-05-10' });
  const done = await createTask(owner, project.id, { due_date: '2026-05-01', status: 'done' });

  assert.equal((await getOk(tokyo, `/v1/tasks/${task.id}`)).overdue, true, 'Tokyo is already on 11 May');
  assert.equal((await getOk(ny, `/v1/tasks/${task.id}`)).overdue, false, 'New York is still on 10 May');
  assert.equal((await getOk(tokyo, `/v1/tasks/${done.id}`)).overdue, false, 'done tasks are never overdue');

  const listIds = async (u: User, overdue: string) =>
    (await u.client.pageAll(`/v1/projects/${project.id}/tasks`, { overdue })).items.map((t) => t.id).sort();
  assert.deepEqual(await listIds(tokyo, 'true'), [task.id]);
  assert.deepEqual(await listIds(tokyo, 'false'), [done.id]);
  assert.deepEqual(await listIds(ny, 'true'), []);
  assert.deepEqual(await listIds(ny, 'false'), [task.id, done.id].sort());

  assert.equal((await getOk(tokyo, `/v1/projects/${project.id}/summary`)).overdue_count, 1);
  assert.equal((await getOk(ny, `/v1/projects/${project.id}/summary`)).overdue_count, 0);
});

test('[B3] changing the user timezone flips overdue on the next read', async () => {
  const { owner, ny, project } = await overdueWorld();
  const task = await createTask(owner, project.id, { due_date: '2026-05-10' });
  assert.equal((await getOk(ny, `/v1/tasks/${task.id}`)).overdue, false);
  await patchOk(ny, '/v1/users/me', { timezone: 'Asia/Tokyo' });
  assert.equal((await getOk(ny, `/v1/tasks/${task.id}`)).overdue, true);
});

// SPEC 8.2
test('[B3] webhook payload overdue uses the actor timezone', async (t) => {
  const { owner, tokyo, ny, ws, project } = await overdueWorld();
  const receiver = await startReceiver(ok());
  t.after(() => receiver.close());
  const hook = await createWebhook(owner, ws.id, { url: receiver.url, events: ['task.created'] });
  const byTokyo = await createTask(tokyo, project.id, { due_date: '2026-05-10' });
  const byNy = await createTask(ny, project.id, { due_date: '2026-05-10' });
  assert.equal(byTokyo.overdue, true);
  assert.equal(byNy.overdue, false);
  await drainAll();
  assert.equal(receiver.requests.length, 2);
  for (const req of receiver.requests) assertSigned(hook.secret, req);
  const payloadFor = (id: number) => receiver.requests.find((r) => r.json?.data?.task?.id === id)?.json;
  assert.equal(payloadFor(byTokyo.id)?.data.task.overdue, true, 'Tokyo actor → overdue true');
  assert.equal(payloadFor(byNy.id)?.data.task.overdue, false, 'New York actor → overdue false');
});

// SPEC 6.9
test('[B4] every timestamp is UTC with milliseconds and Z, written from the frozen clock', async (t) => {
  const frozen = '2026-05-10T09:00:00.123Z';
  await setClock(frozen);
  const receiver = await startReceiver(fail(500));
  t.after(() => receiver.close());
  const owner = await registerUser({ name: 'Ana' });
  const bo = await registerUser({ name: 'Bo' });
  assertTimestamps(owner.raw);
  assert.equal(owner.raw.user.created_at, frozen);
  const ws = await createWorkspace(owner);
  assert.equal(ws.created_at, frozen);
  const hook = await createWebhook(owner, ws.id, { url: receiver.url, events: ['*'] });
  await addMember(owner, ws.id, bo, 'member');
  const project = await createProject(owner, ws.id);
  const task = await createTask(owner, project.id, { due_date: '2026-05-20', status: 'done' });
  assert.equal(task.created_at, frozen);
  assert.equal(task.completed_at, frozen);
  const comment = await createComment(bo, task.id);
  await drainAll();

  const bodies: Json[] = [owner.raw, ws, hook, project, task, comment];
  bodies.push(await getOk(owner, '/v1/users/me'));
  bodies.push(await getOk(owner, '/v1/users/me/api-keys'));
  bodies.push(await getOk(owner, `/v1/workspaces/${ws.id}`));
  bodies.push(await getOk(owner, `/v1/workspaces/${ws.id}/members`));
  bodies.push(await getOk(owner, `/v1/workspaces/${ws.id}/activity`));
  bodies.push(await getOk(owner, `/v1/webhooks/${hook.id}`));
  const deliveries = await getOk(owner, `/v1/webhooks/${hook.id}/deliveries`);
  assert.ok(deliveries.data.length > 0, 'expected deliveries');
  assert.ok(deliveries.data.some((d: Json) => d.attempts.length > 0), 'expected at least one attempt');
  bodies.push(deliveries);
  bodies.push(await getOk(owner, `/v1/webhooks/${hook.id}/deliveries/${deliveries.data.at(-1).id}`));
  const sent = await emails();
  assert.ok(sent.length > 0, 'expected emails');
  bodies.push(sent);
  bodies.push(await jobs());
  bodies.push(await getClock());
  for (const body of bodies) assertTimestamps(body);
  const members = bodies[9].data;
  assert.ok(members.every((m: Json) => typeof m.joined_at === 'string'), 'members carry joined_at');
});

test('[B4] timestamp input with an offset is normalised to UTC', async () => {
  const now = await setClock('2026-05-10T11:59:59+02:00');
  assert.equal(now, '2026-05-10T09:59:59.000Z');
});

test('[B4] activity since/until accept offsets (since inclusive, until exclusive)', async () => {
  await setClock('2026-05-10T09:59:59Z');
  const owner = await registerUser({ name: 'Ana' });
  const ws = await createWorkspace(owner);
  const a = await createProject(owner, ws.id);
  await setClock('2026-05-10T10:00:00Z');
  const b = await createProject(owner, ws.id);
  const bound = '2026-05-10T12:00:00+02:00';
  const targets = async (q: Record<string, string>) => {
    const res = await owner.client.get(`/v1/workspaces/${ws.id}/activity`, { type: 'project.created', ...q });
    expectStatus(res, 200);
    assertTimestamps(res.body);

    return res.body.data.map((e: Json) => e.target.id);
  };
  assert.deepEqual(await targets({ since: bound }), [b.id]);
  assert.deepEqual(await targets({ until: bound }), [a.id]);
  assert.deepEqual(await targets({}), [b.id, a.id]);
});

// SPEC 10.2
test('[B5] missed 08:00 is caught up the same day but earlier dates are never backfilled', async () => {
  await setClock('2026-06-01T01:30:00Z');
  const user = await registerUser({ name: 'Ravi', timezone: 'Asia/Kolkata' });
  await tickAndDrain();
  await expectDigestDates(user, [], '07:00 IST: no digest yet');

  await advance(8 * 3600);
  await tickAndDrain();
  await expectDigestDates(user, ['2026-06-01'], '15:00 IST: same-day catch-up');

  await advance(72 * 3600);
  await tickAndDrain();
  const sent = await expectDigestDates(user, ['2026-06-01', '2026-06-04'], 'after 72 h only today is sent');
  checkDigest(sent[1], user, '2026-06-04', 'Asia/Kolkata');
});
