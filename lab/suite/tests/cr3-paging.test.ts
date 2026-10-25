import assert from 'node:assert/strict';
import { assertUnique, expectStatus } from '../lib/assert.ts';
import { setClock } from '../lib/clock.ts';
import type { Json } from '../lib/client.ts';
import { auditTeam, workspaceAudit } from '../lib/audit.ts';
import { crTest } from '../lib/cr.ts';
import { createTask } from '../lib/fixtures.ts';
import type { Id } from '../lib/ids.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

const test = crTest('CR-3');

freshDatabaseEachTest();

test('[CR3-7] paging 250+ entries at limit=100 while new mutations land returns each existing entry exactly once', async () => {
  await setClock('2026-05-20T08:00:00Z');
  const t = await auditTeam();
  const tasks: Json[] = [];
  for (let i = 0; i < 5; i += 1) tasks.push(await createTask(t.owner, t.project.id, { title: `Paging ${i}` }));
  for (let i = 0; i < 250; i += 25) {
    const batch = Array.from({ length: 25 }, (_, j) => t.owner.client.patch(`/v1/tasks/${tasks[(i + j) % tasks.length].id}`, {}));
    for (const res of await Promise.all(batch)) expectStatus(res, 200);
  }
  const existing = (await workspaceAudit(t.owner, t.ws.id)).map((e) => e.id);
  assert.ok(existing.length >= 250, `expected 250+ entries, got ${existing.length}`);

  const path = `/v1/workspaces/${t.ws.id}/audit`;
  const seen: Id[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await t.owner.client.get(path, cursor ? { limit: 100, cursor } : { limit: 100 });
    expectStatus(res, 200);
    seen.push(...res.body.data.map((e: Json) => e.id));
    cursor = res.body.next_cursor;
    pages += 1;
    for (let j = 0; j < 10; j += 1) expectStatus(await t.owner.client.patch(`/v1/tasks/${tasks[j % tasks.length].id}`, {}), 200);
  } while (cursor && pages < 20);
  assertUnique(seen, 'audit entry ids across pages');
  const missing = existing.filter((id) => !seen.includes(id));
  assert.deepEqual(missing, [], 'every pre-existing entry appears exactly once');
});
