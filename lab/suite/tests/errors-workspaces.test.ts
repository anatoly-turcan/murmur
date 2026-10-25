import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { addMember, createWorkspace, registerUser, team, uniqueName } from '../lib/fixtures.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

test('[ERR] POST /v1/workspaces → 409 slug_taken', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const bo = await registerUser({ name: 'Bo' });
  await createWorkspace(ana, { slug: 'acme-ops' });
  expectError(await bo.client.post('/v1/workspaces', { name: 'Other', slug: 'acme-ops' }), 409, 'slug_taken');
});

for (const [what, slug, code] of [
  ['uppercase letter', 'Acme-ops', 'invalid_format'],
  ['leading hyphen', '-acme', 'invalid_format'],
  ['trailing hyphen', 'acme-', 'invalid_format'],
  ['consecutive hyphens', 'acme--ops', 'invalid_format'],
  ['underscore', 'acme_ops', 'invalid_format'],
  ['51 characters', 'a'.repeat(51), 'too_long'],
]) {
  test(`[ERR] POST /v1/workspaces → 422 ${code} (slug with ${what})`, async () => {
    const ana = await registerUser({ name: 'Ana' });
    expectValidation(await ana.client.post('/v1/workspaces', { name: 'Acme', slug }), 'slug', code);
  });
}

test('[ERR] POST /v1/workspaces → 422 required (name missing)', async () => {
  const ana = await registerUser({ name: 'Ana' });
  expectValidation(await ana.client.post('/v1/workspaces', { slug: 'acme' }), 'name', 'required');
});

test('[ERR] GET /v1/workspaces/{id} → 410 gone (member) / 404 not_found (non-member)', async () => {
  const t = await team();
  const outsider = await registerUser({ name: 'Oz' });
  expectStatus(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`), 204);
  expectError(await t.member.client.get(`/v1/workspaces/${t.ws.id}`), 410, 'gone');
  expectError(await t.owner.client.get(`/v1/workspaces/${t.ws.id}`), 410, 'gone');
  expectError(await outsider.client.get(`/v1/workspaces/${t.ws.id}`), 404, 'not_found');
});

test('[ERR] PATCH /v1/workspaces/{id} → 410 gone', async () => {
  const t = await team();
  expectStatus(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`), 204);
  expectError(await t.admin.client.patch(`/v1/workspaces/${t.ws.id}`, { name: 'Revived' }), 410, 'gone');
});

test('[ERR] DELETE /v1/workspaces/{id} → 410 gone (already deleted)', async () => {
  const t = await team();
  expectStatus(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`), 204);
  expectError(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`), 410, 'gone');
});

test('[ERR] PATCH /v1/workspaces/{id} → 403 forbidden (member)', async () => {
  const t = await team();
  expectError(await t.member.client.patch(`/v1/workspaces/${t.ws.id}`, { name: 'Mine now' }), 403, 'forbidden');
  expectError(await t.viewer.client.patch(`/v1/workspaces/${t.ws.id}`, { name: 'Mine now' }), 403, 'forbidden');
});

test('[ERR] PATCH /v1/workspaces/{id} → 409 version_conflict', async () => {
  const t = await team();
  expectStatus(await t.owner.client.patch(`/v1/workspaces/${t.ws.id}`, { name: 'First edit' }), 200);
  const res = await t.owner.client.patch(`/v1/workspaces/${t.ws.id}`, { name: 'Stale edit' }, { ifMatch: 1 });
  expectError(res, 409, 'version_conflict', { path: 'version', code: 'stale', current_version: 2 });
  const now = await t.owner.client.get(`/v1/workspaces/${t.ws.id}`);
  assert.equal(now.body.name, 'First edit');
  assert.equal(now.body.version, 2);
});

test('[ERR] PATCH /v1/workspaces/{id} → 409 slug_taken', async () => {
  const t = await team();
  await createWorkspace(t.owner, { slug: 'taken-slug' });
  expectError(await t.owner.client.patch(`/v1/workspaces/${t.ws.id}`, { slug: 'taken-slug' }), 409, 'slug_taken');
});

test('[ERR] PATCH /v1/workspaces/{id} → 422 too_long (name 101 chars)', async () => {
  const t = await team();
  expectValidation(await t.owner.client.patch(`/v1/workspaces/${t.ws.id}`, { name: 'w'.repeat(101) }), 'name', 'too_long');
});

test('[ERR] DELETE /v1/workspaces/{id} → 403 forbidden (admin)', async () => {
  const t = await team();
  expectError(await t.admin.client.delete(`/v1/workspaces/${t.ws.id}`), 403, 'forbidden');
  expectStatus(await t.owner.client.get(`/v1/workspaces/${t.ws.id}`), 200);
});

test('[ERR] POST /v1/workspaces/{id}/restore → 403 forbidden (admin)', async () => {
  const t = await team();
  expectStatus(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`), 204);
  expectError(await t.admin.client.post(`/v1/workspaces/${t.ws.id}/restore`), 403, 'forbidden');
});

test('[ERR] POST /v1/workspaces/{id}/restore → 409 not_deleted', async () => {
  const t = await team();
  expectError(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/restore`), 409, 'not_deleted');
});

test('[ERR] POST /v1/workspaces/{id}/restore → 409 slug_taken', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const bo = await registerUser({ name: 'Bo' });
  const ws = await createWorkspace(ana, { slug: 'reused' });
  expectStatus(await ana.client.delete(`/v1/workspaces/${ws.id}`), 204);
  await createWorkspace(bo, { slug: 'reused' });
  expectError(await ana.client.post(`/v1/workspaces/${ws.id}/restore`), 409, 'slug_taken');
});

test('[ERR] POST /v1/workspaces/{id}/transfer-ownership → 403 forbidden (admin)', async () => {
  const t = await team();
  expectError(await t.admin.client.post(`/v1/workspaces/${t.ws.id}/transfer-ownership`, { user_id: t.member.id }), 403, 'forbidden');
  const ws = await t.owner.client.get(`/v1/workspaces/${t.ws.id}`);
  assert.equal(ws.body.owner_id, t.owner.id);
});

test('[ERR] POST /v1/workspaces/{id}/transfer-ownership → 422 not_member', async () => {
  const t = await team();
  const outsider = await registerUser({ name: 'Oz' });
  expectValidation(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/transfer-ownership`, { user_id: outsider.id }), 'user_id', 'not_member');
});

test('[ERR] POST /v1/workspaces/{id}/members → 403 forbidden (member adds; admin adds admin)', async () => {
  const t = await team();
  const newcomer = await registerUser({ name: 'New' });
  expectError(await t.member.client.post(`/v1/workspaces/${t.ws.id}/members`, { email: newcomer.email, role: 'viewer' }), 403, 'forbidden');
  expectError(await t.admin.client.post(`/v1/workspaces/${t.ws.id}/members`, { email: newcomer.email, role: 'admin' }), 403, 'forbidden');
});

test('[ERR] POST /v1/workspaces/{id}/members → 409 already_member', async () => {
  const t = await team();
  expectError(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/members`, { email: t.member.email, role: 'viewer' }), 409, 'already_member');
});

test('[ERR] POST /v1/workspaces/{id}/members → 422 user_not_found (unknown email)', async () => {
  const t = await team();
  const res = await t.owner.client.post(`/v1/workspaces/${t.ws.id}/members`, { email: 'nobody.here@example.com', role: 'member' });
  expectValidation(res, 'email', 'user_not_found');
});

test('[ERR] POST /v1/workspaces/{id}/members → 422 user_not_found (deactivated user)', async () => {
  const t = await team();
  const gone = await registerUser({ name: 'Gone' });
  expectStatus(await gone.client.delete('/v1/users/me'), 204);
  expectValidation(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/members`, { email: gone.email, role: 'member' }), 'email', 'user_not_found');
});

test('[ERR] POST /v1/workspaces/{id}/members → 422 invalid_enum (role owner)', async () => {
  const t = await team();
  const newcomer = await registerUser({ name: 'New' });
  expectValidation(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/members`, { email: newcomer.email, role: 'owner' }), 'role', 'invalid_enum');
});

test('[ERR] PATCH /v1/workspaces/{id}/members/{user_id} → 403 forbidden (admin changes an admin)', async () => {
  const t = await team({ admins: 2 });
  expectError(await t.admins[0].client.patch(`/v1/workspaces/${t.ws.id}/members/${t.admins[1].id}`, { role: 'member' }), 403, 'forbidden');
});

test('[ERR] PATCH /v1/workspaces/{id}/members/{user_id} → 403 forbidden (admin promotes to admin)', async () => {
  const t = await team();
  expectError(await t.admin.client.patch(`/v1/workspaces/${t.ws.id}/members/${t.member.id}`, { role: 'admin' }), 403, 'forbidden');
});

test('[ERR] PATCH /v1/workspaces/{id}/members/{user_id} → 403 forbidden (member changes roles)', async () => {
  const t = await team();
  expectError(await t.member.client.patch(`/v1/workspaces/${t.ws.id}/members/${t.viewer.id}`, { role: 'member' }), 403, 'forbidden');
});

test('[ERR] PATCH /v1/workspaces/{id}/members/{user_id} → 409 sole_owner (owner role)', async () => {
  const t = await team();
  expectError(await t.owner.client.patch(`/v1/workspaces/${t.ws.id}/members/${t.owner.id}`, { role: 'admin' }), 409, 'sole_owner');
});

test('[ERR] PATCH /v1/workspaces/{id}/members/{user_id} → 422 invalid_enum (role owner)', async () => {
  const t = await team();
  expectValidation(await t.owner.client.patch(`/v1/workspaces/${t.ws.id}/members/${t.member.id}`, { role: 'owner' }), 'role', 'invalid_enum');
});

test('[ERR] DELETE /v1/workspaces/{id}/members/{user_id} → 403 forbidden (admin removes an admin)', async () => {
  const t = await team({ admins: 2 });
  expectError(await t.admins[0].client.delete(`/v1/workspaces/${t.ws.id}/members/${t.admins[1].id}`), 403, 'forbidden');
});

test('[ERR] DELETE /v1/workspaces/{id}/members/{user_id} → 403 forbidden (member removes someone)', async () => {
  const t = await team();
  expectError(await t.member.client.delete(`/v1/workspaces/${t.ws.id}/members/${t.viewer.id}`), 403, 'forbidden');
});

test('[ERR] DELETE /v1/workspaces/{id}/members/{user_id} → 403 forbidden (admin removes the owner)', async () => {
  const t = await team();
  // SPEC 7.4: the role check wins over sole_owner when an admin asks.
  expectError(await t.admin.client.delete(`/v1/workspaces/${t.ws.id}/members/${t.owner.id}`), 403, 'forbidden');
});

test('[ERR] PATCH /v1/workspaces/{id}/members/{user_id} → 403 forbidden (admin changes the owner)', async () => {
  const t = await team();
  expectError(await t.admin.client.patch(`/v1/workspaces/${t.ws.id}/members/${t.owner.id}`, { role: 'member' }), 403, 'forbidden');
});

test('[ERR] DELETE /v1/workspaces/{id}/members/{user_id} → 409 sole_owner (owner leaves)', async () => {
  const t = await team();
  expectError(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}/members/${t.owner.id}`), 409, 'sole_owner');
});

test('[ERR] GET /v1/workspaces/{id}/members → 410 gone', async () => {
  const t = await team();
  expectStatus(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`), 204);
  expectError(await t.viewer.client.get(`/v1/workspaces/${t.ws.id}/members`), 410, 'gone');
});

test('[ERR] POST /v1/workspaces/{id}/members → 410 gone', async () => {
  const t = await team();
  const newcomer = await registerUser({ name: 'New' });
  expectStatus(await t.owner.client.delete(`/v1/workspaces/${t.ws.id}`), 204);
  expectError(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/members`, { email: newcomer.email, role: 'member' }), 410, 'gone');
});

test('[ERR] GET /v1/workspaces → 200 without deleted workspaces (non-owner)', async () => {
  const t = await team();
  const other = await createWorkspace(t.owner, { name: uniqueName('Other') });
  await addMember(t.owner, other.id, t.member, 'member');
  expectStatus(await t.owner.client.delete(`/v1/workspaces/${other.id}`), 204);
  const list = await t.member.client.get('/v1/workspaces');
  expectStatus(list, 200);
  assert.deepEqual(list.body.data.map((w: any) => w.id), [t.ws.id]);
});
