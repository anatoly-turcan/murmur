import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTimestamps, expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { request } from '../lib/client.ts';
import { addMember, createWorkspace, registerUser } from '../lib/fixtures.ts';
import { assertTestEndpointId, compareIdsDesc } from '../lib/ids.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drain } from '../lib/testmode.ts';

freshDatabaseEachTest();

const JOB_TYPES = ['webhook_delivery', 'email', 'digest', 'reminder', 'maintenance'];

test('[ERR] POST /__test/reset → 204', async () => {
  const res = await request('POST', '/__test/reset');
  expectStatus(res, 204);
  assert.equal(res.text, '');
});

test('[ERR] GET /__test/clock → 200 not overridden after reset', async () => {
  await request('PUT', '/__test/clock', { body: { now: '2026-05-10T10:00:00Z' } });
  expectStatus(await request('POST', '/__test/reset'), 204);
  const res = await request('GET', '/__test/clock');
  expectStatus(res, 200);
  assert.equal(res.body.overridden, false);
  assertTimestamps(res.body);
  assert.ok(Math.abs(Date.parse(res.body.now) - Date.now()) < 60_000, `real clock expected, got ${res.body.now}`);
});

test('[ERR] PUT /__test/clock → 200 normalises an offset to UTC', async () => {
  const res = await request('PUT', '/__test/clock', { body: { now: '2026-05-10T12:00:00+02:00' } });
  expectStatus(res, 200);
  assert.deepEqual(res.body, { now: '2026-05-10T10:00:00.000Z', overridden: true });
  const again = await request('GET', '/__test/clock');
  assert.deepEqual(again.body, { now: '2026-05-10T10:00:00.000Z', overridden: true }, 'a frozen clock does not advance on its own');
});

test('[ERR] POST /__test/clock/advance → 400 clock_not_overridden', async () => {
  expectError(await request('POST', '/__test/clock/advance', { body: { seconds: 60 } }), 400, 'clock_not_overridden');
});

test('[ERR] POST /__test/clock/advance → 422 out_of_range (negative seconds)', async () => {
  expectStatus(await request('PUT', '/__test/clock', { body: { now: '2026-05-10T10:00:00Z' } }), 200);
  expectValidation(await request('POST', '/__test/clock/advance', { body: { seconds: -1 } }), 'seconds', 'out_of_range');
  const clock = await request('GET', '/__test/clock');
  assert.equal(clock.body.now, '2026-05-10T10:00:00.000Z');
});

test('[ERR] POST /__test/clock/advance → 200 with a large value', async () => {
  expectStatus(await request('PUT', '/__test/clock', { body: { now: '2026-01-01T00:00:00Z' } }), 200);
  const tenYears = 10 * 365 * 86_400;
  const res = await request('POST', '/__test/clock/advance', { body: { seconds: tenYears } });
  expectStatus(res, 200);
  assert.deepEqual(res.body, { now: new Date(Date.parse('2026-01-01T00:00:00Z') + tenYears * 1000).toISOString(), overridden: true });
});

test('[ERR] DELETE /__test/clock → 204 and real time resumes', async () => {
  expectStatus(await request('PUT', '/__test/clock', { body: { now: '2030-01-01T00:00:00Z' } }), 200);
  expectStatus(await request('DELETE', '/__test/clock'), 204);
  const clock = await request('GET', '/__test/clock');
  expectStatus(clock, 200);
  assert.equal(clock.body.overridden, false);
  assert.ok(Math.abs(Date.parse(clock.body.now) - Date.now()) < 60_000);
});

test('[ERR] POST /__test/scheduler/tick → 200 with counters', async () => {
  const res = await request('POST', '/__test/scheduler/tick');
  expectStatus(res, 200);
  assert.ok(Number.isInteger(res.body.digests_created) && res.body.digests_created >= 0, res.text);
  assert.ok(Number.isInteger(res.body.reminders_created) && res.body.reminders_created >= 0, res.text);
});

test('[ERR] POST /__test/jobs/drain → 200 with counters', async () => {
  const res = await request('POST', '/__test/jobs/drain');
  expectStatus(res, 200);
  assert.equal(res.body.drained, true, 'an empty database drains immediately');
  for (const k of ['pending', 'running', 'dead']) assert.ok(Number.isInteger(res.body[k]), `${k} must be an integer: ${res.text}`);
  assert.equal(res.body.pending, 0);
  assert.equal(res.body.running, 0);
});

test('[ERR] GET /__test/jobs → 200 with job items for each status filter', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const bo = await registerUser({ name: 'Bo' });
  const ws = await createWorkspace(ana);
  await addMember(ana, ws.id, bo, 'member');
  const all = await request('GET', '/__test/jobs');
  expectStatus(all, 200);
  assert.ok(all.body.data.length >= 1, 'adding a member must enqueue at least one job (member_added email)');
  for (const job of all.body.data) {
    assertTestEndpointId(job.id, 'job.id');
    assert.ok(JOB_TYPES.includes(job.type), `job.type ${job.type} not in ${JOB_TYPES}`);
    assert.ok(['pending', 'running', 'succeeded', 'dead'].includes(job.status));
    assert.ok(Number.isInteger(job.attempt_count));
    assert.ok('last_error' in job);
    assertTimestamps(job);
  }
  const sortedDesc = [...all.body.data].sort((a: any, b: any) => compareIdsDesc(a.id, b.id)).map((j: any) => j.id);
  assert.deepEqual(all.body.data.map((j: any) => j.id), sortedDesc, 'jobs are ordered id desc');
  await drain();
  for (const status of ['pending', 'running', 'succeeded', 'dead']) {
    const res = await request('GET', '/__test/jobs', { query: { status } });
    expectStatus(res, 200);
    assert.ok(res.body.data.every((j: any) => j.status === status), `status=${status} filter leaked: ${res.text.slice(0, 300)}`);
  }
  const succeeded = await request('GET', '/__test/jobs', { query: { status: 'succeeded' } });
  assert.ok(succeeded.body.data.some((j: any) => j.type === 'email'), 'the member_added email job must have succeeded after drain');
});

test('[ERR] GET /__test/emails → 200 filtered by to, template and dedupe_key', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const bo = await registerUser({ name: 'Bo' });
  const cy = await registerUser({ name: 'Cy' });
  const ws = await createWorkspace(ana);
  await addMember(ana, ws.id, bo, 'member');
  await addMember(ana, ws.id, cy, 'viewer');
  await drain();
  const all = await request('GET', '/__test/emails');
  expectStatus(all, 200);
  assert.equal(all.body.data.length, 2);
  const byTo = await request('GET', '/__test/emails', { query: { to: bo.email } });
  assert.deepEqual(byTo.body.data.map((e: any) => e.to), [bo.email]);
  const byTemplate = await request('GET', '/__test/emails', { query: { template: 'task_assigned' } });
  assert.deepEqual(byTemplate.body.data, []);
  const key = byTo.body.data[0].dedupe_key;
  const byKey = await request('GET', '/__test/emails', { query: { dedupe_key: key } });
  assert.equal(byKey.body.data.length, 1);
  assert.equal(byKey.body.data[0].to, bo.email);
});

test('[ERR] DELETE /__test/emails → 204 and the outbox is empty', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const bo = await registerUser({ name: 'Bo' });
  const ws = await createWorkspace(ana);
  await addMember(ana, ws.id, bo, 'member');
  await drain();
  const before = await request('GET', '/__test/emails');
  assert.equal(before.body.data.length, 1);
  expectStatus(await request('DELETE', '/__test/emails'), 204);
  const after = await request('GET', '/__test/emails');
  expectStatus(after, 200);
  assert.deepEqual(after.body.data, []);
});

test('[ERR] POST /__test/seed → 409 database_not_empty', async () => {
  await registerUser({ name: 'Ana' });
  expectError(await request('POST', '/__test/seed', { body: { profile: 'reference' } }), 409, 'database_not_empty');
});

test('[ERR] /__test/* → no authentication and no rate limit', async () => {
  const results = [];
  for (let i = 0; i < 40; i += 1) results.push((await request('GET', '/__test/clock')).status);
  assert.deepEqual([...new Set(results)], [200], `40 unauthenticated GET /__test/clock from one IP must all be 200, got ${results}`);
});
