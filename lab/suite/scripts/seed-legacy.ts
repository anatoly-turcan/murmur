// Usage: TASKWELL_BASE_URL=… [SUITE_CR=none] node scripts/seed-legacy.ts <manifest.json>
// Seeds the pre-migration dataset that tests/cr*-legacy-*.test.ts read after ./bin/setup migrates it.
import { writeFileSync } from 'node:fs';
import { getClock } from '../lib/clock.ts';
import { idempotencyKey, type Json } from '../lib/client.ts';
import { crMode } from '../lib/cr.ts';
import { RUN_TOKEN } from '../lib/env.ts';
import { activity, addMember, createComment, createProject, createTask, createWebhook, createWorkspace, getOk, need, patchOk, registerUser, registerUsers, type User } from '../lib/fixtures.ts';
import { drainAll, reset } from '../lib/testmode.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/seed-legacy.ts <manifest.json>');

function person(u: User): Json {
  return { id: u.id, email: u.email, name: u.name, key: u.key, keyId: u.keyId, created_at: u.raw.user.created_at };
}

function object(o: Json, extra: Json = {}): Json {
  return { id: o.id, created_at: o.created_at, ...extra };
}

async function seedPeople() {
  const [ana, bo, cy, dee] = [await registerUser({ name: 'Ana' }), await registerUser({ name: 'Bo' }), await registerUser({ name: 'Cy' }), await registerUser({ name: 'Dee' })];
  const extras = await registerUsers(8, { name: 'Extra' });

  return { ana, bo, cy, dee, extras };
}

// Alpha has 11 members and 3 webhooks, above the free plan limits that CR-1 migration assigns.
async function seedWorkspaces(p: Awaited<ReturnType<typeof seedPeople>>) {
  const alpha = await createWorkspace(p.ana, { name: `Legacy Alpha ${RUN_TOKEN}` });
  await addMember(p.ana, alpha.id, p.dee, 'admin');
  await addMember(p.ana, alpha.id, p.cy, 'member');
  for (const u of p.extras) await addMember(p.ana, alpha.id, u, 'member');
  const beta = await createWorkspace(p.ana, { name: `Legacy Beta ${RUN_TOKEN}` });
  await addMember(p.ana, beta.id, p.cy, 'member');
  const gamma = await createWorkspace(p.bo, { name: `Legacy Gamma ${RUN_TOKEN}` });
  await addMember(p.bo, gamma.id, p.dee, 'member');

  return { alpha, beta, gamma };
}

async function seedWork(p: Awaited<ReturnType<typeof seedPeople>>, ws: Awaited<ReturnType<typeof seedWorkspaces>>) {
  const projects = {
    alpha: await createProject(p.ana, ws.alpha.id, { name: 'Legacy Website' }),
    beta: await createProject(p.ana, ws.beta.id, { name: 'Legacy Beta Site' }),
    gamma: await createProject(p.bo, ws.gamma.id, { name: 'Legacy Gamma Site' }),
  };
  const tasks = {
    t1: await createTask(p.ana, projects.alpha.id, { title: 'Legacy login bug', assignee_id: p.cy.id, labels: ['bug'] }),
    t2: await createTask(p.ana, projects.alpha.id, { title: 'Legacy unassigned' }),
    t3: await createTask(p.cy, projects.alpha.id, { title: 'Legacy cy task', assignee_id: p.cy.id }),
    beta: await createTask(p.ana, projects.beta.id, { title: 'Legacy beta task', assignee_id: p.cy.id }),
    gamma: await createTask(p.bo, projects.gamma.id, { title: 'Legacy gamma task', assignee_id: p.dee.id }),
  };
  const c1 = await createComment(p.cy, tasks.t1.id, 'Legacy comment');

  return { projects, tasks, c1 };
}

async function seedWebhooks(owner: User, wsId: number): Promise<Json[]> {
  const hooks: Json[] = [];
  for (let i = 0; i < 3; i += 1) {
    const hook = await createWebhook(owner, wsId, { url: `http://127.0.0.1:9/legacy-${i}`, events: ['task.created'] });
    hooks.push(await patchOk(owner, `/v1/webhooks/${hook.id}`, { active: false }));
  }

  return hooks;
}

async function seedIdempotency(owner: User, projectId: number): Promise<Json> {
  const key = idempotencyKey('legacy');
  const path = `/v1/projects/${projectId}/tasks`;
  const body = { title: 'Legacy idempotent create' };
  const res = await owner.client.post(path, body, { idempotencyKey: key });
  need(res, 201, 'idempotent create');

  return { key, path, body, status: res.status, text: res.text };
}

async function seedCursor(owner: User, projectId: number): Promise<Json> {
  const path = `/v1/projects/${projectId}/tasks`;
  const query = { limit: 1 };
  const page = await getOk(owner, path, query);
  if (!page.next_cursor) throw new Error('seed: expected a next_cursor on a one-item page');

  return { path, query, cursor: page.next_cursor };
}

await reset();
const people = await seedPeople();
const workspaces = await seedWorkspaces(people);
const work = await seedWork(people, workspaces);
const webhooks = await seedWebhooks(people.ana, workspaces.alpha.id);
const idempotency = await seedIdempotency(people.ana, work.projects.alpha.id);
const cursor = await seedCursor(people.ana, work.projects.alpha.id);
await drainAll();
const t1Created = (await activity(people.ana, workspaces.alpha.id, { type: 'task.created' })).find((e) => e.target.id === work.tasks.t1.id);
const clock = await getClock();

const manifest = {
  version: 1,
  seededAt: clock.now,
  seedMode: crMode,
  users: { ana: person(people.ana), bo: person(people.bo), cy: person(people.cy), dee: person(people.dee), extras: people.extras.map(person) },
  workspaces: {
    alpha: object(workspaces.alpha, { name: workspaces.alpha.name, owner: 'ana' }),
    beta: object(workspaces.beta, { name: workspaces.beta.name, owner: 'ana' }),
    gamma: object(workspaces.gamma, { name: workspaces.gamma.name, owner: 'bo' }),
  },
  projects: { alpha: object(work.projects.alpha), beta: object(work.projects.beta), gamma: object(work.projects.gamma) },
  tasks: Object.fromEntries(Object.entries(work.tasks).map(([k, t]) => [k, object(t, { assignee_id: t.assignee_id, title: t.title })])),
  comments: { c1: object(work.c1, { task_id: work.c1.task_id }) },
  webhooks: webhooks.map((h) => object(h)),
  events: { t1Created: { id: t1Created.id, created_at: t1Created.occurred_at } },
  idempotency,
  cursor,
};
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`legacy dataset seeded at ${clock.now} (SUITE_CR=${crMode}) → ${out}`);
