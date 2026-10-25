import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus } from '../lib/assert.ts';
import { addSeconds, advance, getClock, setClock, unixSeconds } from '../lib/clock.ts';
import type { Json } from '../lib/client.ts';
import { env } from '../lib/env.ts';
import {
  activity,
  addMember,
  createComment,
  createProject,
  createTask,
  createWebhook,
  createWorkspace,
  deleteOk,
  getOk,
  patchOk,
  postOk,
  registerUser,
  type User,
} from '../lib/fixtures.ts';
import { assertCreationOrderedIds, idFromHeader } from '../lib/ids.ts';
import { assertSigned, blackhole, fail, ok, redirect, slow, startReceiver, type Behaviour, type BehaviourFn, type Receiver } from '../lib/receiver.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drainAll, jobs, sleep } from '../lib/testmode.ts';

freshDatabaseEachTest();

const T0 = '2026-04-01T10:00:00.000Z';
const SCHEDULE = [30, 120, 600, 3600, 21_600];

interface HookWorld {
  owner: User;
  ws: Json;
  project: Json;
  receiver: Receiver;
  hook: Json;
}

async function hookWorld(t: { after: (fn: () => unknown) => void }, behaviour: Behaviour | BehaviourFn, events: string[] = ['task.created']): Promise<HookWorld> {
  await setClock(T0);
  const owner = await registerUser({ name: 'Ana' });
  const ws = await createWorkspace(owner);
  const project = await createProject(owner, ws.id);
  const receiver = await startReceiver(behaviour);
  t.after(() => receiver.close());
  const hook = await createWebhook(owner, ws.id, { url: receiver.url, events });

  return { owner, ws, project, receiver, hook };
}

async function deliveries(owner: User, hookId: number): Promise<Json[]> {
  return (await owner.client.pageAll(`/v1/webhooks/${hookId}/deliveries`, { limit: 100 })).items;
}

async function onlyDelivery(owner: User, hookId: number): Promise<Json> {
  const list = await deliveries(owner, hookId);
  assert.equal(list.length, 1, `expected exactly one delivery, got ${list.length}`);

  return getOk(owner, `/v1/webhooks/${hookId}/deliveries/${list[0].id}`);
}

function failSlowly(status: number, delayMs: number): Behaviour {
  return { kind: 'respond', status, delayMs };
}

function attemptHeader(r: Receiver, i: number): string | undefined {
  return r.requests[i]?.headers['x-taskwell-attempt'];
}

// SPEC 8.3
test('[F1] retry schedule 30s/2m/10m/1h/6h on the application clock, then dead, then redeliver', async (t) => {
  const { owner, project, receiver, hook } = await hookWorld(t, fail(500));
  await createTask(owner, project.id);
  await drainAll();
  assert.equal(receiver.requests.length, 1);
  assert.equal(attemptHeader(receiver, 0), '1');
  let d = await onlyDelivery(owner, hook.id);
  assert.equal(d.status, 'pending');
  assert.equal(d.attempt_count, 1);
  assert.equal(d.completed_at, null, 'completed_at stays null while pending (SPEC 7.10)');
  assert.deepEqual(
    { number: d.attempts[0].number, outcome: d.attempts[0].outcome, status_code: d.attempts[0].status_code },
    { number: 1, outcome: 'failure', status_code: 500 },
  );
  assert.equal(d.next_attempt_at, addSeconds(d.attempts[0].finished_at, 30));

  for (let i = 0; i < SCHEDULE.length; i += 1) {
    const delay = SCHEDULE[i];
    await advance(delay - 1);
    await drainAll();
    assert.equal(receiver.requests.length, i + 1, `no attempt ${i + 2} after ${delay - 1}s`);
    await advance(1);
    await drainAll();
    assert.equal(receiver.requests.length, i + 2, `attempt ${i + 2} due exactly ${delay}s after attempt ${i + 1} finished`);
    assert.equal(attemptHeader(receiver, i + 1), String(i + 2));
    d = await getOk(owner, `/v1/webhooks/${hook.id}/deliveries/${d.id}`);
    assert.equal(d.attempts.length, i + 2);
    if (i + 2 < 6) {
      assert.equal(d.status, 'pending');
      assert.equal(d.next_attempt_at, addSeconds(d.attempts[i + 1].finished_at, SCHEDULE[i + 1]));
    }
  }
  assert.equal(d.status, 'dead');
  assert.equal(d.next_attempt_at, null);
  assert.equal(d.attempt_count, 6);
  assert.equal(d.completed_at, d.attempts[5].finished_at, 'completed_at is set when the delivery dies');
  assert.deepEqual(d.attempts.map((a: Json) => a.number), [1, 2, 3, 4, 5, 6]);
  assert.ok(d.attempts.every((a: Json) => a.outcome === 'failure' && a.status_code === 500));

  const re = await owner.client.post(`/v1/webhooks/${hook.id}/deliveries/${d.id}/redeliver`);
  expectStatus(re, 202);
  assert.equal(re.body.id, d.id);
  assert.equal(re.body.status, 'pending');
  assert.equal(re.body.completed_at, null, 'redelivery resets completed_at');
  assert.equal(re.body.attempt_count, 6, 'attempt_count is the total across series');
  await drainAll();
  assert.equal(receiver.requests.length, 7, 'redeliver makes one immediate attempt');
  assert.equal(attemptHeader(receiver, 6), '7');
  d = await getOk(owner, `/v1/webhooks/${hook.id}/deliveries/${d.id}`);
  assert.equal(d.attempts.length, 7);
  assert.equal(d.attempts[6].number, 7);
  assert.equal(d.attempt_count, 7);
  assert.equal(d.status, 'pending');
  assert.equal(d.completed_at, null);
  assert.equal(d.next_attempt_at, addSeconds(d.attempts[6].finished_at, 30));
});

test('[F1] a redirect is not followed and counts as a failed attempt', async (t) => {
  const { owner, project, receiver, hook } = await hookWorld(t, redirect());
  await createTask(owner, project.id);
  await drainAll();
  assert.equal(receiver.requests.length, 1);
  const d = await onlyDelivery(owner, hook.id);
  assert.equal(d.status, 'pending');
  assert.equal(d.attempts[0].outcome, 'failure');
  assert.equal(d.attempts[0].status_code, 302);
  assert.equal(d.next_attempt_at, addSeconds(d.attempts[0].finished_at, 30));
});

// SPEC 8.3
test('[F2] per-endpoint ordering: a retrying delivery blocks later ones; other endpoints are independent', async (t) => {
  const a = await hookWorld(t, (_req, i) => (i === 0 ? failSlowly(500, 50) : ok(50)));
  const b = await startReceiver(ok(50));
  t.after(() => b.close());
  await createWebhook(a.owner, a.ws.id, { url: b.url, events: ['task.created'] });
  const tasks: Json[] = [];
  for (let i = 0; i < 5; i += 1) tasks.push(await createTask(a.owner, a.project.id, { title: `Ordered ${i}` }));
  const taskIds = tasks.map((x) => x.id);

  await drainAll();
  assert.equal(a.receiver.requests.length, 1, 'endpoint A is blocked behind its failed first delivery');
  assert.deepEqual(b.requests.map((r) => r.json?.data?.task?.id), taskIds, 'endpoint B receives all five in creation order');

  await advance(30);
  await drainAll();
  await a.receiver.waitForCount(6, 15_000);
  const seq = a.receiver.requests.map((r) => r.json?.data?.task?.id);
  assert.deepEqual(seq, [taskIds[0], ...taskIds], 'A receives d1 (retry) then d2..d5 in order');
  const deliveryIds = a.receiver.requests.slice(1).map((r) => idFromHeader(r.headers['x-taskwell-delivery-id']));
  assertCreationOrderedIds(deliveryIds, 'delivery ids ascend with creation order');
  for (const r of [a.receiver, b]) {
    assert.equal(r.maxInFlight, 1, 'only one delivery per endpoint in flight');
    for (let i = 1; i < r.requests.length; i += 1) {
      const prev = r.requests[i - 1];
      assert.ok(prev.respondedAt !== null && r.requests[i].receivedAt >= prev.respondedAt, `request ${i} arrived before request ${i - 1} was answered`);
    }
  }
});

// SPEC 8.2
test('[F3] signed headers, identical body bytes across attempts, payload stored on the delivery', async (t) => {
  const { owner, ws, project, receiver, hook } = await hookWorld(t, (_req, i) => (i === 0 ? fail(500) : ok()));
  const task = await createTask(owner, project.id, { title: 'Signed payload' });
  await drainAll();
  await advance(30);
  await drainAll();
  assert.equal(receiver.requests.length, 2);
  const d = await onlyDelivery(owner, hook.id);
  const [r1, r2] = receiver.requests;
  for (const [i, r] of [r1, r2].entries()) {
    assert.equal(r.method, 'POST');
    assert.match(r.headers['content-type'] ?? '', /^application\/json/);
    assert.equal(r.headers['user-agent'], 'Taskwell-Webhooks/1');
    assert.equal(r.headers['x-taskwell-event'], 'task.created');
    assert.equal(r.headers['x-taskwell-delivery-id'], String(d.id));
    assert.equal(r.headers['x-taskwell-attempt'], String(i + 1));
    assertSigned(hook.secret, r);
  }
  assert.equal(r1.headers['x-taskwell-timestamp'], String(unixSeconds(T0)));
  assert.equal(r2.headers['x-taskwell-timestamp'], String(unixSeconds(T0) + 30));
  assert.ok(r1.raw.equals(r2.raw), 'body bytes must be identical on every attempt');
  assert.notEqual(r1.headers['x-taskwell-signature'], r2.headers['x-taskwell-signature']);
  assert.deepEqual(d.payload, r1.json);

  const created = (await activity(owner, ws.id, { type: 'task.created' }))[0];
  assert.equal(r1.json.delivery_id, d.id);
  assert.equal(r1.json.event, 'task.created');
  assert.equal(r1.json.workspace_id, ws.id);
  assert.equal(r1.json.occurred_at, created.occurred_at);
  assert.deepEqual(r1.json.actor, { id: owner.id, name: 'Ana', deleted: false });
  assert.deepEqual(r1.json.data.task, task);
  assert.equal(d.event, 'task.created');
  assert.equal(d.webhook_id, hook.id);
});

test('[F3] payload data shape per event type', async (t) => {
  const { owner, ws, receiver } = await hookWorld(t, ok(), ['*']);
  const bo = await registerUser({ name: 'Bo' });
  await addMember(owner, ws.id, bo, 'member');
  const project = await createProject(owner, ws.id, { name: 'Payloads' });
  const task = await createTask(owner, project.id, { title: 'Shape' });
  const updated = await patchOk(owner, `/v1/tasks/${task.id}`, { status: 'done' });
  const comment = await createComment(owner, task.id, 'Shape check');
  await patchOk(owner, `/v1/workspaces/${ws.id}`, { name: 'Renamed workspace' });
  await drainAll();

  const byEvent = new Map<string, Json[]>();
  for (const r of receiver.requests) byEvent.set(r.json.event, [...(byEvent.get(r.json.event) ?? []), r.json]);
  assert.deepEqual([...byEvent.keys()].sort(), ['comment.created', 'member.added', 'project.created', 'task.created', 'task.updated']);
  for (const list of byEvent.values()) assert.equal(list.length, 1);

  const members = await getOk(owner, `/v1/workspaces/${ws.id}/members`);
  const boItem = members.data.find((m: Json) => m.user.id === bo.id);
  assert.deepEqual(byEvent.get('member.added')![0].data.member, boItem);
  assert.deepEqual(byEvent.get('project.created')![0].data.project, project);
  assert.deepEqual(byEvent.get('task.created')![0].data.task, task);
  const upd = byEvent.get('task.updated')![0];
  const updEvent = (await activity(owner, ws.id, { type: 'task.updated' }))[0];
  assert.deepEqual(upd.data.changes, updEvent.changes);
  assert.deepEqual(upd.data.changes.status, { from: 'open', to: 'done' });
  assert.deepEqual(upd.data.task, updated);
  const com = byEvent.get('comment.created')![0];
  assert.deepEqual(com.data.comment, comment);
  assert.equal(com.data.task_id, task.id);
});

// SPEC 8.1: the list is exhaustive; workspace.*, webhook.*, member.role_changed, ownership.transferred and comment.restored never deliver.
test('[F3] "*" subscribes to exactly the 13 webhook event types, in order', async (t) => {
  const { owner, ws, receiver, hook } = await hookWorld(t, ok(), ['*']);
  const bo = await registerUser({ name: 'Bo' });
  const cy = await registerUser({ name: 'Cy' });
  await addMember(owner, ws.id, bo, 'member');
  await addMember(owner, ws.id, cy, 'member');
  await patchOk(owner, `/v1/workspaces/${ws.id}/members/${bo.id}`, { role: 'viewer' });
  const project = await createProject(owner, ws.id);
  await patchOk(owner, `/v1/projects/${project.id}`, { description: 'x' });
  const task = await createTask(owner, project.id);
  await patchOk(owner, `/v1/tasks/${task.id}`, { title: 'Changed' });
  const comment = await createComment(owner, task.id);
  await patchOk(owner, `/v1/comments/${comment.id}`, { body: 'Edited' });
  await deleteOk(owner, `/v1/comments/${comment.id}`);
  await postOk(owner, `/v1/comments/${comment.id}/restore`);
  await deleteOk(owner, `/v1/tasks/${task.id}`);
  await postOk(owner, `/v1/tasks/${task.id}/restore`);
  await deleteOk(owner, `/v1/projects/${project.id}`);
  await postOk(owner, `/v1/projects/${project.id}/restore`);
  await deleteOk(owner, `/v1/workspaces/${ws.id}/members/${bo.id}`);
  await patchOk(owner, `/v1/workspaces/${ws.id}`, { name: 'Renamed' });
  await patchOk(owner, `/v1/webhooks/${hook.id}`, { active: true });
  await postOk(owner, `/v1/workspaces/${ws.id}/transfer-ownership`, { user_id: cy.id });
  await postOk(cy, `/v1/workspaces/${ws.id}/transfer-ownership`, { user_id: owner.id });
  const types = (await activity(owner, ws.id)).map((e) => e.type);
  for (const silent of ['member.role_changed', 'ownership.transferred', 'comment.restored', 'workspace.updated', 'webhook.updated']) {
    assert.ok(types.includes(silent), `fixture must have produced ${silent}`);
  }
  const expected = [
    'member.added',
    'member.added',
    'project.created',
    'project.updated',
    'task.created',
    'task.updated',
    'comment.created',
    'comment.updated',
    'comment.deleted',
    'task.deleted',
    'task.restored',
    'project.deleted',
    'project.restored',
    'member.removed',
  ];
  const listed = (await deliveries(owner, hook.id)).map((d) => d.event).reverse();
  assert.deepEqual(listed, expected, 'deliveries (oldest first) must be exactly the deliverable types');
  await drainAll();
  assert.deepEqual(receiver.requests.map((r) => r.headers['x-taskwell-event']), expected);
});

test('[F3] an endpoint only receives the event types it subscribes to', async (t) => {
  const { owner, project, receiver, hook } = await hookWorld(t, ok(), ['task.created']);
  const task = await createTask(owner, project.id);
  await patchOk(owner, `/v1/tasks/${task.id}`, { status: 'done' });
  await createComment(owner, task.id);
  const list = await deliveries(owner, hook.id);
  assert.deepEqual(list.map((d) => d.event), ['task.created']);
  await drainAll();
  assert.equal(receiver.requests.length, 1);
});

// SPEC 8.1
test('[F4] the delivery is listed as soon as the request returns and the request never waits for the receiver', async (t) => {
  const { owner, project, hook } = await hookWorld(t, blackhole());
  const res = await owner.client.post(`/v1/projects/${project.id}/tasks`, { title: 'Fast' });
  expectStatus(res, 201);
  assert.ok(res.durationMs < env.candidateWebhookTimeoutMs, `task create took ${res.durationMs.toFixed(0)} ms with a black-hole receiver`);
  const list = await deliveries(owner, hook.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].event, 'task.created');
  assert.ok(['pending', 'in_progress'].includes(list[0].status), `status ${list[0].status}`);
});

function p99(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);

  return sorted[Math.ceil(sorted.length * 0.99) - 1];
}

// SPEC 14.2
test('[F4] a black-hole receiver does not slow task creation', { timeout: 600_000 }, async (t) => {
  await setClock(T0);
  const owner = await registerUser({ name: 'Ana' });
  const ws = await createWorkspace(owner);
  const project = await createProject(owner, ws.id);
  const measure = async (n: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const res = await owner.client.post(`/v1/projects/${project.id}/tasks`, { title: `Latency ${i}` });
      expectStatus(res, 201);
      out.push(res.durationMs);
    }

    return out;
  };
  const without = p99(await measure(200));
  await advance(60);
  const receiver = await startReceiver(blackhole());
  t.after(() => receiver.close());
  await createWebhook(owner, ws.id, { url: receiver.url, events: ['task.created'] });
  const withHook = p99(await measure(200));
  t.diagnostic(`p99 without webhook ${without.toFixed(1)} ms, with black-hole webhook ${withHook.toFixed(1)} ms`);
  assert.ok(withHook <= 150, `p99 with black-hole webhook ${withHook.toFixed(1)} ms > 150 ms`);
  assert.ok(withHook - without < 20, `p99 grew by ${(withHook - without).toFixed(1)} ms with a black-hole webhook`);
});

// SPEC 8.3
test('[F5] a slow receiver times out once; no overlapping attempt until the retry is due', { timeout: 120_000 }, async (t) => {
  const timeoutMs = env.candidateWebhookTimeoutMs;
  const { owner, project, receiver, hook } = await hookWorld(t, slow(3 * timeoutMs));
  await createTask(owner, project.id);
  await drainAll();
  await sleep(3 * timeoutMs);
  let d = await onlyDelivery(owner, hook.id);
  assert.equal(receiver.requests.length, 1, 'exactly one request so far');
  assert.equal(d.attempt_count, 1);
  assert.equal(d.attempts.length, 1);
  assert.equal(d.attempts[0].outcome, 'timeout');
  assert.equal(d.attempts[0].status_code, null);
  assert.equal(typeof d.attempts[0].error, 'string');
  assert.equal(d.status, 'pending');
  assert.equal(d.next_attempt_at, addSeconds(d.attempts[0].finished_at, 30));

  receiver.setBehaviour(ok());
  await advance(30);
  await drainAll();
  d = await getOk(owner, `/v1/webhooks/${hook.id}/deliveries/${d.id}`);
  assert.equal(receiver.requests.length, 2);
  assert.equal(d.attempts.length, 2);
  assert.equal(d.attempts[1].outcome, 'success');
  assert.equal(d.status, 'succeeded');
  assert.equal(d.completed_at, d.attempts[d.attempts.length - 1].finished_at, 'completed_at is set on success');
  assert.equal(receiver.maxInFlight, 1);
});

// SPEC 7.10
test('[F6] redeliver is refused unless the delivery is dead', async (t) => {
  const good = await hookWorld(t, ok());
  const bad = await startReceiver(fail(500));
  t.after(() => bad.close());
  const badHook = await createWebhook(good.owner, good.ws.id, { url: bad.url, events: ['task.created'] });
  await createTask(good.owner, good.project.id);
  await drainAll();
  const succeeded = await onlyDelivery(good.owner, good.hook.id);
  assert.equal(succeeded.status, 'succeeded');
  const pending = await onlyDelivery(good.owner, badHook.id);
  assert.equal(pending.status, 'pending');
  expectError(await good.owner.client.post(`/v1/webhooks/${good.hook.id}/deliveries/${succeeded.id}/redeliver`), 409, 'not_redeliverable');
  expectError(await good.owner.client.post(`/v1/webhooks/${badHook.id}/deliveries/${pending.id}/redeliver`), 409, 'not_redeliverable');
  await drainAll();
  assert.equal(good.receiver.requests.length, 1, 'a refused redeliver must not send anything');
});

// SPEC 7.10: attempt_count is the total across series; completed_at is set on dead and reset by redelivery.
test('[F6] redeliver of a dead delivery: 202, completed_at null, attempt_count keeps counting', async (t) => {
  const { owner, ws, project, receiver, hook } = await hookWorld(t, fail(500));
  await createTask(owner, project.id);
  await drainAll();
  for (const delay of SCHEDULE) {
    await advance(delay);
    await drainAll();
  }
  const dead = await onlyDelivery(owner, hook.id);
  assert.equal(dead.status, 'dead');
  assert.equal(dead.attempt_count, 6);
  assert.match(dead.completed_at ?? '', /Z$/, 'a dead delivery has completed_at');
  const re = await owner.client.post(`/v1/webhooks/${hook.id}/deliveries/${dead.id}/redeliver`);
  expectStatus(re, 202);
  assert.equal(re.body.status, 'pending');
  assert.equal(re.body.completed_at, null);
  assert.equal(re.body.attempt_count, 6);
  assert.equal(re.body.attempts.length, 6);
  const events = (await activity(owner, ws.id)).map((e) => e.type);
  await drainAll();
  assert.equal(receiver.requests.length, 7);
  assert.equal(receiver.requests[6].headers['x-taskwell-attempt'], '7');
  const after = await onlyDelivery(owner, hook.id);
  assert.equal(after.attempt_count, 7);
  assert.equal(after.completed_at, null, 'still pending after a failed seventh attempt');
  const eventsAfter = (await activity(owner, ws.id)).map((e) => e.type);
  assert.deepEqual(eventsAfter, events, 'redelivery produces no activity event');
});

test('[F6] deleting an endpoint removes it and its pending deliveries are never attempted', async (t) => {
  const { owner, project, receiver, hook } = await hookWorld(t, fail(500));
  for (let i = 0; i < 3; i += 1) await createTask(owner, project.id);
  await drainAll();
  assert.equal(receiver.requests.length, 1);
  const list = await deliveries(owner, hook.id);
  assert.equal(list.length, 3);
  await deleteOk(owner, `/v1/webhooks/${hook.id}`);
  expectError(await owner.client.get(`/v1/webhooks/${hook.id}`), 404, 'not_found');
  expectError(await owner.client.get(`/v1/webhooks/${hook.id}/deliveries`), 404, 'not_found');
  expectError(await owner.client.get(`/v1/webhooks/${hook.id}/deliveries/${list[0].id}`), 404, 'not_found');
  await advance(7 * 3600);
  await drainAll();
  assert.equal(receiver.requests.length, 1, 'no attempt after the endpoint was deleted');
  const now = (await getClock()).now;
  const due = (await jobs('pending')).filter((j) => j.type === 'webhook_delivery' && j.run_at <= now);
  assert.deepEqual(due, [], 'no due webhook_delivery job may remain pending');
});

test('[F6] workspace deletion cancels pending deliveries; they stay cancelled after restore', async (t) => {
  const { owner, ws, project, receiver, hook } = await hookWorld(t, fail(500));
  await createTask(owner, project.id);
  await drainAll();
  assert.equal(receiver.requests.length, 1);
  const [first] = await deliveries(owner, hook.id);
  await deleteOk(owner, `/v1/workspaces/${ws.id}`);
  await postOk(owner, `/v1/workspaces/${ws.id}/restore`);
  const cancelled = await getOk(owner, `/v1/webhooks/${hook.id}/deliveries/${first.id}`);
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.completed_at ?? '', /Z$/, 'completed_at is set when a delivery is cancelled');
  await advance(60);
  await drainAll();
  assert.equal(receiver.requests.length, 1, 'a cancelled delivery is never attempted again');

  receiver.setBehaviour(ok());
  const fresh = await createTask(owner, project.id);
  await drainAll();
  assert.equal(receiver.requests.length, 2, 'the endpoint resumes receiving new deliveries');
  assert.equal(receiver.requests[1].json.data.task.id, fresh.id);
});

test('[F6] active:false stops new deliveries but pending ones continue', async (t) => {
  const { owner, project, receiver, hook } = await hookWorld(t, (_req, i) => (i === 0 ? fail(500) : ok()));
  const first = await createTask(owner, project.id);
  await drainAll();
  const patched = await patchOk(owner, `/v1/webhooks/${hook.id}`, { active: false });
  assert.equal(patched.active, false);
  await createTask(owner, project.id);
  assert.equal((await deliveries(owner, hook.id)).length, 1, 'no new delivery for an inactive endpoint');
  await advance(30);
  await drainAll();
  assert.equal(receiver.requests.length, 2);
  assert.ok(receiver.requests.every((r) => r.json.data.task.id === first.id));
  assert.equal((await onlyDelivery(owner, hook.id)).status, 'succeeded');
});

test('[F6] deleting a project does not affect pending deliveries', async (t) => {
  const { owner, project, receiver, hook } = await hookWorld(t, (_req, i) => (i === 0 ? fail(500) : ok()));
  const task = await createTask(owner, project.id);
  await drainAll();
  await deleteOk(owner, `/v1/projects/${project.id}`);
  await advance(30);
  await drainAll();
  assert.equal(receiver.requests.length, 2);
  assert.equal(receiver.requests[1].json.data.task.id, task.id);
  assert.equal((await onlyDelivery(owner, hook.id)).status, 'succeeded');
});
