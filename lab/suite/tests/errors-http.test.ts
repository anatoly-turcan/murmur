import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectError, expectStatus, expectValidation } from '../lib/assert.ts';
import { anonymous, type Json } from '../lib/client.ts';
import { ENDPOINTS, fill, fillBody, label, objectWorld, type Endpoint } from '../lib/endpoints.ts';
import { createTask, uniqueEmail, uniqueName, type User } from '../lib/fixtures.ts';
import type { Id } from '../lib/ids.ts';
import { freshDatabaseOnce, lazy } from '../lib/suite.ts';

freshDatabaseOnce();

const world = lazy(objectWorld);

interface BodyTarget {
  name: string;
  send: (opts: { body?: Json; rawBody?: string; contentType?: string | null }) => Promise<import('../lib/client.ts').ApiResponse>;
  validBody: () => Promise<Json>;
}

function catalogTarget(e: Endpoint): BodyTarget {
  return {
    name: label(e),
    validBody: async () => fillBody(e.body, (await world()).owner),
    send: async (opts) => {
      const { ids } = await world();
      const actor = await versionedActor(e.path);

      return actor.client.request(e.method, fill(e.path, ids), opts);
    },
  };
}

const registerTarget: BodyTarget = {
  name: 'POST /v1/users',
  validBody: async () => ({ email: uniqueEmail('http'), name: 'Http' }),
  send: (opts) => anonymous().request('POST', '/v1/users', opts),
};

const BODY_TARGETS: BodyTarget[] = [
  registerTarget,
  ...ENDPOINTS.filter((e) => (e.method === 'POST' || e.method === 'PATCH') && e.body !== undefined).map(catalogTarget),
];

for (const target of BODY_TARGETS) {
  test(`[ERR] ${target.name} → 415 unsupported_media_type`, async () => {
    const rawBody = JSON.stringify(await target.validBody());
    expectError(await target.send({ rawBody, contentType: 'text/plain' }), 415, 'unsupported_media_type');
  });

  test(`[ERR] ${target.name} → 400 malformed_json`, async () => {
    expectError(await target.send({ rawBody: '{"name": ', contentType: 'application/json' }), 400, 'malformed_json');
  });

  test(`[ERR] ${target.name} → 422 invalid_type (JSON array body)`, async () => {
    expectError(await target.send({ rawBody: '[]', contentType: 'application/json' }), 422, 'validation_failed', { path: '', code: 'invalid_type' });
  });

  test(`[ERR] ${target.name} → 422 unknown_field`, async () => {
    const body = { ...(await target.validBody()), zz_unknown: 1 };
    expectValidation(await target.send({ body }), 'zz_unknown', 'unknown_field');
  });

  test(`[ERR] ${target.name} → 413 payload_too_large`, async () => {
    const rawBody = JSON.stringify({ ...(await target.validBody()), zz_pad: 'x'.repeat(70 * 1024) });
    expectError(await target.send({ rawBody, contentType: 'application/json' }), 413, 'payload_too_large');
  });
}

for (const [what, raw] of [['string', '"hello"'], ['number', '42'], ['null', 'null']]) {
  test(`[ERR] POST /v1/workspaces → 422 invalid_type (JSON ${what} body)`, async () => {
    const { owner } = await world();
    const res = await owner.client.request('POST', '/v1/workspaces', { rawBody: raw, contentType: 'application/json' });
    expectError(res, 422, 'validation_failed', { path: '', code: 'invalid_type' });
  });
}

test('[ERR] POST /v1/workspaces → 201 with application/json; charset=utf-8', async () => {
  const { owner } = await world();
  const name = uniqueName('Charset');
  const res = await owner.client.request('POST', '/v1/workspaces', {
    rawBody: JSON.stringify({ name }),
    contentType: 'application/json; charset=utf-8',
  });
  expectStatus(res, 201);
  assert.equal(res.body.name, name);
});

test('[ERR] POST /v1/tasks/{id}/claim → 200 without body or Content-Type', async () => {
  const { owner, ids } = await world();
  const task = await createTask(owner, ids.project);
  const res = await owner.client.request('POST', `/v1/tasks/${task.id}/claim`);
  expectStatus(res, 200);
  assert.equal(res.body.assignee_id, owner.id);
});

const NOT_ALLOWED: [string, string][] = [
  ['PUT', '/v1/tasks/{task}'],
  ['POST', '/v1/tasks/{task}'],
  ['DELETE', '/v1/workspaces'],
  ['PUT', '/v1/users/me'],
  ['PATCH', '/v1/workspaces/{ws}/members'],
  ['DELETE', '/v1/projects/{project}/summary'],
  ['PUT', '/v1/comments/{comment}'],
];

for (const [method, path] of NOT_ALLOWED) {
  test(`[ERR] ${method} ${path.replace(/\{\w+\}/g, '{id}')} → 405 method_not_allowed`, async () => {
    const { owner, ids } = await world();
    expectError(await owner.client.request(method, fill(path, ids)), 405, 'method_not_allowed');
  });
}

const LISTS = ENDPOINTS.filter((e) =>
  e.method === 'GET' &&
  (/\/(members|projects|tasks|activity|search|webhooks|comments|deliveries|api-keys)(\?.*)?$/.test(e.path) || e.path === '/v1/workspaces'),
);

async function listAs(e: Endpoint, query: Record<string, string>): Promise<import('../lib/client.ts').ApiResponse> {
  const { owner, ids } = await world();

  return owner.client.get(fill(e.path, ids), query);
}

for (const e of LISTS) {
  test(`[ERR] ${label(e)} → 400 invalid_query (limit=abc, 0, 101)`, async () => {
    for (const limit of ['abc', '0', '101', '-1', '1.5']) expectError(await listAs(e, { limit }), 400, 'invalid_query');
  });

  test(`[ERR] ${label(e)} → 400 invalid_query (unknown parameter)`, async () => {
    expectError(await listAs(e, { colour: 'blue' }), 400, 'invalid_query');
  });

  test(`[ERR] ${label(e)} → 400 invalid_cursor (undecodable cursor)`, async () => {
    expectError(await listAs(e, { cursor: 'not-a-real-cursor-%%%' }), 400, 'invalid_cursor');
  });

  test(`[ERR] ${label(e)} → 400 cursor_mismatched (cursor from another list)`, async () => {
    const { owner, ids } = await world();
    const source = e.path.endsWith('/members') ? `/v1/workspaces/${ids.ws}/activity` : `/v1/workspaces/${ids.ws}/members`;
    const page = await owner.client.get(source, { limit: 1 });
    expectStatus(page, 200);
    assert.equal(typeof page.body.next_cursor, 'string', `${source} must yield a cursor`);
    const query: Record<string, string> = { cursor: page.body.next_cursor };
    if (e.path.includes('?q=')) query.q = 'login';
    expectError(await owner.client.get(fill(e.path.replace(/\?.*$/, ''), ids), query), 400, 'cursor_mismatched');
  });
}

const VERSIONED: [string, (ids: Record<string, Id>) => string, Json][] = [
  ['/v1/workspaces/{id}', (ids) => `/v1/workspaces/${ids.ws}`, { name: 'Renamed' }],
  ['/v1/projects/{id}', (ids) => `/v1/projects/${ids.project}`, { name: 'Renamed' }],
  ['/v1/tasks/{id}', (ids) => `/v1/tasks/${ids.task}`, { title: 'Renamed' }],
  ['/v1/comments/{id}', (ids) => `/v1/comments/${ids.comment}`, { body: 'Renamed' }],
];

async function versionedActor(path: string): Promise<User> {
  const w = await world();

  return path.startsWith('/v1/comments') ? w.member : w.owner;
}

for (const [template, pathOf, body] of VERSIONED) {
  test(`[ERR] PATCH ${template} → 400 invalid_header (malformed If-Match)`, async () => {
    const { ids } = await world();
    const actor = await versionedActor(template);
    for (const ifMatch of ['1', '"1', 'version-1', 'W/"1"', '*', '"1", "2"']) {
      expectError(await actor.client.patch(pathOf(ids), body, { ifMatch }), 400, 'invalid_header');
    }
  });

  test(`[ERR] DELETE ${template} → 400 invalid_header (malformed If-Match)`, async () => {
    const { ids } = await world();
    const actor = await versionedActor(template);
    const results = [];
    for (const ifMatch of ['1', 'W/"1"', '*']) results.push(await actor.client.delete(pathOf(ids), { ifMatch }));
    const after = await actor.client.get(pathOf(ids));
    if (after.status === 410) await actor.client.post(`${pathOf(ids)}/restore`);
    for (const res of results) expectError(res, 400, 'invalid_header');
    expectStatus(after, 200, 'object must not be deleted by a rejected request');
  });
}

for (const [what, key] of [['256 characters', 'k'.repeat(256)], ['empty', ''], ['non-ASCII', 'café']]) {
  test(`[ERR] POST /v1/workspaces → 400 invalid_header (Idempotency-Key ${what})`, async () => {
    const { owner } = await world();
    expectError(await owner.client.post('/v1/workspaces', { name: uniqueName('Idem') }, { idempotencyKey: key }), 400, 'invalid_header');
  });
}
