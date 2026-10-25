import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyze } from '../src/analysis/analyze.ts';
import type { Catalog } from '../src/analysis/types.ts';
import { createLive } from '../src/dev/live.ts';
import { toCatalog, toSnapshot } from '../src/dev/snapshot.ts';
import { edge, piece, v2Copy, v2Fixture } from './v2-helpers.ts';

test('the dev snapshot carries routes, piece kinds, class names and contract kinds of a v2 app', async () => {
  const { catalog } = await analyze(v2Fixture, {});
  const snapshot = toSnapshot({ root: v2Fixture, catalog, live: createLive(), lastSeq: 0 });
  const rest = snapshot.pieces.find((piece) => piece.name === 'api/rest');
  const guard = snapshot.contracts.find((contract) => contract.name === 'auth.Authenticate');

  assert.deepEqual([rest?.className, rest?.kind, rest?.serves?.length], ['RestApi', 'edge', 6]);
  assert.ok(rest?.requests?.includes('todos.CreateTodo'));
  assert.deepEqual(
    [guard?.kind, guard?.className, guard?.requesters],
    ['guard', 'Authenticate', ['(web defaults)']],
  );
  assert.deepEqual(
    snapshot.routes?.find((route) => route.key === 'GET /stats'),
    {
      transport: 'http',
      token: 'web',
      key: 'GET /stats',
      piece: 'api/rest',
      contract: 'stats.GetStats',
      guards: ['auth.RateLimit'],
    },
  );
});

test('a contract lists event emitters and requesters apart, the same as the static catalog', async () => {
  const { catalog } = await analyze(v2Fixture, {});
  const snapshot = toSnapshot({ root: v2Fixture, catalog, live: createLive(), lastSeq: 0 });
  const stats = snapshot.contracts.find((contract) => contract.name === 'stats.GetStats');
  const created = snapshot.contracts.find((contract) => contract.name === 'todos.TodoCreated');

  assert.deepEqual([stats?.emitters, stats?.requesters], [[], ['api/rest']]);
  assert.deepEqual(created?.emitters, ['todos']);
  assert.deepEqual(
    snapshot.contracts.map(({ name, emitters, requesters }) => ({ name, emitters, requesters })),
    catalog.contracts.map(({ name, emitters, requesters }) => ({ name, emitters, requesters })),
  );
});

test('a route error reaches the dev catalog as a warning on the route with both pieces', async () => {
  using app = v2Copy(
    piece(
      'api/dup',
      edge(
        'Dup',
        ["import { ListTodos } from '#contracts/todos'"],
        [],
        ["@Serve(web.get('/todos'), ListTodos)"],
      ).replace(', { type WebRequest }', ''),
    ),
  );
  const { catalog } = await analyze(app.root, {});
  const warnings = toCatalog(catalog, createLive()).warnings;
  const [conflict, ...others] = warnings.filter((warning) => warning.code === 'binding-conflict');

  assert.equal(others.length, 0);
  assert.equal(conflict?.subject, 'GET /todos');
  assert.deepEqual(conflict?.pieces.toSorted(), ['api/dup', 'api/rest']);
  assert.match(conflict?.message ?? '', /GET \/todos/);
});

test('only route codes of the static errors become dev warnings', async () => {
  const { catalog } = await analyze(v2Fixture, {});
  const broken: Catalog = {
    ...catalog,
    errors: [
      ...catalog.errors,
      { code: 'piece-id', message: 'not a route problem', file: 'pieces/Bad/piece.ts' },
    ],
  };
  const warnings = toCatalog(broken, createLive()).warnings;

  assert.equal(
    warnings.some((warning) => warning.subject === 'pieces/Bad/piece.ts'),
    false,
  );
});
