import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus } from '../lib/assert.ts';
import { anonymous, request } from '../lib/client.ts';
import { ENDPOINTS, fill, label } from '../lib/endpoints.ts';
import { registerUser, uniqueEmail } from '../lib/fixtures.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

const UNKNOWN_KEY = `twl_${'Z'.repeat(20)}${'0'.repeat(20)}`;
const ids = { ws: 1, project: 1, task: 1, comment: 1, webhook: 1, delivery: 1, member: 1, user: 1, key: 1 };

for (const endpoint of ENDPOINTS) {
  test(`[ERR] ${label(endpoint)} → 401 unauthenticated / invalid_api_key`, async () => {
    const path = fill(endpoint.path, ids);
    const missing = await request(endpoint.method, path, { body: endpoint.body });
    expectError(missing, 401, 'unauthenticated');
    const unknown = await request(endpoint.method, path, { body: endpoint.body, key: UNKNOWN_KEY });
    expectError(unknown, 401, 'invalid_api_key');
  });
}

// SPEC 4: any Authorization value not matching `Bearer twl_[A-Za-z0-9]{40}` is malformed.
const MALFORMED = [
  ['Basic auth scheme', 'Basic dXNlcjpwYXNz'],
  ['39 characters after twl_', `Bearer twl_${'a'.repeat(39)}`],
  ['41 characters after twl_', `Bearer twl_${'a'.repeat(41)}`],
  ['hyphen in the secret', `Bearer twl_${'a'.repeat(39)}-`],
  ['missing twl_ prefix', `Bearer ${'a'.repeat(44)}`],
  ['bare secret without scheme', `twl_${'a'.repeat(40)}`],
  ['empty value', ''],
];

for (const [what, value] of MALFORMED) {
  test(`[ERR] GET /v1/users/me → 401 unauthenticated (malformed Authorization: ${what})`, async () => {
    expectError(await request('GET', '/v1/users/me', { authorization: value }), 401, 'unauthenticated');
  });
}

test('[ERR] GET /v1/users/me → 401 invalid_api_key (revoked key)', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const extra = await ana.client.post('/v1/users/me/api-keys', { name: 'ci' });
  expectStatus(extra, 201);
  expectStatus(await ana.client.delete(`/v1/users/me/api-keys/${extra.body.id}`), 204);
  expectError(await request('GET', '/v1/users/me', { key: extra.body.secret }), 401, 'invalid_api_key');
  expectStatus(await ana.client.get('/v1/users/me'), 200);
});

test('[ERR] GET /v1/users/me → 401 invalid_api_key (deactivated user)', async () => {
  const bo = await registerUser({ name: 'Bo' });
  expectStatus(await bo.client.delete('/v1/users/me'), 204);
  expectError(await bo.client.get('/v1/users/me'), 401, 'invalid_api_key');
});

test('[ERR] GET /healthz → 200 without authentication', async () => {
  const health = await request('GET', '/healthz');
  expectStatus(health, 200);
  assert.deepEqual(health.body, { status: 'ok', database: 'ok' });
});

test('[ERR] POST /v1/users → 201 without authentication', async () => {
  const created = await anonymous().post('/v1/users', { email: uniqueEmail('noauth'), name: 'No Auth' });
  expectStatus(created, 201);
  assert.match(created.body.api_key.secret, /^twl_[A-Za-z0-9]{40}$/);
  assert.equal(created.body.user.timezone, 'UTC');
});
