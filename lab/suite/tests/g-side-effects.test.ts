import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assertUnique, expectStatus } from '../lib/assert.ts';
import { advance, getClock, setClock } from '../lib/clock.ts';
import { request, type Json } from '../lib/client.ts';
import { env } from '../lib/env.ts';
import { addMember, createProject, createTask, createWebhook, createWorkspace, getOk, registerUser, registerUsers, type User } from '../lib/fixtures.ts';
import { blackhole, ok, startReceiver } from '../lib/receiver.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drain, drainAll, emails, jobs, sleep, tickAndDrain, waitUntil } from '../lib/testmode.ts';
import { killWorkers, startWorkers, workerControlSkip } from '../lib/worker.ts';

freshDatabaseEachTest();

const T0 = '2026-04-01T10:00:00.000Z';

async function withWorkersRestored(body: (state: { stopped: boolean }) => Promise<void>): Promise<void> {
  const state = { stopped: false };
  try {
    await body(state);
  } finally {
    if (state.stopped) startWorkers();
  }
}

function stop(state: { stopped: boolean }): void {
  killWorkers();
  state.stopped = true;
}

function start(state: { stopped: boolean }): void {
  startWorkers();
  state.stopped = false;
}

// SPEC 9.1, 12
test('[G1] each email is written exactly once despite repeated worker SIGKILL', { skip: workerControlSkip, timeout: 600_000 }, async () => {
  await withWorkersRestored(async (state) => {
    await setClock(T0);
    const owner = await registerUser({ name: 'Ana' });
    const ws = await createWorkspace(owner);
    stop(state);
    const users = await registerUsers(200, { name: 'Invitee' });
    for (const u of users) await addMember(owner, ws.id, u, 'member');
    for (let round = 0; round < 3; round += 1) {
      start(state);
      await sleep(100);
      stop(state);
    }
    start(state);
    for (let i = 0; i < 2; i += 1) {
      await advance(61);
      await drain();
    }
    const recipients = new Set(users.map((u) => u.email));
    const sent = (await emails({ template: 'member_added' })).filter((e) => recipients.has(e.to));
    assert.equal(sent.length, 200, `expected 200 member_added emails, got ${sent.length}`);
    assertUnique(sent.map((e) => e.dedupe_key), 'dedupe keys');
    assertUnique(sent.map((e) => e.to), 'recipients');
    if (env.emailSinkPath) {
      const lines = readFileSync(env.emailSinkPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const mine = lines.filter((e: Json) => e.template === 'member_added' && recipients.has(e.to));
      assert.equal(mine.length, 200, `sink file must hold exactly 200 lines for these recipients, got ${mine.length}`);
      assertUnique(mine.map((e: Json) => e.dedupe_key), 'sink dedupe keys');
    }
  });
});

const ZONES = ['UTC', 'Europe/London', 'Europe/Athens', 'Asia/Kolkata', 'Asia/Tokyo'];

// SPEC 10.1, 10.2
test('[G2] concurrent scheduler ticks produce exactly one digest per user and date', { timeout: 300_000 }, async () => {
  await setClock('2026-06-15T08:30:00Z');
  const users: User[] = [];
  for (const timezone of ZONES) users.push(...(await registerUsers(60, { name: 'Reader', timezone })));
  const ticks = await Promise.all(Array.from({ length: 5 }, () => request('POST', '/__test/scheduler/tick')));
  for (const r of ticks) expectStatus(r, 200);
  await drainAll();
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const mine = async () => (await emails({ template: 'daily_digest' })).filter((e) => byEmail.has(e.to));
  let sent = await mine();
  assert.equal(sent.length, 300, `expected 300 digests, got ${sent.length}`);
  assertUnique(sent.map((e) => e.to), 'digest recipients');
  for (const e of sent) assert.equal(e.dedupe_key, `daily_digest:${byEmail.get(e.to)!.id}:2026-06-15`);
  await tickAndDrain();
  sent = await mine();
  assert.equal(sent.length, 300, 'another tick in the same minute adds nothing');
});

// SPEC 12
test('[G3] work accepted while no worker runs is carried out once a worker starts', { skip: workerControlSkip, timeout: 180_000 }, async (t) => {
  await withWorkersRestored(async (state) => {
    const owner = await registerUser({ name: 'Ana' });
    const ws = await createWorkspace(owner);
    const project = await createProject(owner, ws.id);
    const receiver = await startReceiver(ok());
    t.after(() => receiver.close());
    const hook = await createWebhook(owner, ws.id, { url: receiver.url, events: ['task.created'] });
    stop(state);
    const tasks: Json[] = [];
    for (let i = 0; i < 10; i += 1) tasks.push(await createTask(owner, project.id));
    await sleep(2000);
    assert.equal(receiver.requests.length, 0, 'nothing is delivered without a worker');
    start(state);
    await drain();
    await receiver.waitForCount(10, 20_000);
    assert.deepEqual(receiver.requests.map((r) => r.json?.data?.task?.id), tasks.map((x) => x.id));
    const list = (await owner.client.pageAll(`/v1/webhooks/${hook.id}/deliveries`, { limit: 100 })).items;
    assert.equal(list.length, 10);
    assert.ok(list.every((d) => d.status === 'succeeded'), JSON.stringify(list.map((d) => d.status)));
  });
});

test('[G3] an attempt interrupted by SIGKILL is recorded as "worker terminated" and retried once', { skip: workerControlSkip, timeout: 180_000 }, async (t) => {
  await withWorkersRestored(async (state) => {
    await setClock(T0);
    const owner = await registerUser({ name: 'Ana' });
    const ws = await createWorkspace(owner);
    const project = await createProject(owner, ws.id);
    const receiver = await startReceiver(blackhole());
    t.after(() => receiver.close());
    const hook = await createWebhook(owner, ws.id, { url: receiver.url, events: ['task.created'] });
    await createTask(owner, project.id);
    await waitUntil('the first attempt to reach the receiver', () => receiver.requests.length >= 1, 10_000, 10);
    stop(state);
    receiver.setBehaviour(ok());
    start(state);
    await advance(60);
    await drain();
    await advance(30);
    await drain();
    const [d0] = (await getOk(owner, `/v1/webhooks/${hook.id}/deliveries`)).data;
    const d = await getOk(owner, `/v1/webhooks/${hook.id}/deliveries/${d0.id}`);
    assert.equal(d.attempts.length, 2, `expected two attempts, got ${JSON.stringify(d.attempts)}`);
    assert.equal(d.attempts[0].outcome, 'error');
    assert.equal(d.attempts[0].error, 'worker terminated');
    // SPEC 12: finished_at is when a worker detects the interruption; the 30 s retry is measured from it.
    assert.ok(Date.parse(d.attempts[0].finished_at) >= Date.parse(d.attempts[0].started_at), 'finished_at must not precede started_at');
    assert.ok(Date.parse(d.attempts[0].finished_at) <= Date.parse(T0) + 60_000, 'interruption must be detected within 60 s of the worker restart');
    assert.ok(
      Date.parse(d.attempts[1].started_at) - Date.parse(d.attempts[0].finished_at) >= 30_000,
      `retry must wait 30 s after the detected interruption: ${d.attempts[0].finished_at} → ${d.attempts[1].started_at}`,
    );
    assert.equal(d.attempt_count, 2);
    assert.equal(d.attempts[1].outcome, 'success');
    assert.equal(d.status, 'succeeded');
    assert.equal(receiver.requests.length, 2);
    assert.equal(receiver.requests[0].headers['x-taskwell-attempt'], '1');
    assert.equal(receiver.requests[1].headers['x-taskwell-attempt'], '2');
  });
});

// SPEC 12, 8.3
test('[G4] an endpoint that refuses connections dies alone while healthy deliveries keep flowing', { timeout: 300_000 }, async (t) => {
  await setClock(T0);
  const owner = await registerUser({ name: 'Ana' });
  const ws = await createWorkspace(owner);
  const project = await createProject(owner, ws.id);
  const healthy = await startReceiver(ok());
  t.after(() => healthy.close());
  await createWebhook(owner, ws.id, { url: healthy.url, events: ['task.created'] });
  const refused = await createWebhook(owner, ws.id, { url: 'http://127.0.0.1:1/hook', events: ['task.created'] });
  const first = await createTask(owner, project.id);
  await drainAll();
  assert.equal(healthy.requests.length, 1);
  let created = 1;
  for (const delay of [30, 120, 600, 3600, 21_600]) {
    await createTask(owner, project.id);
    created += 1;
    await drainAll();
    assert.equal(healthy.requests.length, created, 'the healthy endpoint gets every delivery promptly');
    await advance(delay);
    await drainAll();
  }
  const list = (await owner.client.pageAll(`/v1/webhooks/${refused.id}/deliveries`, { limit: 100 })).items;
  const d1 = list.find((d) => d.payload?.data?.task?.id === first.id);
  assert.ok(d1, 'the refused endpoint keeps its first delivery inspectable');
  const d = await getOk(owner, `/v1/webhooks/${refused.id}/deliveries/${d1.id}`);
  assert.equal(d.status, 'dead');
  assert.equal(d.attempts.length, 6);
  assert.ok(d.attempts.every((a: Json) => a.outcome === 'error' && a.status_code === null), JSON.stringify(d.attempts));

  const dead = await jobs('dead');
  assert.deepEqual(dead.filter((j) => j.type !== 'webhook_delivery'), [], 'only webhook deliveries may be dead');
  const now = (await getClock()).now;
  const overdue = (await jobs('pending')).filter((j) => j.run_at <= now);
  assert.deepEqual(overdue, [], 'after drain no pending job may be due');
});
