import assert from 'node:assert/strict';
import { expectStatus } from '../lib/assert.ts';
import { advance, setClock } from '../lib/clock.ts';
import type { Json } from '../lib/client.ts';
import { assertEntryShape, audit, auditTeam, workspaceAudit } from '../lib/audit.ts';
import { crTest } from '../lib/cr.ts';
import { createTask, createWebhook, getOk } from '../lib/fixtures.ts';
import { fail, ok, startReceiver } from '../lib/receiver.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';
import { drainAll, emails } from '../lib/testmode.ts';

const test = crTest('CR-3');

freshDatabaseEachTest();

const SECRET = 'audit-secret-0f3b7c9e2a4d6f8b1c3e5a7d9f0b2c4e';

function byOccurred(entries: Json[]): Json[] {
  return [...entries].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.after.attempts.length - b.after.attempts.length);
}

test('[CR3-5] a delivery that succeeds on its second attempt yields two system deliver entries; the secret never appears', async (t) => {
  await setClock('2026-04-01T10:00:00Z');
  const w = await auditTeam();
  const receiver = await startReceiver((_req, i) => (i === 0 ? fail(500) : ok()));
  t.after(() => receiver.close());
  const hook = await createWebhook(w.owner, w.ws.id, { url: receiver.url, events: ['task.created'], secret: SECRET });
  expectStatus(await w.owner.client.patch(`/v1/webhooks/${hook.id}`, { events: ['task.created', 'task.updated'] }), 200);
  await createTask(w.owner, w.project.id);
  await drainAll();
  await advance(30);
  await drainAll();
  const [delivery] = (await getOk(w.owner, `/v1/webhooks/${hook.id}/deliveries`)).data;
  assert.equal(delivery.status, 'succeeded');
  const deliver = byOccurred((await workspaceAudit(w.owner, w.ws.id, { action: 'deliver' })).filter((e) => e.resource.id === delivery.id));
  assert.equal(deliver.length, 2, JSON.stringify(deliver).slice(0, 600));
  for (const e of deliver) {
    assertEntryShape(e);
    assert.equal(e.actor.type, 'system');
    assert.equal(e.after.id, delivery.id, 'after holds the delivery record');
  }
  assert.deepEqual(deliver.map((e) => e.after.attempts.length), [1, 2]);
  assert.equal(deliver[1].after.status, 'succeeded');

  const everything = [
    ...(await workspaceAudit(w.owner, w.ws.id)),
    ...(await audit(w.owner, `/v1/organizations/${w.org.id}/audit`)),
    ...(await audit(w.owner, '/v1/users/me/audit')),
  ];
  const text = JSON.stringify(everything);
  assert.ok(!text.includes(SECRET), 'the webhook secret never appears in an audit entry');
  const created = everything.find((e) => e.resource.type === 'webhook' && e.action === 'create');
  assert.ok(created, 'webhook creation is audited');
  if (created.after && 'secret' in created.after) assert.equal(created.after.secret, '[redacted]');
});

test('[CR3-5] emails sent by the worker are audited as system send entries holding the email record', async () => {
  const w = await auditTeam();
  const task = await createTask(w.owner, w.project.id, { assignee_id: w.member.id });
  await drainAll();
  const [mail] = await emails({ template: 'task_assigned', to: w.member.email });
  assert.ok(mail, 'task_assigned email');
  const sends = (await workspaceAudit(w.owner, w.ws.id, { action: 'send' })).filter((e) => e.after?.dedupe_key === mail.dedupe_key);
  assert.equal(sends.length, 1);
  assertEntryShape(sends[0]);
  assert.equal(sends[0].actor.type, 'system');
  assert.equal(sends[0].after.template, 'task_assigned');
  assert.equal(sends[0].after.to, w.member.email);
  assert.equal(sends[0].after.data.task_id, task.id);
});
