import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus } from '../lib/assert.ts';
import type { Json } from '../lib/client.ts';
import { registerUser, type User } from '../lib/fixtures.ts';
import type { Id } from '../lib/ids.ts';
import { legacySkip, legacyUser, loadLegacy, requireLegacyDataset, type LegacyManifest } from '../lib/legacy.ts';
import { memberUserId, orgMembers, PLAN_LIMITS } from '../lib/orgs.ts';

// Runs against the dataset of scripts/seed-legacy.ts after ./bin/setup (run twice) migrated it; never resets.
const manifest = loadLegacy();
const skip = legacySkip('CR-1', manifest);
const m = manifest as LegacyManifest;

requireLegacyDataset(manifest, skip);

const user = (name: 'ana' | 'bo' | 'cy' | 'dee'): User => legacyUser(m.users[name]);

async function orgsOf(u: User): Promise<Json[]> {
  return (await u.client.pageAll('/v1/organizations', { limit: 100 })).items;
}

async function orgOfWorkspace(owner: User, wsId: Id): Promise<{ org: Json; spaces: Json[] }> {
  for (const org of await orgsOf(owner)) {
    const spaces = (await owner.client.pageAll(`/v1/organizations/${org.id}/workspaces`, { limit: 100 })).items;
    if (spaces.some((w) => w.id === wsId)) return { org, spaces };
  }
  assert.fail(`no organization of the owner contains workspace ${wsId}`);
}

async function wsIdOf(owner: User, legacyId: number): Promise<Id> {
  const res = await owner.client.get(`/v1/workspaces/${legacyId}`);
  expectStatus(res, 200, 'migrated workspace readable by its v1 id or a CR-2 legacy id');

  return res.body.id;
}

test('[CR1-1] each v1 owner lists exactly one free organization per workspace they owned, named after it', { skip }, async () => {
  const cases: ['ana' | 'bo', ('alpha' | 'beta' | 'gamma')[]][] = [['ana', ['alpha', 'beta']], ['bo', ['gamma']]];
  for (const [name, owned] of cases) {
    const u = user(name);
    const orgs = await orgsOf(u);
    assert.deepEqual(orgs.map((o) => o.name).sort(), owned.map((k) => m.workspaces[k].name).sort(), `${name} owns one org per owned workspace (setup is idempotent)`);
    for (const org of orgs) {
      assert.equal(org.plan, 'free');
      assert.deepEqual(org.limits, PLAN_LIMITS.free);
      assert.equal(org.owner_id, (await u.client.get('/v1/users/me')).body.id);
    }
    for (const key of owned) {
      const wsId = await wsIdOf(u, m.workspaces[key].id);
      const { spaces } = await orgOfWorkspace(u, wsId);
      assert.deepEqual(spaces.map((w: Json) => w.id), [wsId], 'each migrated organization holds exactly its workspace');
    }
  }
});

test('[CR1-1] every workspace member becomes org_member of that workspace organization', { skip }, async () => {
  const ana = user('ana');
  const alphaId = await wsIdOf(ana, m.workspaces.alpha.id);
  const { org } = await orgOfWorkspace(ana, alphaId);
  const wsMembers = (await ana.client.pageAll(`/v1/workspaces/${alphaId}/members`, { limit: 100 })).items;
  const members = await orgMembers(ana, org.id);
  const owner = wsMembers.find((x) => x.role === 'owner');
  const roleOf = new Map(members.map((x) => [memberUserId(x), x.role]));
  assert.equal(roleOf.get(owner.user.id), 'org_owner');
  for (const x of wsMembers.filter((w) => w.role !== 'owner')) assert.equal(roleOf.get(x.user.id), 'org_member', `${x.user.email} (${x.role}) is org_member`);
  assert.equal(members.length, wsMembers.length, 'no one else is in the organization');
  const cyOrgs = (await orgsOf(user('cy'))).map((o) => o.name).sort();
  assert.deepEqual(cyOrgs, [m.workspaces.alpha.name, m.workspaces.beta.name].sort(), 'a member of two workspaces sees both organizations');
  const deeOrgs = (await orgsOf(user('dee'))).map((o) => o.name).sort();
  assert.deepEqual(deeOrgs, [m.workspaces.alpha.name, m.workspaces.gamma.name].sort());
});

test('[CR1-1] data above the free limits stays intact; only growth is blocked', { skip }, async () => {
  const ana = user('ana');
  const alphaId = await wsIdOf(ana, m.workspaces.alpha.id);
  const wsMembers = (await ana.client.pageAll(`/v1/workspaces/${alphaId}/members`, { limit: 100 })).items;
  assert.equal(wsMembers.length, 11, 'all 11 members survive the migration');
  const hooks = (await ana.client.pageAll(`/v1/workspaces/${alphaId}/webhooks`, { limit: 100 })).items;
  assert.equal(hooks.length, 3, 'all 3 webhooks survive the migration');
  const newcomer = await registerUser({ name: 'Late' });
  const add = await ana.client.post(`/v1/workspaces/${alphaId}/members`, { email: newcomer.email, role: 'member' });
  expectError(add, 422, 'validation_failed');
  assert.equal(add.body.error.details[0].code, 'plan_limit_exceeded');
  assert.equal(add.body.error.details[0].limit, 10);
  const hook = await ana.client.post(`/v1/workspaces/${alphaId}/webhooks`, { url: 'http://127.0.0.1:9/late', events: ['task.created'] });
  expectError(hook, 422, 'validation_failed');
  assert.equal(hook.body.error.details[0].limit, 2);
});

test('[CR1-1] migrated workspaces keep their projects, tasks and memberships', { skip }, async () => {
  const cy = user('cy');
  const task = await cy.client.get(`/v1/tasks/${m.tasks.t1.id}`);
  expectStatus(task, 200, 'a v1 member still reads a migrated task (CR-2 serves integer ids through the legacy path)');
  assert.equal(task.body.title, m.tasks.t1.title);
  const listed = await cy.client.pageAll('/v1/workspaces', { limit: 100 });
  assert.deepEqual(listed.items.map((w) => w.name).sort(), [m.workspaces.alpha.name, m.workspaces.beta.name].sort(), 'Cy is still a member of alpha and beta');
  const alphaId = await wsIdOf(cy, m.workspaces.alpha.id);
  const titles = (await cy.client.pageAll(`/v1/workspaces/${alphaId}/tasks`, { limit: 100 })).items.map((x) => x.title);
  for (const k of ['t1', 't2', 't3'] as const) assert.ok(titles.includes(m.tasks[k].title), `${m.tasks[k].title} survives the migration`);
});
