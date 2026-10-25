import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindingConflicts, routeShadows, type Binding } from 'murmur';

function http(key: string): Binding {
  return { transport: 'http', key };
}

function conflicts(a: string, b: string): boolean {
  const found = bindingConflicts([
    { piece: 'api/rest', binding: http(a) },
    { piece: 'legacy/shadow', binding: http(b) },
  ]);

  return found.length > 0;
}

test('bindings that normalise to one key conflict', () => {
  assert.equal(conflicts('GET /todos/:id', 'GET /todos/:slug'), true);
  assert.equal(conflicts('POST /todos', 'POST /todos'), true);
  assert.equal(conflicts('GET /todos/:id/', 'GET /todos/:other'), true);
});

test('a * method conflicts with every method on the same path', () => {
  assert.equal(conflicts('* /todos/:id', 'GET /todos/:id'), true);
  assert.equal(conflicts('DELETE /todos/:id', '* /todos/:key'), true);
});

test('a /*rest wildcard conflicts with every longer path under its prefix', () => {
  assert.equal(conflicts('GET /files/*rest', 'GET /files/:bucket'), true);
  assert.equal(conflicts('GET /files/:bucket/x', 'GET /files/*rest'), true);
  assert.equal(conflicts('GET /files/*rest', 'GET /files/a/*rest'), true);
  assert.equal(conflicts('GET /files/*rest', 'GET /files'), false);
  assert.equal(conflicts('GET /files/*rest', 'GET /other/x'), false);
});

test('different paths, methods or transports do not conflict', () => {
  assert.equal(conflicts('GET /todos/:id', 'GET /todos/archive'), false);
  assert.equal(conflicts('GET /todos/:id', 'DELETE /todos/:id'), false);
  assert.equal(conflicts('GET /todos', 'GET /todos/:id'), false);

  const found = bindingConflicts([
    { piece: 'a', binding: http('GET /todos') },
    { piece: 'b', binding: { transport: 'ws', key: 'GET /todos' } },
  ]);
  assert.deepEqual(found, []);
});

test('a conflict names both pieces', () => {
  const [exact] = bindingConflicts([
    { piece: 'api/rest', binding: http('POST /todos') },
    { piece: 'legacy/shadow', binding: http('POST /todos') },
  ]);
  const [overlap] = bindingConflicts([
    { piece: 'api/rest', binding: http('GET /todos/:id') },
    { piece: 'legacy/shadow', binding: http('GET /todos/:slug') },
  ]);

  assert.equal(exact?.message, 'route POST /todos is served by both api/rest and legacy/shadow');
  assert.equal(overlap?.message, 'route GET /todos/:id (api/rest) overlaps GET /todos/:slug (legacy/shadow)');
  assert.equal(overlap?.first.piece, 'api/rest');
  assert.equal(overlap?.second.piece, 'legacy/shadow');
});

test('bindingConflicts reports every conflicting pair once', () => {
  const found = bindingConflicts([
    { piece: 'a', binding: http('GET /x/:id') },
    { piece: 'b', binding: http('GET /x/:key') },
    { piece: 'c', binding: http('* /x/:any') },
    { piece: 'd', binding: http('GET /y') },
  ]);

  assert.deepEqual(
    found.map((conflict) => `${conflict.first.piece}-${conflict.second.piece}`),
    ['a-b', 'a-c', 'b-c'],
  );
});

test('a static route of one piece under another piece’s :param is shadowed; the same piece may do it', () => {
  const [shadow] = routeShadows([
    { piece: 'api/rest', binding: http('GET /todos/:id') },
    { piece: 'api/feed', binding: http('GET /todos/events') },
  ]);
  const samePiece = routeShadows([
    { piece: 'api/rest', binding: http('GET /todos/:id') },
    { piece: 'api/rest', binding: http('GET /todos/archive') },
  ]);
  const unrelated = routeShadows([
    { piece: 'api/rest', binding: http('GET /todos/:id') },
    { piece: 'api/feed', binding: http('GET /events/todos') },
    { piece: 'api/admin', binding: http('POST /todos/events') },
  ]);

  assert.equal(shadow?.first.piece, 'api/feed');
  assert.match(
    shadow?.message ?? '',
    /GET \/todos\/events \(api\/feed\) sits under GET \/todos\/:id \(api\/rest\)/,
  );
  assert.deepEqual(samePiece, []);
  assert.deepEqual(unrelated, []);
});
