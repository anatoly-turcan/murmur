import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/http/errors.ts';
import { decodeCursor, encodeCursor, endpointBinding, filterHash } from '../src/http/pagination.ts';
import { LIST_QUERY, parseQuery, q } from '../src/http/query.ts';
import { createRouter } from '../src/http/router.ts';
import type { Route } from '../src/http/types.ts';
import { id, int, list, nullable, str, validateBody } from '../src/http/validate.ts';
import { ok } from '../src/http/respond.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }

  return 'none';
}

const handle = () => ok({});
const routes = [
  { method: 'GET', path: '/v1/workspaces/:id', handle },
  { method: 'POST', path: '/v1/workspaces/:id/projects', handle },
  { method: 'GET', path: '/v1/users/me', handle },
  { method: 'GET', path: '/v1/users/:id', handle },
] as Route[];

const UUID = '0190a5d7-1c2b-7def-8a01-23456789abcd';

test('router matches UUID params, flags legacy integers and prefers literals', () => {
  const router = createRouter(routes);
  const hit = router.match('GET', `/v1/workspaces/${UUID.toUpperCase()}`);
  assert.equal(hit.kind, 'route');
  if (hit.kind === 'route') assert.deepEqual([hit.params, hit.legacy], [{ id: UUID }, []]);
  const legacy = router.match('GET', '/v1/workspaces/12');
  if (legacy.kind === 'route') assert.deepEqual(legacy.legacy, [{ param: 'id', kind: 'workspace', legacyId: 12 }]);
  const me = router.match('GET', '/v1/users/me');
  assert.equal(me.kind === 'route' && me.route.path, '/v1/users/me');
  assert.equal(router.match('GET', '/v1/workspaces/012').kind, 'none');
  assert.equal(router.match('GET', '/v1/workspaces/abc').kind, 'none');
});

test('router reports allowed methods for a known path', () => {
  const miss = createRouter(routes).match('DELETE', '/v1/workspaces/3/projects');
  assert.deepEqual(miss, { kind: 'method_not_allowed', allowed: ['POST'] });
});

test('cursor round-trips and rejects tampering or a foreign endpoint', () => {
  const binding = endpointBinding({ method: 'GET', path: '/v1/workspaces/:id/members' }, { id: '1' });
  const hash = filterHash({ limit: 5, role: 'admin' });
  const cursor = encodeCursor('secret', { e: binding, f: hash, k: [10, 'x'] });
  assert.deepEqual(decodeCursor('secret', cursor, binding, hash), [10, 'x']);
  assert.equal(code(() => decodeCursor('other', cursor, binding, hash)), 'invalid_cursor');
  assert.equal(code(() => decodeCursor('secret', `${cursor}x`, binding, hash)), 'invalid_cursor');
  assert.equal(code(() => decodeCursor('secret', cursor, `${binding}2`, hash)), 'cursor_mismatched');
  assert.equal(code(() => decodeCursor('secret', cursor, binding, filterHash({ role: 'viewer' }))), 'invalid_cursor');
});

test('filterHash ignores limit and cursor', () => {
  assert.equal(filterHash({ limit: 1, cursor: 'a', q: 'x' }), filterHash({ limit: 50, q: 'x' }));
});

test('parseQuery rejects unknown, repeated and out-of-range parameters', () => {
  const spec = { ...LIST_QUERY, status: q.enumList(['open', 'done']) };
  assert.equal(parseQuery(new URLSearchParams(''), spec).limit, 20);
  assert.equal(code(() => parseQuery(new URLSearchParams('limit=0'), spec)), 'invalid_query');
  assert.equal(code(() => parseQuery(new URLSearchParams('limit=101'), spec)), 'invalid_query');
  assert.equal(code(() => parseQuery(new URLSearchParams('colour=blue'), spec)), 'invalid_query');
  assert.equal(code(() => parseQuery(new URLSearchParams('limit=1&limit=2'), spec)), 'invalid_query');
});

test('validateBody reports unknown, required, null and type problems', () => {
  const specs = { name: str({ max: 5 }), size: nullable(int({ min: 1, max: 9 })), tags: list(str({ max: 3 }), { max: 2 }) };
  const good = validateBody({ name: ' ab ', size: null, tags: ['x'] }, specs, { required: ['name'] });
  assert.deepEqual(good.details, []);
  assert.equal(good.values.size, null);
  const bad = validateBody({ size: 0, extra: 1, tags: [null] }, specs, { required: ['name'] });
  assert.deepEqual(bad.details.map((d) => [d.path, d.code]).sort(), [
    ['extra', 'unknown_field'],
    ['name', 'required'],
    ['size', 'out_of_range'],
    ['tags[0]', 'invalid_type'],
  ]);
});

test('a body id must be a UUID; an integer is a legacy id', () => {
  const specs = { assignee_id: id() };
  assert.deepEqual(validateBody({ assignee_id: 7 }, specs).details, [{ path: 'assignee_id', code: 'legacy_id_not_allowed' }]);
  assert.deepEqual(validateBody({ assignee_id: 'x' }, specs).details, [{ path: 'assignee_id', code: 'invalid_format' }]);
  assert.deepEqual(validateBody({ assignee_id: UUID.toUpperCase() }, specs).values, { assignee_id: UUID });
});
