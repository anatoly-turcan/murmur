import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertUnique, expectError, expectStatus } from '../lib/assert.ts';
import { setClock } from '../lib/clock.ts';
import type { Json, Query } from '../lib/client.ts';
import { addMember, createTask, createTasks, deleteOk, patchOk, registerUser, registerUsers, team, type Team } from '../lib/fixtures.ts';
import { compareIds, compareIdsDesc, type Id } from '../lib/ids.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

async function fullOrder(t: Team, query: Query): Promise<number[]> {
  const all = await t.owner.client.pageAll(`/v1/projects/${t.project.id}/tasks`, { ...query, limit: 100 });

  return all.items.map((x) => x.id);
}

async function pagingSession(t: Team, query: Query, between: (pageOne: number[]) => Promise<number[]>): Promise<{ seen: number[]; changed: number[] }> {
  const path = `/v1/projects/${t.project.id}/tasks`;
  const first = await t.owner.client.get(path, { ...query, limit: 10 });
  expectStatus(first, 200);
  const seen: number[] = first.body.data.map((x: Json) => x.id);
  const changed = await between(seen);
  let cursor: string | null = first.body.next_cursor;
  assert.equal(typeof cursor, 'string', 'page 1 must have a next_cursor');
  while (cursor) {
    const res = await t.owner.client.get(path, { ...query, limit: 10, cursor });
    expectStatus(res, 200);
    seen.push(...res.body.data.map((x: Json) => x.id));
    cursor = res.body.next_cursor;
  }

  return { seen, changed };
}

function assertExactlyOnce(seen: number[], expected: number[]): void {
  assertUnique(seen, 'task ids across pages');
  const missing = expected.filter((id) => !seen.includes(id));
  assert.deepEqual(missing, [], 'every surviving unmodified task must appear exactly once');
}

test('[C1] created_at paging is stable while tasks are created and deleted between pages', async () => {
  const t = await team();
  await createTasks(t.owner, t.project.id, 50, (i) => ({ title: `Stable ${i}` }));
  const original = await fullOrder(t, {});
  assert.equal(original.length, 50);
  const doomed = [original[11], original[13], original[15]];
  const { seen } = await pagingSession(t, {}, async () => {
    await createTasks(t.owner, t.project.id, 5, (i) => ({ title: `Fresh ${i}` }));
    for (const id of doomed) await deleteOk(t.owner, `/v1/tasks/${id}`);

    return doomed;
  });
  assertExactlyOnce(seen, original.filter((id) => !doomed.includes(id)));
  assert.deepEqual(seen.filter((id) => doomed.includes(id)), [], 'deleted tasks are not listed');
});

test('[C1] due_date paging is stable with many shared due dates', async () => {
  const t = await team();
  await createTasks(t.owner, t.project.id, 50, (i) => ({
    title: `Due ${i}`,
    due_date: i < 20 ? '2026-12-01' : i < 35 ? `2026-11-${String(i - 19).padStart(2, '0')}` : null,
  }));
  const original = await fullOrder(t, { sort: 'due_date' });
  const doomed = [original[10], original[14], original[18]];
  const { seen } = await pagingSession(t, { sort: 'due_date' }, async () => {
    await createTasks(t.owner, t.project.id, 5, (i) => ({ title: `Late ${i}`, due_date: '2026-12-01' }));
    for (const id of doomed) await deleteOk(t.owner, `/v1/tasks/${id}`);

    return doomed;
  });
  assertExactlyOnce(seen, original.filter((id) => !doomed.includes(id)));
});

test('[C1] updated_at paging: modifying items never makes another item repeat or vanish', async () => {
  const t = await team();
  await createTasks(t.owner, t.project.id, 30, (i) => ({ title: `Touch ${i}` }));
  const original = await fullOrder(t, { sort: 'updated_at' });
  const touched = [original[21], original[25], original[28]];
  const { seen } = await pagingSession(t, { sort: 'updated_at' }, async () => {
    for (const id of touched) await patchOk(t.owner, `/v1/tasks/${id}`, { status: 'in_progress' });

    return touched;
  });
  assertExactlyOnce(seen, original.filter((id) => !touched.includes(id)));
});

function dueKey(task: Json): [number, string, Id] {
  return task.due_date === null ? [1, '', task.id] : [0, task.due_date, task.id];
}

function compareDue(a: Json, b: Json): number {
  const [x, y] = [dueKey(a), dueKey(b)];
  if (x[0] !== y[0]) return x[0] - y[0];
  if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;

  return compareIds(x[2], y[2]);
}

test('[C2] sort=due_date: ascending, nulls last, id asc within ties, deterministic', async () => {
  const t = await team();
  const specs: (string | null)[] = [];
  for (let i = 0; i < 10; i += 1) specs.push('2026-11-15', null, `2026-${i < 5 ? '10' : '12'}-${String(10 + i).padStart(2, '0')}`);
  await createTasks(t.owner, t.project.id, specs.length, (i) => ({ title: `Sorted ${i}`, due_date: specs[i] }));
  const first = await t.owner.client.pageAll(`/v1/projects/${t.project.id}/tasks`, { sort: 'due_date', limit: 7 });
  assert.deepEqual(first.pages.map((p) => p.body.data.length), [7, 7, 7, 7, 2]);
  const expected = [...first.items].sort(compareDue).map((x) => x.id);
  assert.deepEqual(first.items.map((x) => x.id), expected);
  assert.equal(first.items.length, 30);
  const second = await t.owner.client.pageAll(`/v1/projects/${t.project.id}/tasks`, { sort: 'due_date', limit: 7 });
  assert.deepEqual(second.items.map((x) => x.id), expected, 'repeat run must give the identical order');
});

test('[C2] frozen clock: created_at and updated_at ties fall back to id desc', async () => {
  const now = await setClock('2026-06-01T12:00:00Z');
  const t = await team();
  const tasks = await createTasks(t.owner, t.project.id, 12);
  assert.ok(tasks.every((x) => x.created_at === now), 'every created_at uses the frozen clock');
  const byId = tasks.map((x) => x.id).sort(compareIdsDesc);
  for (const sort of ['created_at', 'updated_at']) {
    const res = await t.owner.client.pageAll(`/v1/projects/${t.project.id}/tasks`, { sort, limit: 5 });
    assert.deepEqual(res.items.map((x) => x.id), byId, `sort=${sort} with tied timestamps must be id desc`);
  }
  const ws = await t.owner.client.pageAll(`/v1/workspaces/${t.ws.id}/tasks`, { limit: 5 });
  assert.deepEqual(ws.items.map((x) => x.id), byId);
});

test('[C2] members ordered joined_at asc then user_id asc; activity occurred_at desc then id desc', async () => {
  await setClock('2026-06-01T12:00:00Z');
  const owner = await registerUser({ name: 'Owner' });
  const others = await registerUsers(5, { name: 'Joiner' });
  const wsRes = await owner.client.post('/v1/workspaces', { name: 'Tie Ops' });
  expectStatus(wsRes, 201);
  for (const u of [...others].reverse()) await addMember(owner, wsRes.body.id, u, 'member');

  const members = await owner.client.pageAll(`/v1/workspaces/${wsRes.body.id}/members`, { limit: 2 });
  const expected = [owner, ...others].map((u) => u.id).sort(compareIds);
  assert.deepEqual(members.items.map((m) => m.user.id), expected, 'tied joined_at must order by user_id asc');

  const events = await owner.client.pageAll(`/v1/workspaces/${wsRes.body.id}/activity`, { limit: 2 });
  const eventIds = events.items.map((e) => e.id);
  assert.equal(eventIds.length, 6);
  assert.deepEqual(eventIds, [...eventIds].sort(compareIdsDesc), 'tied occurred_at must order by id desc');
});

async function bugTasks(t: Team): Promise<void> {
  await createTasks(t.owner, t.project.id, 6, (i) => ({ title: `Bug ${i}`, labels: ['bug'] }));
  await createTasks(t.owner, t.project.id, 2, (i) => ({ title: `Done bug ${i}`, labels: ['bug'], status: 'done' }));
  await createTask(t.owner, t.project.id, { title: 'UI', labels: ['ui'] });
}

async function firstCursor(t: Team, query: Query): Promise<{ cursor: string; ids: number[] }> {
  const res = await t.owner.client.get(`/v1/projects/${t.project.id}/tasks`, { ...query, limit: 2 });
  expectStatus(res, 200);
  assert.equal(typeof res.body.next_cursor, 'string');

  return { cursor: res.body.next_cursor, ids: res.body.data.map((x: Json) => x.id) };
}

test('[C3] a cursor is bound to its filters, sort and include_deleted', async () => {
  const t = await team();
  await bugTasks(t);
  const base = { status: 'open', label: 'bug' };
  const { cursor, ids } = await firstCursor(t, base);
  const path = `/v1/projects/${t.project.id}/tasks`;
  const variants: Query[] = [
    { status: 'done', label: 'bug' },
    { status: 'open', label: 'ui' },
    { ...base, sort: 'due_date' },
    { ...base, include_deleted: 'true' },
  ];
  for (const q of variants) {
    expectError(await t.owner.client.get(path, { ...q, limit: 2, cursor }), 400, 'invalid_cursor');
  }
  const same = await t.owner.client.get(path, { ...base, limit: 2, cursor });
  expectStatus(same, 200);
  assert.equal(same.body.data.length, 2);
  assert.ok(same.body.data.every((x: Json) => x.status === 'open' && x.labels.includes('bug')));
  assert.ok(same.body.data.every((x: Json) => !ids.includes(x.id)), 'page 2 must not repeat page 1');
});

test('[C3] tampered or garbage cursors are 400 invalid_cursor', async () => {
  const t = await team();
  await bugTasks(t);
  const { cursor } = await firstCursor(t, {});
  const path = `/v1/projects/${t.project.id}/tasks`;
  for (const bad of [`${cursor}%%xyz`, `${cursor}xyz`, 'garbage!!', 'c_', ''.padEnd(40, '~')]) {
    expectError(await t.owner.client.get(path, { limit: 2, cursor: bad }), 400, 'invalid_cursor');
  }
});

test('[C3] a cursor presented to a different list endpoint is 400 cursor_mismatched', async () => {
  const t = await team();
  await bugTasks(t);
  const { cursor } = await firstCursor(t, {});
  const task = (await t.owner.client.get(`/v1/projects/${t.project.id}/tasks`, { limit: 1 })).body.data[0];
  expectError(await t.owner.client.get(`/v1/tasks/${task.id}/comments`, { limit: 2, cursor }), 400, 'cursor_mismatched');
  expectError(await t.owner.client.get(`/v1/workspaces/${t.ws.id}/tasks`, { limit: 2, cursor }), 400, 'cursor_mismatched');
  const members = await t.owner.client.get(`/v1/workspaces/${t.ws.id}/members`, { limit: 1 });
  expectStatus(members, 200);
  assert.equal(typeof members.body.next_cursor, 'string');
  const res = await t.owner.client.get(`/v1/projects/${t.project.id}/tasks`, { limit: 2, cursor: members.body.next_cursor });
  expectError(res, 400, 'cursor_mismatched');
});
