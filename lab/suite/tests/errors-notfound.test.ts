import { test } from 'node:test';
import { expectError, expectStatus } from '../lib/assert.ts';
import { ENDPOINTS, fill, fillBody, label, NONEXISTENT_ID, objectWorld, slots } from '../lib/endpoints.ts';
import { registerUser } from '../lib/fixtures.ts';
import { freshDatabaseOnce, lazy } from '../lib/suite.ts';

freshDatabaseOnce();

const world = lazy(objectWorld);

for (const endpoint of ENDPOINTS.filter((e) => slots(e.path).length > 0)) {
  test(`[ERR] ${label(endpoint)} → 404 not_found (nonexistent id)`, async () => {
    const { owner } = await world();
    const res = await owner.client.request(endpoint.method, fill(endpoint.path, {}), { body: fillBody(endpoint.body, owner) });
    expectError(res, 404, 'not_found');
  });
}

test('[ERR] PATCH /v1/workspaces/{id}/members/{user_id} → 404 not_found (user is not a member)', async () => {
  const { owner, outsider, ids } = await world();
  expectError(await owner.client.patch(`/v1/workspaces/${ids.ws}/members/${NONEXISTENT_ID}`, { role: 'viewer' }), 404, 'not_found');
  expectError(await owner.client.patch(`/v1/workspaces/${ids.ws}/members/${outsider.id}`, { role: 'viewer' }), 404, 'not_found');
});

test('[ERR] DELETE /v1/workspaces/{id}/members/{user_id} → 404 not_found (user is not a member)', async () => {
  const { owner, outsider, ids } = await world();
  expectError(await owner.client.delete(`/v1/workspaces/${ids.ws}/members/${NONEXISTENT_ID}`), 404, 'not_found');
  expectError(await owner.client.delete(`/v1/workspaces/${ids.ws}/members/${outsider.id}`), 404, 'not_found');
});

test('[ERR] GET /v1/webhooks/{id}/deliveries/{delivery_id} → 404 not_found (nonexistent delivery)', async () => {
  const { owner, ids } = await world();
  expectError(await owner.client.get(`/v1/webhooks/${ids.webhook}/deliveries/${NONEXISTENT_ID}`), 404, 'not_found');
});

test('[ERR] POST /v1/webhooks/{id}/deliveries/{delivery_id}/redeliver → 404 not_found (nonexistent delivery)', async () => {
  const { owner, ids } = await world();
  expectError(await owner.client.post(`/v1/webhooks/${ids.webhook}/deliveries/${NONEXISTENT_ID}/redeliver`), 404, 'not_found');
});

test('[ERR] GET /v1/users/{id} → 404 not_found (user sharing no workspace)', async () => {
  const { owner, outsider } = await world();
  expectError(await owner.client.get(`/v1/users/${outsider.id}`), 404, 'not_found');
});

test('[ERR] DELETE /v1/users/me/api-keys/{id} → 404 not_found (another user\'s key)', async () => {
  const { owner, member } = await world();
  expectError(await owner.client.delete(`/v1/users/me/api-keys/${member.keyId}`), 404, 'not_found');
  const lone = await registerUser({ name: 'Lone' });
  expectError(await lone.client.delete(`/v1/users/me/api-keys/${owner.keyId}`), 404, 'not_found');
  expectStatus(await member.client.get('/v1/users/me'), 200);
  expectStatus(await owner.client.get('/v1/users/me'), 200);
});
