import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { addSeconds, advance, setClock } from '../lib/clock.ts';
import { anonymous, type Json } from '../lib/client.ts';
import { activity, createProject, createTask, createWorkspace, deleteOk, getOk, registerUser, team, uniqueEmail, type Team } from '../lib/fixtures.ts';
import { NONEXISTENT_ID } from '../lib/endpoints.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

function postTask(t: Team, body: unknown) {
  return t.owner.client.post(`/v1/projects/${t.project.id}/tasks`, body);
}

function rawTask(t: Team, raw: string, contentType = 'application/json') {
  return t.owner.client.request('POST', `/v1/projects/${t.project.id}/tasks`, { rawBody: raw, contentType });
}

test('[I1] decomposed text is stored NFC and matched by search in either form', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id, { title: 'Café menu' });
  assert.equal(task.title, 'Café menu', 'title must be stored after NFC normalisation');
  for (const q of ['café', 'café', 'CAFÉ MENU']) {
    const res = await t.member.client.get(`/v1/workspaces/${t.ws.id}/search`, { q });
    expectStatus(res, 200);
    const hits = res.body.data.filter((r: Json) => r.task.id === task.id);
    assert.equal(hits.length, 1, `q=${JSON.stringify(q)} must find the task`);
    assert.equal(hits[0].match, 'title_prefix');
  }
  const folded = await createTask(t.owner, t.project.id, { title: 'STRASSE closed' });
  const res = await t.member.client.get(`/v1/workspaces/${t.ws.id}/search`, { q: 'straße' });
  expectStatus(res, 200);
  assert.ok(res.body.data.some((r: Json) => r.task.id === folded.id), 'full case folding: ß matches SS');
});

test('[I1] labels equal after NFKC + case folding are duplicates', async () => {
  const t = await team();
  expectValidation(await postTask(t, { title: 'x', labels: ['Straße', 'STRASSE'] }), 'labels[1]', 'duplicate');
  expectValidation(await postTask(t, { title: 'x', labels: ['a', 'b', 'Bug', 'bug'] }), 'labels[3]', 'duplicate');
  expectValidation(await postTask(t, { title: 'x', labels: ['ﬁx', 'fix'] }), 'labels[1]', 'duplicate');
  const task = await createTask(t.owner, t.project.id, { labels: ['Straße'] });
  const filtered = await t.owner.client.get(`/v1/projects/${t.project.id}/tasks`, { label: 'STRASSE' });
  expectStatus(filtered, 200);
  assert.deepEqual(filtered.body.data.map((x: Json) => x.id), [task.id], 'label filter compares as in 6.10');
});

test('[I1] label count and length limits', async () => {
  const t = await team();
  const twenty = Array.from({ length: 20 }, (_, i) => `l${i}`);
  expectStatus(await postTask(t, { title: 'x', labels: twenty }), 201);
  expectValidation(await postTask(t, { title: 'x', labels: [...twenty, 'l20'] }), 'labels', 'too_many_items');
  expectValidation(await postTask(t, { title: 'x', labels: ['ok', 'y'.repeat(41)] }), 'labels[1]', 'too_long');
});

test('[I1] slugs equal after NFKC + case folding collide', async () => {
  const t = await team();
  await createProject(t.owner, t.ws.id, { name: 'File', slug: 'file' });
  expectError(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/projects`, { name: 'Ligature', slug: 'ﬁle' }), 409, 'slug_taken');
  await createProject(t.owner, t.ws.id, { name: 'Cafe', slug: 'café' });
  expectError(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/projects`, { name: 'Cafe 2', slug: 'café' }), 409, 'slug_taken');
  await createWorkspace(t.owner, { name: 'Lig', slug: 'office' });
  expectError(await t.owner.client.post('/v1/workspaces', { name: 'Lig 2', slug: 'oﬃce' }), 409, 'slug_taken');
});

test('[I1] uppercase or malformed slugs are rejected', async () => {
  const t = await team();
  for (const slug of ['Acme', '-acme', 'acme-', 'ac--me', 'ac me', 'acme_ops']) {
    expectValidation(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/projects`, { name: 'Bad slug', slug }), 'slug', 'invalid_format');
  }
  expectValidation(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/projects`, { name: 'Long slug', slug: 'a'.repeat(51) }), 'slug', 'too_long');
});

test('[I1] email uniqueness is case-insensitive', async () => {
  const email = uniqueEmail('casey');
  expectStatus(await anonymous().post('/v1/users', { email, name: 'Casey' }), 201);
  expectError(await anonymous().post('/v1/users', { email: email.toUpperCase(), name: 'Casey 2' }), 409, 'email_taken');
});

test('[I1] strings are trimmed before validation and storage', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id, { title: '  Hi  ', labels: ['  bug '] });
  assert.equal(task.title, 'Hi');
  // SPEC 6.10: trimming removes Unicode White_Space, including NBSP and the ideographic space.
  const unicode = await createTask(t.owner, t.project.id, { title: '\u00a0\u3000Hi\u3000\u00a0', labels: ['\u3000ui\u00a0'] });
  assert.equal(unicode.title, 'Hi');
  assert.deepEqual(unicode.labels, ['ui']);
  assert.deepEqual(task.labels, ['bug']);
  expectValidation(await postTask(t, { title: '   ' }), 'title', 'too_short');
  const ws = await createWorkspace(t.owner, { name: '  Trim Ops  ' });
  assert.equal(ws.name, 'Trim Ops');
  assert.equal(ws.slug, 'trim-ops');
});

// SPEC 6.10: empty after trimming is too_short; required is only for absent fields.
test('[I1] whitespace-only strings are too_short, never required', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id);
  const blanks = ['   ', '\t\n ', '\u00a0', '\u3000', ' \u00a0\u3000\u2003 '];
  for (const blank of blanks) {
    expectValidation(await postTask(t, { title: blank }), 'title', 'too_short');
    expectValidation(await t.owner.client.post('/v1/workspaces', { name: blank }), 'name', 'too_short');
    expectValidation(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/projects`, { name: blank }), 'name', 'too_short');
    expectValidation(await t.owner.client.post(`/v1/tasks/${task.id}/comments`, { body: blank }), 'body', 'too_short');
    expectValidation(await t.owner.client.patch(`/v1/tasks/${task.id}`, { title: blank }), 'title', 'too_short');
  }
  expectValidation(await postTask(t, { labels: ['ok', '  '] }), 'labels[1]', 'too_short');
});

test('[I1] character limits count code points after normalisation', async () => {
  const t = await team();
  const emoji = await postTask(t, { title: '\u{1F600}'.repeat(200) });
  expectStatus(emoji, 201);
  assert.equal([...emoji.body.title].length, 200);
  expectValidation(await postTask(t, { title: '\u{1F600}'.repeat(201) }), 'title', 'too_long');
  const combining = await postTask(t, { title: 'é'.repeat(200) });
  expectStatus(combining, 201);
  assert.equal(combining.body.title, 'é'.repeat(200));
});

test('[I1] derived workspace slugs: case folding, hyphen runs, numeric suffixes', async () => {
  const owner = await registerUser();
  const slug = async (name: string) => (await createWorkspace(owner, { name })).slug;
  assert.equal(await slug('Acme Ops'), 'acme-ops');
  assert.equal(await slug('Acme Ops'), 'acme-ops-2');
  assert.equal(await slug('Acme Ops'), 'acme-ops-3');
  assert.equal(await slug('Ärger & Straße'), 'ärger-strasse');
  assert.equal(await slug('  Hello--World!! 2026 '), 'hello-world-2026');
  assert.equal(await slug('!!!'), 'workspace');
  assert.equal(await slug('???'), 'workspace-2');
  expectError(await owner.client.post('/v1/workspaces', { name: 'Given', slug: 'acme-ops' }), 409, 'slug_taken');
});

test('[I1] derived slugs are cut to 50 characters and re-trimmed, suffix included', async () => {
  const owner = await registerUser();
  const slug = async (name: string) => (await createWorkspace(owner, { name })).slug;
  assert.equal(await slug('a'.repeat(60)), 'a'.repeat(50));
  assert.equal(await slug('a'.repeat(60)), `${'a'.repeat(48)}-2`);
  assert.equal(await slug(`${'b'.repeat(49)} cdef`), 'b'.repeat(49));
});

test('[I1] derived project slug falls back to "project"', async () => {
  const t = await team();
  assert.equal((await createProject(t.owner, t.ws.id, { name: '***' })).slug, 'project');
  assert.equal((await createProject(t.owner, t.ws.id, { name: '###' })).slug, 'project-2');
});

test('[I2] a body over 64 KiB is 413 payload_too_large (before validation)', async () => {
  const t = await team();
  const res = await postTask(t, { title: 'Big', description: '€'.repeat(22_200) });
  expectError(res, 413, 'payload_too_large');
});

test('[I2] a 60 KB body with a valid 20,000-character description is accepted', async () => {
  const t = await team();
  const description = '€'.repeat(20_000);
  const body = JSON.stringify({ title: 'Long', description });
  assert.ok(Buffer.byteLength(body) > 60_000 && Buffer.byteLength(body) < 65_536);
  const res = await rawTask(t, body);
  expectStatus(res, 201);
  assert.equal(res.body.description, description);
});

test('[I2] exactly 65,536 bytes is not too large; 65,537 bytes is', async () => {
  const t = await team();
  const build = (size: number): string => {
    const shell = '{"title":"x","description":""}';
    const raw = `{"title":"x","description":"${'a'.repeat(size - Buffer.byteLength(shell))}"}`;
    assert.equal(Buffer.byteLength(raw), size);

    return raw;
  };
  expectValidation(await rawTask(t, build(65_536)), 'description', 'too_long');
  expectError(await rawTask(t, build(65_537)), 413, 'payload_too_large');
});

test('[I3] several invalid fields produce one 422 with every nested path', async () => {
  const t = await team();
  const res = await postTask(t, {
    title: 'Nested',
    budget: { currency: 'JPY', amount: '1.5' },
    labels: ['a', 'b', 'x'.repeat(41)],
    priority: 'high',
  });
  expectError(
    res,
    422,
    'validation_failed',
    [
      { path: 'budget.amount', code: 'too_many_decimals' },
      { path: 'labels[2]', code: 'too_long' },
      { path: 'priority', code: 'unknown_field' },
    ],
    { exactDetails: true },
  );
});

async function richTask(t: Team): Promise<Json> {
  return createTask(t.owner, t.project.id, {
    title: 'Rich',
    description: 'Something',
    labels: ['bug'],
    assignee_id: t.member.id,
    due_date: '2027-01-15',
    estimate_minutes: 30,
    budget: { currency: 'EUR', amount: '12.30' },
  });
}

function without(task: Json, ...keys: string[]): Json {
  const copy = { ...task };
  for (const k of keys) delete copy[k];

  return copy;
}

test('[I4] absent fields are kept, null clears nullable fields', async () => {
  const t = await team();
  const task = await richTask(t);
  const renamed = await t.owner.client.patch(`/v1/tasks/${task.id}`, { title: 'Renamed' });
  expectStatus(renamed, 200);
  assert.deepEqual(without(renamed.body, 'title', 'version', 'updated_at'), without(task, 'title', 'version', 'updated_at'));
  assert.equal(renamed.body.title, 'Renamed');

  const cleared = await t.owner.client.patch(`/v1/tasks/${task.id}`, { due_date: null });
  expectStatus(cleared, 200);
  assert.equal(cleared.body.due_date, null);
  assert.equal(cleared.body.description, 'Something');
  assert.equal(cleared.body.estimate_minutes, 30);

  const all = await t.owner.client.patch(`/v1/tasks/${task.id}`, { description: null, assignee_id: null, estimate_minutes: null, budget: null });
  expectStatus(all, 200);
  for (const k of ['description', 'assignee_id', 'estimate_minutes', 'budget']) assert.equal(all.body[k], null, k);
  assert.deepEqual(all.body.labels, ['bug']);
  assert.equal(all.body.title, 'Renamed');
});

test('[I4] null for a non-nullable field is 422 not_nullable', async () => {
  const t = await team();
  const task = await richTask(t);
  for (const field of ['title', 'labels', 'status']) {
    expectValidation(await t.owner.client.patch(`/v1/tasks/${task.id}`, { [field]: null }), field, 'not_nullable');
  }
  expectValidation(await t.owner.client.patch(`/v1/tasks/${task.id}`, { budget: { currency: 'USD' } }), 'budget.amount', 'required');
  assert.equal((await getOk(t.owner, `/v1/tasks/${task.id}`)).version, 1, 'rejected PATCHes change nothing');
});

test('[I4] empty PATCH bumps only version and updated_at and records changes {}', async () => {
  const t0 = await setClock('2026-07-01T09:00:00Z');
  const t = await team();
  const task = await richTask(t);
  await advance(60);
  const res = await t.owner.client.patch(`/v1/tasks/${task.id}`, {});
  expectStatus(res, 200);
  assert.equal(res.body.version, task.version + 1);
  assert.equal(res.body.updated_at, addSeconds(t0, 60));
  assert.notEqual(res.body.updated_at, task.updated_at);
  assert.deepEqual(without(res.body, 'version', 'updated_at'), without(task, 'version', 'updated_at'));
  const events = await activity(t.owner, t.ws.id);
  const latest = events.find((e) => e.target?.type === 'task' && e.target.id === task.id);
  assert.equal(latest.type, 'task.updated');
  assert.deepEqual(latest.changes, {});
});

test('[I5] 400 for unparsable input, 422 for semantic errors, 409 for conflicts', async () => {
  const t = await team();
  expectError(await t.owner.client.get(`/v1/projects/${t.project.id}/tasks`, { limit: 'abc' }), 400, 'invalid_query');
  expectError(await t.owner.client.get(`/v1/projects/${t.project.id}/tasks`, { limit: 500 }), 400, 'invalid_query');
  expectError(await rawTask(t, '{"title": '), 400, 'malformed_json');
  expectValidation(await postTask(t, { title: 'x', status: 'later' }), 'status', 'invalid_enum');
  await createProject(t.owner, t.ws.id, { name: 'Dup', slug: 'dup' });
  expectError(await t.owner.client.post(`/v1/workspaces/${t.ws.id}/projects`, { name: 'Dup 2', slug: 'dup' }), 409, 'slug_taken');
});

test('[I5] precedence: 422 before 409 version_conflict', async () => {
  const t = await team();
  const task = await createTask(t.owner, t.project.id);
  const res = await t.owner.client.patch(`/v1/tasks/${task.id}`, { status: 'later' }, { ifMatch: '"9"' });
  expectValidation(res, 'status', 'invalid_enum');
});

test('[I5] precedence: 415 before 422, 404 before 400, 403 before 422, 410 before 422, 401 before 404', async () => {
  const t = await team();
  expectError(await rawTask(t, 'title=nonsense', 'text/plain'), 415, 'unsupported_media_type');
  const missing = `/v1/tasks/${NONEXISTENT_ID}`;
  expectError(await t.viewer.client.patch(missing, { title: 'x' }), 404, 'not_found');
  expectError(await t.owner.client.request('PATCH', missing, { rawBody: '{"title":', contentType: 'application/json' }), 404, 'not_found');
  const task = await createTask(t.owner, t.project.id);
  expectError(await t.viewer.client.patch(`/v1/tasks/${task.id}`, { status: 'later' }), 403, 'forbidden');
  expectError(await anonymous().get(missing), 401, 'unauthenticated');
  await deleteOk(t.owner, `/v1/tasks/${task.id}`);
  expectError(await t.member.client.patch(`/v1/tasks/${task.id}`, { status: 'later' }), 410, 'gone');
});

test('[I6] unknown body fields are 422 unknown_field at their path', async () => {
  const t = await team();
  expectValidation(await postTask(t, { title: 'x', priority: 'high' }), 'priority', 'unknown_field');
  const task = await createTask(t.owner, t.project.id);
  expectValidation(await t.owner.client.patch(`/v1/tasks/${task.id}`, { priority: 'high' }), 'priority', 'unknown_field');
  expectValidation(await postTask(t, { title: 'x', budget: { currency: 'USD', amount: '1', extra: true } }), 'budget.extra', 'unknown_field');
  expectValidation(await anonymous().post('/v1/users', { email: uniqueEmail('u'), name: 'U', role: 'admin' }), 'role', 'unknown_field');
  expectValidation(await t.owner.client.post('/v1/workspaces', { name: 'W', plan: 'pro' }), 'plan', 'unknown_field');
  expectValidation(await t.owner.client.patch('/v1/users/me', { email: 'new@example.com' }), 'email', 'unknown_field');
  assert.equal((await getOk(t.owner, `/v1/tasks/${task.id}`)).version, 1);
});
