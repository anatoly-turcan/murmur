import assert from 'node:assert/strict';
import { expectError, expectStatus } from '../lib/assert.ts';
import { advance, setClock } from '../lib/clock.ts';
import { request, type ApiResponse, type Json } from '../lib/client.ts';
import { auditTeam, type AuditTeam } from '../lib/audit.ts';
import { crTest } from '../lib/cr.ts';
import { createTask, registerUser } from '../lib/fixtures.ts';
import { addOrgMember, type OrgRole } from '../lib/orgs.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drainAll, emails, sleep } from '../lib/testmode.ts';
import { killWorkers, startWorkers, workerControlSkip } from '../lib/worker.ts';

const test = crTest('CR-3');

freshDatabaseEachTest();

const ENTRIES = 10_000;
const PER_WINDOW = 550;

interface Range {
  since: string;
  until: string;
}

// Exactly ENTRIES empty PATCHes (one entry each) inside [since, until); the clock moves a minute every
// PER_WINDOW requests so the owner's 600/minute bucket never trips.
async function auditRange(t: AuditTeam, entries: number): Promise<Range> {
  const tasks: Json[] = [];
  for (let i = 0; i < 10; i += 1) tasks.push(await createTask(t.owner, t.project.id, { title: `Export ${i}` }));
  const since = await advance(60);
  for (let done = 0; done < entries; ) {
    const windowEnd = Math.min(entries, done + PER_WINDOW);
    while (done < windowEnd) {
      const size = Math.min(25, windowEnd - done);
      const batch = Array.from({ length: size }, (_, j) => t.owner.client.patch(`/v1/tasks/${tasks[(done + j) % tasks.length].id}`, {}));
      for (const res of await Promise.all(batch)) expectStatus(res, 200);
      done += size;
    }
    await advance(60);
  }
  const until = await advance(60);

  return { since, until };
}

async function requestExport(t: AuditTeam, range: Range): Promise<ApiResponse> {
  const res = await t.owner.client.post(`/v1/organizations/${t.org.id}/audit/exports`, range);
  expectStatus(res, [201, 202]);

  return res;
}

async function readyEmail(t: AuditTeam): Promise<Json> {
  const sent = await emails({ template: 'audit_export_ready', to: t.owner.email });
  assert.equal(sent.length, 1, `exactly one audit_export_ready email, got ${sent.length}`);
  assert.ok(sent[0].data.export_id !== undefined && sent[0].data.export_id !== null, 'data.export_id');

  return sent[0];
}

async function expectNdjson(t: AuditTeam, exportId: Json, range: Range, lines: number): Promise<void> {
  const res = await request('GET', `/v1/organizations/${t.org.id}/audit/exports/${exportId}`, { key: t.owner.key, ip: t.owner.client.ip });
  expectStatus(res, 200);
  assert.match(res.headers.get('content-type') ?? '', /^application\/x-ndjson/);
  const rows = res.text.split('\n').filter((l) => l.trim() !== '');
  assert.equal(rows.length, lines, 'one line per entry in the range');
  for (const row of [rows[0], rows[Math.floor(rows.length / 2)], rows.at(-1)!]) {
    const e = JSON.parse(row);
    assert.ok(e.occurred_at >= range.since && e.occurred_at < range.until, `entry ${e.id} at ${e.occurred_at} outside the range`);
    assert.equal(e.organization_id, t.org.id);
  }
}

test('[CR3-8] exporting a 10,000-entry range emails audit_export_ready once and serves a 10,000-line NDJSON file', async () => {
  await setClock('2026-08-01T10:00:00Z');
  const t = await auditTeam();
  const range = await auditRange(t, ENTRIES);
  await requestExport(t, range);
  await drainAll();
  const mail = await readyEmail(t);
  await expectNdjson(t, mail.data.export_id, range, ENTRIES);
  await drainAll();
  await readyEmail(t);
});

test('[CR3-8] the export still emails exactly once when the worker is killed mid-export and restarted', { skip: workerControlSkip }, async (t) => {
  t.after(() => startWorkers());
  await setClock('2026-08-01T10:00:00Z');
  const team = await auditTeam();
  const range = await auditRange(team, ENTRIES);
  await requestExport(team, range);
  await sleep(150);
  killWorkers();
  startWorkers();
  await advance(60);
  await drainAll();
  const mail = await readyEmail(team);
  await expectNdjson(team, mail.data.export_id, range, ENTRIES);
});

test('[CR3-S] audit exports: org_owner and billing may request them; org_admin and org_member get 403', async () => {
  await setClock('2026-08-01T10:00:00Z');
  const t = await auditTeam();
  const roles = { billing: await registerUser({ name: 'Bill' }), org_admin: await registerUser({ name: 'Ada' }), org_member: await registerUser({ name: 'Mo' }) };
  for (const [role, user] of Object.entries(roles)) await addOrgMember(t.owner, t.org.id, user, role as OrgRole);
  const range = { since: '2026-08-01T00:00:00.000Z', until: '2026-08-02T00:00:00.000Z' };
  expectStatus(await roles.billing.client.post(`/v1/organizations/${t.org.id}/audit/exports`, range), [201, 202]);
  expectError(await roles.org_admin.client.post(`/v1/organizations/${t.org.id}/audit/exports`, range), 403, 'forbidden');
  expectError(await roles.org_member.client.post(`/v1/organizations/${t.org.id}/audit/exports`, range), 403, 'forbidden');
  await drainAll();
  const sent = await emails({ template: 'audit_export_ready', to: roles.billing.email });
  assert.equal(sent.length, 1, 'the requester gets the email');
});
