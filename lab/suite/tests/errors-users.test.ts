import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { anonymous } from '../lib/client.ts';
import { createWorkspace, registerUser, uniqueEmail } from '../lib/fixtures.ts';
import { compareIds } from '../lib/ids.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

const register = (body: Record<string, unknown>) => anonymous().post('/v1/users', body);

test('[ERR] POST /v1/users → 409 email_taken', async () => {
  const ana = await registerUser({ name: 'Ana' });
  expectError(await register({ email: ana.email, name: 'Ana Again' }), 409, 'email_taken');
});

test('[ERR] POST /v1/users → 409 email_taken (case-insensitive)', async () => {
  const ana = await registerUser({ name: 'Ana' });
  expectError(await register({ email: ana.email.toUpperCase(), name: 'Ana Upper' }), 409, 'email_taken');
});

for (const [what, email] of [
  ['no @', 'ana.example.com'],
  ['two @', 'ana@foo@example.com'],
  ['empty local part', '@example.com'],
  ['empty domain', 'ana@'],
]) {
  test(`[ERR] POST /v1/users → 422 invalid_format (email ${what})`, async () => {
    expectValidation(await register({ email, name: 'Ana' }), 'email', 'invalid_format');
  });
}

test('[ERR] POST /v1/users → 422 too_long (email over 254 chars)', async () => {
  const email = `${'a'.repeat(243)}@example.com`;
  assert.equal(email.length, 255);
  expectValidation(await register({ email, name: 'Ana' }), 'email', 'too_long');
});

test('[ERR] POST /v1/users → 422 required (email missing)', async () => {
  expectValidation(await register({ name: 'Ana' }), 'email', 'required');
});

test('[ERR] POST /v1/users → 422 too_short (name blank after trimming)', async () => {
  expectValidation(await register({ email: uniqueEmail('blank'), name: '   ' }), 'name', 'too_short');
});

test('[ERR] POST /v1/users → 422 too_long (name 101 chars)', async () => {
  expectValidation(await register({ email: uniqueEmail('long'), name: 'n'.repeat(101) }), 'name', 'too_long');
});

test('[ERR] POST /v1/users → 422 invalid_type (name is a number)', async () => {
  expectValidation(await register({ email: uniqueEmail('num'), name: 42 }), 'name', 'invalid_type');
});

test('[ERR] POST /v1/users → 422 invalid_timezone', async () => {
  expectValidation(await register({ email: uniqueEmail('tz'), name: 'Ana', timezone: 'Mars/Base' }), 'timezone', 'invalid_timezone');
});

test('[ERR] POST /v1/users → 201 with an IANA Link name (US/Eastern)', async () => {
  const res = await register({ email: uniqueEmail('link'), name: 'Linked', timezone: 'US/Eastern' });
  expectStatus(res, 201);
  assert.equal(res.body.user.timezone, 'US/Eastern');
});

test('[ERR] PATCH /v1/users/me → 422 invalid_timezone', async () => {
  const ana = await registerUser({ name: 'Ana' });
  expectValidation(await ana.client.patch('/v1/users/me', { timezone: 'Europe/Atlantis' }), 'timezone', 'invalid_timezone');
});

test('[ERR] PATCH /v1/users/me → 422 not_nullable (name null)', async () => {
  const ana = await registerUser({ name: 'Ana' });
  expectValidation(await ana.client.patch('/v1/users/me', { name: null }), 'name', 'not_nullable');
  const me = await ana.client.get('/v1/users/me');
  assert.equal(me.body.name, 'Ana');
});

test('[ERR] PATCH /v1/users/me → 422 invalid_type (digest_enabled "yes")', async () => {
  const ana = await registerUser({ name: 'Ana' });
  expectValidation(await ana.client.patch('/v1/users/me', { digest_enabled: 'yes' }), 'digest_enabled', 'invalid_type');
});

test('[ERR] PATCH /v1/users/me → 422 unknown_field (email is not patchable)', async () => {
  const ana = await registerUser({ name: 'Ana' });
  expectValidation(await ana.client.patch('/v1/users/me', { email: uniqueEmail('new') }), 'email', 'unknown_field');
});

test('[ERR] DELETE /v1/users/me → 409 sole_owner (owns workspaces, deleted or not)', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const live = await createWorkspace(ana);
  const gone = await createWorkspace(ana);
  expectStatus(await ana.client.delete(`/v1/workspaces/${gone.id}`), 204);
  const res = await ana.client.delete('/v1/users/me');
  expectError(res, 409, 'sole_owner');
  const detail = res.body.error.details?.find((d: any) => d.path === 'workspaces' && d.code === 'sole_owner');
  assert.ok(detail, `expected a {path:"workspaces", code:"sole_owner"} detail: ${res.text}`);
  // SPEC 7.2: owned workspaces "deleted or not" are listed.
  assert.deepEqual([...detail.workspace_ids].sort(compareIds), [live.id, gone.id].sort(compareIds));
  expectStatus(await ana.client.get('/v1/users/me'), 200, 'the user must not be deactivated');
});

test('[ERR] POST /v1/users/me/api-keys → 422 required (name missing)', async () => {
  const ana = await registerUser({ name: 'Ana' });
  expectValidation(await ana.client.post('/v1/users/me/api-keys', {}), 'name', 'required');
});

test('[ERR] POST /v1/users/me/api-keys → 422 too_long (name 101 chars)', async () => {
  const ana = await registerUser({ name: 'Ana' });
  expectValidation(await ana.client.post('/v1/users/me/api-keys', { name: 'k'.repeat(101) }), 'name', 'too_long');
});

test('[ERR] POST /v1/users/me/api-keys → 422 too_many_items (21st active key)', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const created = [];
  for (let i = 0; i < 19; i += 1) {
    const res = await ana.client.post('/v1/users/me/api-keys', { name: `key ${i}` });
    expectStatus(res, 201, `key #${i + 2} of 20`);
    created.push(res.body);
  }
  expectError(await ana.client.post('/v1/users/me/api-keys', { name: 'one too many' }), 422, 'validation_failed', { path: '', code: 'too_many_items' });
  expectStatus(await ana.client.delete(`/v1/users/me/api-keys/${created[0].id}`), 204);
  expectStatus(await ana.client.post('/v1/users/me/api-keys', { name: 'freed slot' }), 201, 'a revoked key frees a slot');
});

test('[ERR] DELETE /v1/users/me/api-keys/{id} → 204 when already revoked', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const extra = await ana.client.post('/v1/users/me/api-keys', { name: 'ci' });
  expectStatus(extra, 201);
  expectStatus(await ana.client.delete(`/v1/users/me/api-keys/${extra.body.id}`), 204);
  expectStatus(await ana.client.delete(`/v1/users/me/api-keys/${extra.body.id}`), 204);
  const list = await ana.client.get('/v1/users/me/api-keys');
  expectStatus(list, 200);
  const item = list.body.data.find((k: any) => k.id === extra.body.id);
  assert.ok(item?.revoked_at, 'revoked key is listed with revoked_at');
  assert.equal(item.secret, undefined);
});
