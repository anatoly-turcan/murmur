import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { createTask, createWebhook, team, type Team } from '../lib/fixtures.ts';
import { ok, startReceiver } from '../lib/receiver.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drainAll } from '../lib/testmode.ts';

freshDatabaseEachTest();

const REFUSED = 'http://127.0.0.1:9/hook';

async function withHook(): Promise<Team & { hook: any; delivery: any }> {
  const t = await team();
  const hook = await createWebhook(t.owner, t.ws.id, { url: REFUSED, events: ['task.created'] });
  await createTask(t.member, t.project.id);
  const list = await t.owner.client.get(`/v1/webhooks/${hook.id}/deliveries`);
  expectStatus(list, 200);
  assert.equal(list.body.data.length, 1, 'a delivery is listed as soon as the triggering request returns');

  return { ...t, hook, delivery: list.body.data[0] };
}

const hookBody = { url: REFUSED, events: ['task.created'] };

test('[ERR] POST /v1/workspaces/{id}/webhooks → 403 forbidden (member, viewer)', async () => {
  const t = await team();
  expectError(await t.member.client.post(`/v1/workspaces/${t.ws.id}/webhooks`, hookBody), 403, 'forbidden');
  expectError(await t.viewer.client.post(`/v1/workspaces/${t.ws.id}/webhooks`, hookBody), 403, 'forbidden');
});

for (const [what, url] of [['ftp scheme', 'ftp://hooks.example.com/x'], ['not a URL', 'hooks dot example'], ['over 2048 chars', `https://hooks.example.com/${'p'.repeat(2050)}`]]) {
  test(`[ERR] POST /v1/workspaces/{id}/webhooks → 422 invalid_url (${what})`, async () => {
    const t = await team();
    expectValidation(await t.admin.client.post(`/v1/workspaces/${t.ws.id}/webhooks`, { url, events: ['task.created'] }), 'url', 'invalid_url');
  });
}

test('[ERR] POST /v1/workspaces/{id}/webhooks → 201 for a loopback http URL', async () => {
  const t = await team();
  const res = await t.admin.client.post(`/v1/workspaces/${t.ws.id}/webhooks`, hookBody);
  expectStatus(res, 201);
  assert.match(res.body.secret, /^[\x20-\x7e]{32,256}$/);
});

const NOT_DELIVERABLE = ['task.exploded', 'workspace.created', 'webhook.created', 'member.role_changed', 'ownership.transferred', 'comment.restored'];

// SPEC 8.1: the deliverable list is exhaustive; any other name is unknown (SPEC 7.10: invalid_event at events[n]).
for (const event of NOT_DELIVERABLE) {
  test(`[ERR] POST /v1/workspaces/{id}/webhooks → 422 invalid_event at events[n] (${event})`, async () => {
    const t = await team();
    const res = await t.admin.client.post(`/v1/workspaces/${t.ws.id}/webhooks`, { url: REFUSED, events: ['task.created', event] });
    expectValidation(res, 'events[1]', 'invalid_event');
  });
}

test('[ERR] POST /v1/workspaces/{id}/webhooks → 422 too_short at events (empty array)', async () => {
  const t = await team();
  const res = await t.admin.client.post(`/v1/workspaces/${t.ws.id}/webhooks`, { url: REFUSED, events: [] });
  expectValidation(res, 'events', 'too_short');
});

test('[ERR] POST /v1/workspaces/{id}/webhooks → 422 too_short (secret 31 chars)', async () => {
  const t = await team();
  const res = await t.admin.client.post(`/v1/workspaces/${t.ws.id}/webhooks`, { ...hookBody, secret: 's'.repeat(31) });
  expectValidation(res, 'secret', 'too_short');
});

test('[ERR] GET /v1/workspaces/{id}/webhooks → 403 forbidden (member)', async () => {
  const t = await withHook();
  expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}/webhooks`), 403, 'forbidden');
  const list = await t.admin.client.get(`/v1/workspaces/${t.ws.id}/webhooks`);
  expectStatus(list, 200);
  assert.equal(list.body.data[0].secret, undefined, 'listed webhooks never carry the secret');
});

test('[ERR] GET /v1/webhooks/{id} → 403 forbidden (member)', async () => {
  const t = await withHook();
  expectError(await t.member.client.get(`/v1/webhooks/${t.hook.id}`), 403, 'forbidden');
  const single = await t.admin.client.get(`/v1/webhooks/${t.hook.id}`);
  expectStatus(single, 200);
  assert.equal(single.body.secret, undefined, 'GET webhook never carries the secret');
  assert.equal(single.body.url, REFUSED);
});

test('[ERR] PATCH /v1/webhooks/{id} → 403 forbidden (member)', async () => {
  const t = await withHook();
  expectError(await t.member.client.patch(`/v1/webhooks/${t.hook.id}`, { active: false }), 403, 'forbidden');
});

test('[ERR] PATCH /v1/webhooks/{id} → 422 invalid_url', async () => {
  const t = await withHook();
  expectValidation(await t.admin.client.patch(`/v1/webhooks/${t.hook.id}`, { url: 'mailto:ops@example.com' }), 'url', 'invalid_url');
});

test('[ERR] DELETE /v1/webhooks/{id} → 403 forbidden (member)', async () => {
  const t = await withHook();
  expectError(await t.member.client.delete(`/v1/webhooks/${t.hook.id}`), 403, 'forbidden');
  expectStatus(await t.owner.client.get(`/v1/webhooks/${t.hook.id}`), 200);
});

test('[ERR] GET /v1/webhooks/{id} → 404 not_found after DELETE (deliveries too)', async () => {
  const t = await withHook();
  expectStatus(await t.owner.client.delete(`/v1/webhooks/${t.hook.id}`), 204);
  expectError(await t.owner.client.get(`/v1/webhooks/${t.hook.id}`), 404, 'not_found');
  expectError(await t.owner.client.get(`/v1/webhooks/${t.hook.id}/deliveries`), 404, 'not_found');
  expectError(await t.owner.client.get(`/v1/webhooks/${t.hook.id}/deliveries/${t.delivery.id}`), 404, 'not_found');
  expectError(await t.owner.client.delete(`/v1/webhooks/${t.hook.id}`), 404, 'not_found');
});

test('[ERR] GET /v1/webhooks/{id}/deliveries → 403 forbidden (member)', async () => {
  const t = await withHook();
  expectError(await t.member.client.get(`/v1/webhooks/${t.hook.id}/deliveries`), 403, 'forbidden');
  expectError(await t.viewer.client.get(`/v1/webhooks/${t.hook.id}/deliveries`), 403, 'forbidden');
});

test('[ERR] GET /v1/webhooks/{id}/deliveries → 400 invalid_query (status=bogus)', async () => {
  const t = await withHook();
  expectError(await t.admin.client.get(`/v1/webhooks/${t.hook.id}/deliveries`, { status: 'bogus' }), 400, 'invalid_query');
});

test('[ERR] GET /v1/webhooks/{id}/deliveries/{delivery_id} → 403 forbidden (member)', async () => {
  const t = await withHook();
  expectError(await t.member.client.get(`/v1/webhooks/${t.hook.id}/deliveries/${t.delivery.id}`), 403, 'forbidden');
});

test('[ERR] POST /v1/webhooks/{id}/deliveries/{delivery_id}/redeliver → 403 forbidden (member)', async () => {
  const t = await withHook();
  expectError(await t.member.client.post(`/v1/webhooks/${t.hook.id}/deliveries/${t.delivery.id}/redeliver`), 403, 'forbidden');
});

test('[ERR] POST /v1/webhooks/{id}/deliveries/{delivery_id}/redeliver → 409 not_redeliverable (not dead)', async () => {
  const t = await withHook();
  const res = await t.owner.client.post(`/v1/webhooks/${t.hook.id}/deliveries/${t.delivery.id}/redeliver`);
  expectError(res, 409, 'not_redeliverable');
});

test('[ERR] POST /v1/webhooks/{id}/deliveries/{delivery_id}/redeliver → 409 not_redeliverable (succeeded)', async (t) => {
  const tm = await team();
  const receiver = await startReceiver(ok());
  t.after(() => receiver.close());
  const hook = await createWebhook(tm.owner, tm.ws.id, { url: receiver.url, events: ['task.created'] });
  await createTask(tm.member, tm.project.id);
  await drainAll();
  const list = await tm.owner.client.get(`/v1/webhooks/${hook.id}/deliveries`);
  expectStatus(list, 200);
  assert.equal(list.body.data[0]?.status, 'succeeded');
  expectError(await tm.owner.client.post(`/v1/webhooks/${hook.id}/deliveries/${list.body.data[0].id}/redeliver`), 409, 'not_redeliverable');
  assert.equal(receiver.requests.length, 1);
});
