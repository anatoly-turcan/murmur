import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectRateLimitHeaders, expectStatus } from '../lib/assert.ts';
import { advance, setClock } from '../lib/clock.ts';
import { anonymous, Client, nextIp, request, type ApiResponse } from '../lib/client.ts';
import { addMember, createTask, createWorkspace, registerUser, team, uniqueEmail, type User } from '../lib/fixtures.ts';
import { NONEXISTENT_ID } from '../lib/ids.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

// SPEC 6.8: fixed one-minute windows aligned to the application clock; freezing at :00 makes Reset = 60.
const WINDOW_START = '2026-06-01T10:00:00Z';
const UNKNOWN_KEY = `twl_${'Z'.repeat(40)}`;

async function burst(n: number, call: () => Promise<ApiResponse>, parallel = 25): Promise<ApiResponse[]> {
  const out: ApiResponse[] = [];
  for (let i = 0; i < n; i += parallel) {
    out.push(...(await Promise.all(Array.from({ length: Math.min(parallel, n - i) }, call))));
  }

  return out;
}

function pinned(user: User, ip = nextIp()): Client {
  return new Client(user.key, ip);
}

function expect429(res: ApiResponse, secondsLeft: number): void {
  expectError(res, 429, 'rate_limited');
  assert.equal(res.headers.get('retry-after'), String(secondsLeft), 'Retry-After must be whole seconds to the window end');
  const h = expectRateLimitHeaders(res);
  assert.equal(h.remaining, 0);
  assert.equal(h.reset, secondsLeft);
}

test('[J1] viewer gets 60 workspace requests per minute, then 429 with Retry-After', async () => {
  await setClock(WINDOW_START);
  const t = await team({ admins: 0, members: 0, viewers: 1 });
  const task = await createTask(t.owner, t.project.id);
  const viewer = pinned(t.viewer);
  for (let i = 1; i <= 60; i += 1) {
    const res = await viewer.get(`/v1/tasks/${task.id}`);
    expectStatus(res, 200, `viewer request ${i}`);
    const h = expectRateLimitHeaders(res);
    assert.equal(h.limit, 60, `request ${i}: RateLimit-Limit must describe the viewer bucket`);
    assert.equal(h.remaining, 60 - i, `request ${i}: RateLimit-Remaining`);
    assert.equal(h.reset, 60);
  }
  expect429(await viewer.get(`/v1/tasks/${task.id}`), 60);
});

test('[J1] the role bucket is per workspace: the same key is still served where it is admin', async () => {
  await setClock(WINDOW_START);
  const t = await team({ admins: 0, members: 0, viewers: 1 });
  const other = await createWorkspace(t.owner);
  await addMember(t.owner, other.id, t.viewer, 'admin');
  const viewer = pinned(t.viewer);
  await burst(60, () => viewer.get(`/v1/workspaces/${t.ws.id}`));
  expect429(await viewer.get(`/v1/workspaces/${t.ws.id}`), 60);
  const res = await viewer.get(`/v1/workspaces/${other.id}`);
  expectStatus(res, 200);
  const h = expectRateLimitHeaders(res);
  assert.equal(h.limit, 600);
  assert.equal(h.remaining, 599);
});

test('[J1] the window resets when the application clock reaches the next minute', async () => {
  await setClock(WINDOW_START);
  const t = await team({ admins: 0, members: 0, viewers: 1 });
  const viewer = pinned(t.viewer);
  await burst(60, () => viewer.get(`/v1/workspaces/${t.ws.id}`));
  expect429(await viewer.get(`/v1/workspaces/${t.ws.id}`), 60);
  await advance(30);
  expect429(await viewer.get(`/v1/workspaces/${t.ws.id}`), 30);
  await advance(30);
  const res = await viewer.get(`/v1/workspaces/${t.ws.id}`);
  expectStatus(res, 200);
  assert.equal(expectRateLimitHeaders(res).remaining, 59);
});

test('[J1] RateLimit-Reset counts whole seconds to the end of the clock-aligned window', async () => {
  await setClock('2026-06-01T10:00:15Z');
  const ana = await registerUser();
  const res = await pinned(ana).get('/v1/users/me');
  expectStatus(res, 200);
  assert.equal(expectRateLimitHeaders(res).reset, 45);
});

test('[J1] 429 responses are not counted in any bucket', async () => {
  await setClock(WINDOW_START);
  const ip = nextIp();
  const t = await team({ admins: 0, members: 0, viewers: 1 });
  const solo = await registerUser();
  const soloWs = await createWorkspace(solo);
  const viewer = pinned(t.viewer, ip);
  await burst(60, () => viewer.get(`/v1/workspaces/${t.ws.id}`));
  const rejected = await burst(600, () => viewer.get(`/v1/workspaces/${t.ws.id}`), 50);
  assert.ok(rejected.every((r) => r.status === 429), 'all extra viewer requests must be 429');
  const res = await pinned(solo, ip).get(`/v1/workspaces/${soloWs.id}`);
  expectStatus(res, 200);
  const h = expectRateLimitHeaders(res);
  // If the 600 rejections had counted against the shared IP bucket (1,200), it would be the tightest at 539.
  assert.deepEqual([h.limit, h.remaining], [600, 599]);
});

test('[J1] requests answered 401 count against the unauthenticated IP bucket; the 31st gets 429', async () => {
  await setClock(WINDOW_START);
  const ip = nextIp();
  for (let i = 1; i <= 30; i += 1) {
    const res = await request('GET', '/v1/users/me', { key: UNKNOWN_KEY, ip });
    expectError(res, 401, 'invalid_api_key');
    const h = expectRateLimitHeaders(res);
    assert.equal(h.limit, 30);
    assert.equal(h.remaining, 30 - i);
  }
  expect429(await request('GET', '/v1/users/me', { key: UNKNOWN_KEY, ip }), 60);
  expect429(await request('GET', '/v1/users/me', { ip }), 60);
});

test('[J1] 31st registration from one IP is 429; another X-Forwarded-For is unaffected', async () => {
  await setClock(WINDOW_START);
  const ip = nextIp();
  const results = await burst(30, () => anonymous(ip).post('/v1/users', { email: uniqueEmail('rl'), name: 'Rl' }));
  for (const r of results) expectStatus(r, 201);
  expect429(await anonymous(ip).post('/v1/users', { email: uniqueEmail('rl'), name: 'Rl' }), 60);
  expectStatus(await anonymous(nextIp()).post('/v1/users', { email: uniqueEmail('rl'), name: 'Rl' }), 201);
});

test('[J1] key general bucket: 120 non-workspace requests per key per minute', async () => {
  await setClock(WINDOW_START);
  const ana = await registerUser();
  const client = pinned(ana);
  const results = await burst(120, () => client.get('/v1/users/me'));
  for (const r of results) expectStatus(r, 200);
  const last = expectRateLimitHeaders(results[results.length - 1]);
  assert.equal(last.limit, 120);
  expect429(await client.get('/v1/users/me'), 60);
});

test('[J1] workspace-scoped requests from a non-member count in the key general bucket', async () => {
  await setClock(WINDOW_START);
  const t = await team({ admins: 0, members: 0, viewers: 0 });
  const outsider = await registerUser();
  const client = pinned(outsider);
  const results = await burst(120, () => client.get(`/v1/workspaces/${t.ws.id}`));
  for (const r of results) expectError(r, 404, 'not_found');
  assert.equal(expectRateLimitHeaders(results[0]).limit, 120);
  expect429(await client.get(`/v1/workspaces/${t.ws.id}`), 60);
  expect429(await client.get('/v1/users/me'), 60);
});

test('[J1] member bucket is 300 per workspace per minute', async () => {
  await setClock(WINDOW_START);
  const t = await team({ admins: 0, members: 1, viewers: 0 });
  const member = pinned(t.member);
  const results = await burst(300, () => member.get(`/v1/workspaces/${t.ws.id}`), 50);
  for (const r of results) expectStatus(r, 200);
  assert.equal(expectRateLimitHeaders(results[0]).limit, 300);
  expect429(await member.get(`/v1/workspaces/${t.ws.id}`), 60);
});

test('[J1] owner and admin bucket is 600 per workspace per minute', async () => {
  await setClock(WINDOW_START);
  const t = await team({ admins: 1, members: 0, viewers: 0 });
  const admin = pinned(t.admin);
  const results = await burst(600, () => admin.get(`/v1/workspaces/${t.ws.id}`), 50);
  for (const r of results) expectStatus(r, 200);
  assert.equal(expectRateLimitHeaders(results[0]).limit, 600);
  expect429(await admin.get(`/v1/workspaces/${t.ws.id}`), 60);
});

test('[J1] every response carries RateLimit headers, including errors', async () => {
  await setClock(WINDOW_START);
  const t = await team({ admins: 0, members: 0, viewers: 1 });
  const viewer = pinned(t.viewer);
  const responses = [
    await viewer.get(`/v1/workspaces/${t.ws.id}`),
    await viewer.get(`/v1/tasks/${NONEXISTENT_ID}`),
    await viewer.patch(`/v1/projects/${t.project.id}`, { name: 'x' }),
    await pinned(t.owner).post(`/v1/workspaces/${t.ws.id}/projects`, { name: '' }),
    await request('GET', '/v1/users/me', { ip: nextIp() }),
  ];
  assert.deepEqual(responses.map((r) => r.status), [200, 404, 403, 422, 401]);
  for (const r of responses) expectRateLimitHeaders(r);
});

test('[J1] /healthz and /__test/* are exempt from rate limits', async () => {
  await setClock(WINDOW_START);
  const ip = nextIp();
  await burst(31, () => request('GET', '/v1/users/me', { key: UNKNOWN_KEY, ip }));
  expect429(await request('GET', '/v1/users/me', { ip }), 60);
  const health = await request('GET', '/healthz', { ip });
  expectStatus(health, 200);
  assert.deepEqual(health.body, { status: 'ok', database: 'ok' });
  for (let i = 0; i < 40; i += 1) expectStatus(await request('GET', '/__test/clock', { ip }), 200);
});
