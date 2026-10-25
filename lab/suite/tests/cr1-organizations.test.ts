import assert from 'node:assert/strict';
import { assertTimestamps, countBy, expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { setClock } from '../lib/clock.ts';
import { idempotencyKey, type ApiResponse, type Json } from '../lib/client.ts';
import { crTest } from '../lib/cr.ts';
import { activity, addMember, createProject, createTask, need, registerUser, uniqueName, type User } from '../lib/fixtures.ts';
import { assertPublicId, compareIds, type Id } from '../lib/ids.ts';
import { addOrgMember, createOrg, createWorkspaceIn, memberUserId, orgMembers, orgRoleOf, PLAN_LIMITS, postOrgMember, setPlan, type OrgRole } from '../lib/orgs.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

const test = crTest('CR-1');

freshDatabaseEachTest();

interface OrgWorld {
  org: Json;
  owner: User;
  admin: User;
  billing: User;
  member: User;
}

async function orgWorld(): Promise<OrgWorld> {
  const owner = await registerUser({ name: 'Ana' });
  const admin = await registerUser({ name: 'Bo' });
  const billing = await registerUser({ name: 'Cy' });
  const member = await registerUser({ name: 'Dee' });
  const org = await createOrg(owner, { name: uniqueName('Acme Holding') });
  await addOrgMember(owner, org.id, admin, 'org_admin');
  await addOrgMember(owner, org.id, billing, 'billing');
  await addOrgMember(owner, org.id, member, 'org_member');

  return { org, owner, admin, billing, member };
}

function roles(w: OrgWorld): [string, User][] {
  return [['org_owner', w.owner], ['org_admin', w.admin], ['billing', w.billing], ['org_member', w.member]];
}

async function expectByRole(w: OrgWorld, what: string, call: (u: User, role: string) => Promise<ApiResponse>, allowed: Record<string, number>): Promise<void> {
  for (const [role, user] of roles(w)) {
    const res = await call(user, role);
    if (allowed[role]) expectStatus(res, allowed[role], `${role} ${what}`);
    else expectError(res, 403, 'forbidden');
  }
}

function sortedIds(items: Json[]): Id[] {
  return items.map((x) => x.id).sort(compareIds);
}

test('[CR1-H] create, read and list an organization with free plan defaults; creation is idempotent', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const key = idempotencyKey('org');
  const res = await ana.client.post('/v1/organizations', { name: 'Acme Holding' }, { idempotencyKey: key });
  expectStatus(res, 201);
  const org = res.body;
  assertPublicId(org.id, 'organization.id');
  assert.equal(org.name, 'Acme Holding');
  assert.equal(org.slug, 'acme-holding', 'slug derived like workspace slugs');
  assert.equal(org.plan, 'free');
  assert.deepEqual(org.limits, PLAN_LIMITS.free);
  assert.equal(org.owner_id, ana.id);
  assert.equal(org.version, 1);
  assert.equal(org.deleted_at, null);
  assert.equal(res.headers.get('etag'), '"1"');
  assertTimestamps(org);

  const replay = await ana.client.post('/v1/organizations', { name: 'Acme Holding' }, { idempotencyKey: key });
  expectStatus(replay, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(replay.body, org);

  const got = await ana.client.get(`/v1/organizations/${org.id}`);
  expectStatus(got, 200);
  assert.equal(got.body.id, org.id);
  assert.equal(got.headers.get('etag'), '"1"');
  const list = await ana.client.pageAll('/v1/organizations');
  assert.deepEqual(list.items.map((o) => o.id), [org.id], 'exactly one organization despite the replay');
});

test('[CR1-H] PATCH plan switches to the plan defaults and honours If-Match', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const org = await createOrg(ana);
  const team = await ana.client.patch(`/v1/organizations/${org.id}`, { plan: 'team' }, { ifMatch: 1 });
  expectStatus(team, 200);
  assert.equal(team.body.plan, 'team');
  assert.deepEqual(team.body.limits, PLAN_LIMITS.team);
  assert.equal(team.body.version, 2);
  assert.equal(team.headers.get('etag'), '"2"');
  const business = await ana.client.patch(`/v1/organizations/${org.id}`, { plan: 'business' }, { ifMatch: 2 });
  expectStatus(business, 200);
  assert.deepEqual(business.body.limits, PLAN_LIMITS.business, 'business: unlimited workspaces and members are null');
  const stale = await ana.client.patch(`/v1/organizations/${org.id}`, { name: 'Late' }, { ifMatch: 2 });
  expectError(stale, 409, 'version_conflict', { path: 'version', code: 'stale', current_version: 3 });
  expectValidation(await ana.client.patch(`/v1/organizations/${org.id}`, { plan: 'enterprise' }), 'plan', 'invalid_enum');
});

test('[CR1-H] organization slugs are unique among non-deleted organizations', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const bo = await registerUser({ name: 'Bo' });
  const first = await createOrg(ana, { name: 'Acme', slug: 'acme' });
  expectError(await bo.client.post('/v1/organizations', { name: 'Other', slug: 'acme' }), 409, 'slug_taken');
  expectError(await bo.client.post('/v1/organizations', { name: 'Other', slug: 'ACME' }), 422, 'validation_failed', { path: 'slug', code: 'invalid_format' });
  expectStatus(await ana.client.delete(`/v1/organizations/${first.id}`), 204);
  expectStatus(await bo.client.post('/v1/organizations', { name: 'Other', slug: 'acme' }), 201);
});

test('[CR1-H] organization members: add, list with pagination, change role, remove', async () => {
  const w = await orgWorld();
  expectError(await postOrgMember(w.owner, w.org.id, w.member, 'org_member'), 409, 'already_member');
  const members = await w.owner.client.pageAll(`/v1/organizations/${w.org.id}/members`, { limit: 2 });
  assert.equal(members.pages.length, 2, 'four members at limit=2 take two pages');
  const roleOf = new Map(members.items.map((m) => [memberUserId(m), m.role]));
  assert.deepEqual(Object.fromEntries([...roleOf].map(([id, role]) => [String(id), role])), {
    [String(w.owner.id)]: 'org_owner',
    [String(w.admin.id)]: 'org_admin',
    [String(w.billing.id)]: 'billing',
    [String(w.member.id)]: 'org_member',
  });
  const patched = await w.owner.client.patch(`/v1/organizations/${w.org.id}/members/${w.member.id}`, { role: 'org_admin' });
  expectStatus(patched, 200);
  assert.equal(patched.body.role, 'org_admin');
  expectStatus(await w.owner.client.delete(`/v1/organizations/${w.org.id}/members/${w.member.id}`), 204);
  assert.equal(await orgRoleOf(w.owner, w.org.id, w.member), undefined);
  expectError(await w.member.client.get(`/v1/organizations/${w.org.id}`), 404, 'not_found');
});

test('[CR1-H] POST /v1/workspaces requires organization_id; the org lists its workspaces', async () => {
  const ana = await registerUser({ name: 'Ana' });
  const org = await createOrg(ana);
  const other = await createOrg(ana);
  const missing = await ana.client.request('POST', '/v1/workspaces', { body: { name: 'No Org' }, raw: true });
  expectValidation(missing, 'organization_id', 'required');
  const a = await createWorkspaceIn(ana, org.id);
  const b = await createWorkspaceIn(ana, org.id);
  const c = await createWorkspaceIn(ana, other.id);
  const listed = await ana.client.pageAll(`/v1/organizations/${org.id}/workspaces`, { limit: 1 });
  assert.deepEqual(sortedIds(listed.items), sortedIds([a, b]));
  const listedOther = await ana.client.pageAll(`/v1/organizations/${other.id}/workspaces`);
  assert.deepEqual(sortedIds(listedOther.items), [c.id]);
});

test('[CR1-H] usage reports workspaces, members, requests of the last minute and limits', async () => {
  await setClock('2026-06-01T10:00:05Z');
  const w = await orgWorld();
  const ws = await createWorkspaceIn(w.owner, w.org.id);
  for (let i = 0; i < 3; i += 1) expectStatus(await w.owner.client.get(`/v1/workspaces/${ws.id}`), 200);
  const usage = await w.owner.client.get(`/v1/organizations/${w.org.id}/usage`);
  expectStatus(usage, 200);
  assert.equal(usage.body.workspaces, 1);
  assert.equal(usage.body.members, 4, 'members counts the organization members');
  assert.ok(Number.isInteger(usage.body.api_requests_last_minute) && usage.body.api_requests_last_minute >= 3, usage.text);
  assert.deepEqual(usage.body.limits, PLAN_LIMITS.free);
});

test('[CR1-R] every org role reads the organization, its members and its workspaces', async () => {
  const w = await orgWorld();
  const ws = await createWorkspaceIn(w.owner, w.org.id);
  for (const [role, user] of roles(w)) {
    expectStatus(await user.client.get(`/v1/organizations/${w.org.id}`), 200, `${role} reads the organization`);
    expectStatus(await user.client.get(`/v1/organizations/${w.org.id}/members`), 200, `${role} reads members`);
    const list = await user.client.get(`/v1/organizations/${w.org.id}/workspaces`);
    expectStatus(list, 200, `${role} reads the workspace list`);
    assert.deepEqual(list.body.data.map((x: Json) => x.id), [ws.id]);
  }
});

test('[CR1-R] creating a workspace: owner, admin and member yes; billing no', async () => {
  const w = await orgWorld();
  await expectByRole(w, 'creates a workspace', (u) => u.client.post('/v1/workspaces', { name: uniqueName('Role WS'), organization_id: w.org.id }), {
    org_owner: 201,
    org_admin: 201,
    org_member: 201,
  });
});

test('[CR1-R] reading a workspace without membership: owner and admin as viewer; billing and member get 404', async () => {
  const w = await orgWorld();
  const outsiderOwner = await registerUser({ name: 'Eve' });
  await addOrgMember(w.owner, w.org.id, outsiderOwner, 'org_member');
  const ws = await createWorkspaceIn(outsiderOwner, w.org.id);
  const project = await createProject(outsiderOwner, ws.id);
  const task = await createTask(outsiderOwner, project.id, { title: 'Quarterly report' });
  for (const user of [w.owner, w.admin]) {
    expectStatus(await user.client.get(`/v1/workspaces/${ws.id}`), 200);
    expectStatus(await user.client.get(`/v1/tasks/${task.id}`), 200);
    expectError(await user.client.patch(`/v1/tasks/${task.id}`, { title: 'Edited' }), 403, 'forbidden');
  }
  for (const user of [w.billing, w.member]) {
    expectError(await user.client.get(`/v1/workspaces/${ws.id}`), 404, 'not_found');
    expectError(await user.client.get(`/v1/tasks/${task.id}`), 404, 'not_found');
  }
});

test('[CR1-R] managing members: owner and admin yes; billing and member 403', async () => {
  const w = await orgWorld();
  const newcomers = new Map<string, User>();
  for (const [role] of roles(w)) newcomers.set(role, await registerUser({ name: `New ${role}` }));
  await expectByRole(w, 'adds a member', (u, role) => postOrgMember(u, w.org.id, newcomers.get(role)!, 'org_member'), {
    org_owner: 201,
    org_admin: 201,
  });
  const target = newcomers.get('org_owner')!;
  for (const user of [w.billing, w.member]) {
    expectError(await user.client.patch(`/v1/organizations/${w.org.id}/members/${target.id}`, { role: 'billing' }), 403, 'forbidden');
    expectError(await user.client.delete(`/v1/organizations/${w.org.id}/members/${target.id}`), 403, 'forbidden');
  }
  expectStatus(await w.admin.client.patch(`/v1/organizations/${w.org.id}/members/${target.id}`, { role: 'billing' }), 200);
  expectStatus(await w.admin.client.delete(`/v1/organizations/${w.org.id}/members/${target.id}`), 204);
});

test('[CR1-R] admins change roles only below org_owner and cannot touch the owner', async () => {
  const w = await orgWorld();
  const promote = await w.admin.client.patch(`/v1/organizations/${w.org.id}/members/${w.member.id}`, { role: 'org_owner' });
  assert.ok(promote.status >= 400 && promote.status < 500, `promoting to org_owner must be rejected: ${promote.status}`);
  expectError(await w.admin.client.patch(`/v1/organizations/${w.org.id}/members/${w.owner.id}`, { role: 'org_member' }), 403, 'forbidden');
  expectError(await w.admin.client.delete(`/v1/organizations/${w.org.id}/members/${w.owner.id}`), 403, 'forbidden');
  assert.equal(await orgRoleOf(w.owner, w.org.id, w.owner), 'org_owner');
  assert.equal(await orgRoleOf(w.owner, w.org.id, w.member), 'org_member');
});

test('[CR1-R] plan and usage: owner and billing yes; admin and member 403', async () => {
  const w = await orgWorld();
  await expectByRole(w, 'reads usage', (u) => u.client.get(`/v1/organizations/${w.org.id}/usage`), { org_owner: 200, billing: 200 });
  const plans: Record<string, string> = { org_owner: 'team', org_admin: 'business', billing: 'free', org_member: 'business' };
  await expectByRole(w, 'changes the plan', (u, role) => u.client.patch(`/v1/organizations/${w.org.id}`, { plan: plans[role] }), {
    org_owner: 200,
    billing: 200,
  });
  const org = need(await w.owner.client.get(`/v1/organizations/${w.org.id}`), 200, 'read org');
  assert.equal(org.plan, 'free', 'only owner and billing changed the plan, billing last');
});

test('[CR1-R] delete, restore and ownership transfer are owner-only', async () => {
  const w = await orgWorld();
  for (const user of [w.admin, w.billing, w.member]) {
    expectError(await user.client.delete(`/v1/organizations/${w.org.id}`), 403, 'forbidden');
    expectError(await user.client.post(`/v1/organizations/${w.org.id}/transfer-ownership`, { user_id: user.id }), 403, 'forbidden');
  }
  expectStatus(await w.owner.client.delete(`/v1/organizations/${w.org.id}`), 204);
  for (const user of [w.admin, w.billing, w.member]) expectError(await user.client.post(`/v1/organizations/${w.org.id}/restore`), 403, 'forbidden');
  const restored = await w.owner.client.post(`/v1/organizations/${w.org.id}/restore`);
  expectStatus(restored, 200);
  assert.equal(restored.body.deleted_at, null);
});

test('[CR1-S] another organization is invisible: reads and writes are 404 and nothing leaks into lists', async () => {
  const a = await orgWorld();
  const bo = await registerUser({ name: 'Bob' });
  const orgB = await createOrg(bo);
  const wsB = await createWorkspaceIn(bo, orgB.id);
  const project = await createProject(bo, wsB.id);
  const task = await createTask(bo, project.id, { title: 'Secret roadmap' });
  for (const [role, user] of roles(a)) {
    for (const path of ['', '/members', '/workspaces', '/usage', '/activity', '/webhooks']) {
      expectError(await user.client.get(`/v1/organizations/${orgB.id}${path}`), 404, 'not_found');
    }
    expectError(await user.client.patch(`/v1/organizations/${orgB.id}`, { name: 'Hijacked' }), 404, 'not_found');
    expectError(await postOrgMember(user, orgB.id, user, 'org_admin'), 404, 'not_found');
    expectError(await user.client.get(`/v1/workspaces/${wsB.id}`), 404, 'not_found');
    expectError(await user.client.get(`/v1/tasks/${task.id}`), 404, 'not_found');
    expectError(await user.client.get(`/v1/workspaces/${wsB.id}/search`, { q: 'roadmap' }), 404, 'not_found');
    const intrude = await user.client.post('/v1/workspaces', { name: uniqueName('Intruder'), organization_id: orgB.id });
    assert.notEqual(intrude.status, 201, `${role} of another organization must not create a workspace in B`);
    const mine = await user.client.pageAll('/v1/organizations');
    assert.deepEqual(mine.items.map((o) => o.id), [a.org.id], `${role} lists only its own organization`);
  }
  const listed = await bo.client.pageAll(`/v1/organizations/${orgB.id}/workspaces`);
  assert.deepEqual(listed.items.map((x) => x.id), [wsB.id]);
});

test('[CR1-O] ownership transfer leaves exactly one org_owner', async () => {
  const w = await orgWorld();
  const outsider = await registerUser({ name: 'Zed' });
  const bad = await w.owner.client.post(`/v1/organizations/${w.org.id}/transfer-ownership`, { user_id: outsider.id });
  assert.ok(bad.status >= 400 && bad.status < 500, `transfer to a non-member must be rejected: ${bad.status}`);
  const res = await w.owner.client.post(`/v1/organizations/${w.org.id}/transfer-ownership`, { user_id: w.admin.id });
  expectStatus(res, 200);
  assert.equal(res.body.owner_id, w.admin.id);
  const members = await orgMembers(w.admin, w.org.id);
  assert.deepEqual(members.filter((m) => m.role === 'org_owner').map(memberUserId), [w.admin.id], 'exactly one org_owner');
  assert.notEqual(await orgRoleOf(w.admin, w.org.id, w.owner), 'org_owner');
  expectError(await w.owner.client.delete(`/v1/organizations/${w.org.id}`), 403, 'forbidden');
});

test('[CR1-O] the org owner cannot be removed or leave', async () => {
  const w = await orgWorld();
  const leave = await w.owner.client.delete(`/v1/organizations/${w.org.id}/members/${w.owner.id}`);
  assert.ok(leave.status >= 400 && leave.status < 500, `the org owner leaving must be rejected: ${leave.status}`);
  assert.equal(await orgRoleOf(w.owner, w.org.id, w.owner), 'org_owner');
});

test('[CR1-O] a deleted organization is 410 for members and 404 for others until restored', async () => {
  const w = await orgWorld();
  const stranger = await registerUser({ name: 'Zed' });
  const before = need(await w.owner.client.get(`/v1/organizations/${w.org.id}`), 200, 'read org');
  expectError(await w.owner.client.post(`/v1/organizations/${w.org.id}/restore`), 409, 'not_deleted');
  expectStatus(await w.owner.client.delete(`/v1/organizations/${w.org.id}`), 204);
  expectError(await w.member.client.get(`/v1/organizations/${w.org.id}`), 410, 'gone');
  expectError(await stranger.client.get(`/v1/organizations/${w.org.id}`), 404, 'not_found');
  const restored = await w.owner.client.post(`/v1/organizations/${w.org.id}/restore`);
  expectStatus(restored, 200);
  assert.equal(restored.body.version, before.version + 2, 'delete and restore each bump the version');
  expectStatus(await w.member.client.get(`/v1/organizations/${w.org.id}`), 200);
});

test('[CR1-O] a workspace owner is always an org member', async () => {
  const w = await orgWorld();
  const ws = await createWorkspaceIn(w.owner, w.org.id);
  const bo = await registerUser({ name: 'Outside Bo' });
  await addMember(w.owner, ws.id, bo, 'admin');
  const res = await w.owner.client.request('POST', `/v1/workspaces/${ws.id}/transfer-ownership`, { body: { user_id: bo.id }, raw: true });
  const now = need(await w.owner.client.get(`/v1/workspaces/${ws.id}`), 200, 'read workspace');
  if (res.status === 200) {
    assert.ok(await orgRoleOf(w.owner, w.org.id, bo), 'a transfer that succeeds must leave the new owner an org member');
  } else {
    assert.ok(res.status >= 400 && res.status < 500, `transfer to a non-org-member: ${res.status}`);
    assert.equal(now.owner_id, w.owner.id, 'a rejected transfer changes nothing');
  }
});

test('[CR1-EV] the organization activity feed records org events; workspace feeds stay v1', async () => {
  const w = await orgWorld();
  const extra = await registerUser({ name: 'Fay' });
  expectStatus(await w.owner.client.patch(`/v1/organizations/${w.org.id}`, { name: uniqueName('Renamed') }), 200);
  await addOrgMember(w.owner, w.org.id, extra, 'org_member');
  expectStatus(await w.owner.client.patch(`/v1/organizations/${w.org.id}/members/${extra.id}`, { role: 'billing' }), 200);
  expectStatus(await w.owner.client.delete(`/v1/organizations/${w.org.id}/members/${extra.id}`), 204);
  await setPlan(w.billing, w.org.id, 'team');
  expectStatus(await w.owner.client.delete(`/v1/organizations/${w.org.id}`), 204);
  expectStatus(await w.owner.client.post(`/v1/organizations/${w.org.id}/restore`), 200);
  const ws = await createWorkspaceIn(w.owner, w.org.id);

  const feed = await w.member.client.pageAll(`/v1/organizations/${w.org.id}/activity`, { limit: 3 });
  const counts = countBy(feed.items, (e) => e.type);
  for (const type of ['organization.created', 'organization.deleted', 'organization.restored', 'plan.changed', 'org_member.role_changed', 'org_member.removed']) {
    assert.equal(counts.get(type), 1, `exactly one ${type}: ${JSON.stringify([...counts])}`);
  }
  assert.equal(counts.get('org_member.added'), 4, 'three fixture members plus one extra');
  assert.ok((counts.get('organization.updated') ?? 0) >= 1, 'the rename is organization.updated');
  const occurred = feed.items.map((e) => e.occurred_at);
  assert.deepEqual(occurred, [...occurred].sort().reverse(), 'org activity is newest first');
  const removed = feed.items.find((e) => e.type === 'org_member.removed');
  assert.equal(removed.actor.id, w.owner.id);
  assertTimestamps(feed.items);
  const wsTypes = (await activity(w.owner, ws.id)).map((e) => e.type);
  assert.ok(wsTypes.every((t) => !/^(organization|org_member|plan)\./.test(t)), `workspace activity unchanged: ${wsTypes}`);
});

test('[CR1-R] roles other than the four org roles are 422 invalid_enum', async () => {
  const w = await orgWorld();
  const fay = await registerUser({ name: 'Fay' });
  expectValidation(await postOrgMember(w.owner, w.org.id, fay, 'superuser' as OrgRole), 'role', 'invalid_enum');
});
