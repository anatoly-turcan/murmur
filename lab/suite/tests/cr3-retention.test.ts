import assert from 'node:assert/strict';
import { expectError, expectStatus } from '../lib/assert.ts';
import { advance, setClock } from '../lib/clock.ts';
import type { Json } from '../lib/client.ts';
import { audit, auditTeam, workspaceAudit } from '../lib/audit.ts';
import { crTest } from '../lib/cr.ts';
import { env } from '../lib/env.ts';
import { createTask, getOk } from '../lib/fixtures.ts';
import { addOrgMember } from '../lib/orgs.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { tickAndDrain } from '../lib/testmode.ts';

const test = crTest('CR-3');

freshDatabaseEachTest();

const DAYS = env.candidateAuditRetentionDays;

// The candidate runs with TASKWELL_AUDIT_RETENTION_DAYS = SUITE_CANDIDATE_AUDIT_RETENTION_DAYS (30, as in PHASE2 CR-3 AC6).
test(`[CR3-6] after advancing ${DAYS + 1} days and a scheduler tick, older entries are gone everywhere; newer ones stay`, async () => {
  await setClock('2026-03-01T12:00:00Z');
  const t = await auditTeam();
  const old = await createTask(t.owner, t.project.id, { title: 'Old news' });
  const oldEntries = await workspaceAudit(t.owner, t.ws.id);
  assert.ok(oldEntries.length >= 2);
  const statsBefore = await getOk(t.owner, `/v1/organizations/${t.org.id}/audit/stats`);
  assert.equal(statsBefore.retention_days, DAYS);
  assert.ok(statsBefore.entries >= oldEntries.length);

  await advance((DAYS + 1) * 86_400);
  const fresh = await createTask(t.owner, t.project.id, { title: 'Fresh news' });
  await tickAndDrain();

  const ws = await workspaceAudit(t.owner, t.ws.id);
  const org = await audit(t.owner, `/v1/organizations/${t.org.id}/audit`);
  const mine = await audit(t.owner, '/v1/users/me/audit');
  const gone = new Set(oldEntries.map((e) => e.id));
  for (const [where, list] of [['workspace', ws], ['organization', org], ['users/me', mine]] as [string, Json[]][]) {
    assert.deepEqual(list.filter((e) => gone.has(e.id)), [], `${where} audit no longer lists purged entries`);
  }
  for (const e of oldEntries.slice(0, 3)) expectError(await t.owner.client.get(`/v1/audit/${e.id}`), 404, 'not_found');
  assert.ok(ws.some((e) => e.resource.id === fresh.id && e.action === 'create'), 'entries after the advance remain');
  assert.ok(!ws.some((e) => e.resource.id === old.id));
  const stats = await getOk(t.owner, `/v1/organizations/${t.org.id}/audit/stats`);
  assert.equal(stats.entries, org.length, 'stats.entries counts what the organization audit lists');
  assert.equal(stats.oldest, org.map((e) => e.occurred_at).sort()[0]);
  assert.equal(stats.retention_days, DAYS);
  expectStatus(await t.owner.client.get(`/v1/tasks/${old.id}`), 200, 'purging audit entries never touches the resources');
});

test('[CR3-S] audit stats follow the organization audit permissions', async () => {
  const t = await auditTeam();
  await addOrgMember(t.owner, t.org.id, t.member, 'org_member');
  expectStatus(await t.owner.client.get(`/v1/organizations/${t.org.id}/audit/stats`), 200);
  expectError(await t.member.client.get(`/v1/organizations/${t.org.id}/audit/stats`), 403, 'forbidden');
  expectError(await t.admin.client.get(`/v1/organizations/${t.org.id}/audit/stats`), 404, 'not_found');
});
