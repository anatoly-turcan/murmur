import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTestRuntime } from '@murmur/node/testing';

import { Edge } from '../fixtures/v2/edge/pieces/api/piece.ts';
import { Store } from '../fixtures/v2/edge/pieces/store/piece.ts';

interface Issue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly [param: string]: unknown;
}

interface Envelope {
  readonly error: { readonly code: string; readonly message: string; readonly details?: readonly Issue[] };
}

const JSON_TYPE = { 'content-type': 'application/json' };

function edgeRuntime() {
  return createTestRuntime({ pieces: { api: Edge, store: Store } });
}

async function errorOf(response: Response): Promise<Envelope['error']> {
  return ((await response.json()) as Envelope).error;
}

function patch(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://app${path}`, { method: 'PATCH', body, headers: { ...JSON_TYPE, ...headers } });
}

function post(path: string, body: string, headers: Record<string, string> = JSON_TYPE): Request {
  return new Request(`http://app${path}`, { method: 'POST', body, headers });
}

test('each part maps its failure to the configured status and code, zod codes and params in issues', async () => {
  await using rt = await edgeRuntime();
  const params = await rt.fetch(new Request('http://app/items/abc'));
  const query = await rt.fetch(new Request('http://app/items?limit=99'));
  const headers = await rt.fetch(patch('/items/i1', '{"title":"milk"}', { 'if-match': 'W/"3"' }));
  const body = await rt.fetch(patch('/items/i1', '{"title":"ab"}'));
  const paramsError = await errorOf(params);
  const queryError = await errorOf(query);
  const headersError = await errorOf(headers);
  const bodyError = await errorOf(body);

  assert.deepEqual([params.status, paramsError.code], [404, 'not_found']);
  assert.equal(paramsError.details?.[0]?.code, 'invalid_type');
  assert.deepEqual([query.status, queryError.code], [400, 'invalid_query']);
  assert.deepEqual(queryError.details?.[0], {
    path: ['limit'],
    code: 'too_big',
    message: 'Too big: expected number to be <=50',
    origin: 'number',
    maximum: 50,
    inclusive: true,
  });
  assert.deepEqual([headers.status, headersError.code], [400, 'invalid_header']);
  assert.deepEqual(headersError.details?.[0]?.path, ['if-match']);
  assert.equal(headersError.details?.[0]?.['format'], 'regex');
  assert.deepEqual([body.status, bodyError.code], [422, 'validation_failed']);
  assert.deepEqual(bodyError.details, [
    {
      path: ['title'],
      code: 'too_short',
      message: 'Too small: expected string to have >=3 characters',
      origin: 'string',
      minimum: 3,
      inclusive: true,
    },
  ]);
});

test('parts are read in order: a bad param answers before a bad body', async () => {
  await using rt = await edgeRuntime();
  const response = await rt.fetch(patch('/items/x1', '{"title":"ab"}'));

  assert.equal(response.status, 404);
});

test('the query is strict: unknown and repeated keys fail, array fields take repeats, strings are coerced', async () => {
  await using rt = await edgeRuntime();
  const unknown = await rt.fetch(new Request('http://app/items?colour=red'));
  const repeated = await rt.fetch(new Request('http://app/items?limit=1&limit=2'));
  const listed = await rt.fetch(new Request('http://app/items?tag=a&tag=b&limit=5'));
  const unknownError = await errorOf(unknown);
  const repeatedError = await errorOf(repeated);
  const [item] = (await listed.json()) as { title: string }[];

  assert.equal(unknown.status, 400);
  assert.equal(unknownError.details?.[0]?.code, 'unrecognized_keys');
  assert.deepEqual(unknownError.details?.[0]?.['keys'], ['colour']);
  assert.equal(repeated.status, 400);
  assert.deepEqual(repeatedError.details?.[0]?.path, ['limit']);
  assert.equal(repeatedError.details?.[0]?.code, 'repeated_key');
  assert.equal(listed.status, 200);
  assert.deepEqual(JSON.parse(item?.title ?? 'null'), { tag: ['a', 'b'], limit: 5 });
});

test('the body: wrong media type 415, malformed JSON 400, a non-object one root issue, empty is {}', async () => {
  await using rt = await edgeRuntime();
  const media = await rt.fetch(post('/echo', 'a=1', { 'content-type': 'text/plain' }));
  const malformed = await rt.fetch(post('/echo', '{"a":'));
  const array = await rt.fetch(post('/echo', '[1]'));
  const empty = await rt.fetch(post('/echo', '', {}));
  const mediaError = await errorOf(media);
  const malformedError = await errorOf(malformed);
  const arrayError = await errorOf(array);

  assert.deepEqual([media.status, mediaError.code], [415, 'unsupported_media_type']);
  assert.deepEqual([malformed.status, malformedError.code], [400, 'malformed_json']);
  assert.deepEqual([array.status, arrayError.code], [422, 'validation_failed']);
  assert.equal(arrayError.details?.length, 1);
  assert.deepEqual(arrayError.details?.[0]?.path, []);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), {});
});

test('a missing optional header reads as null; a header key that is not lower-case is refused', async () => {
  await using rt = await edgeRuntime();
  const absent = await rt.fetch(new Request('http://app/headers'));
  const present = await rt.fetch(new Request('http://app/headers', { headers: { 'x-opt': 'a' } }));

  const mixed = await rt.fetch(
    new Request('http://app/headers/mixed-case', { headers: { 'if-match': '"1"' } }),
  );

  assert.deepEqual(await absent.json(), { opt: null });
  assert.deepEqual(await present.json(), { opt: 'a' });
  assert.equal(mixed.status, 500);
});

test('req.reply renders a Rejection, null, undefined and an object', async () => {
  await using rt = await edgeRuntime();
  const rejection = await rt.fetch(new Request('http://app/outcomes/rejection'));
  const nothing = await rt.fetch(new Request('http://app/outcomes/null'));
  const none = await rt.fetch(new Request('http://app/outcomes/none'));
  const object = await rt.fetch(new Request('http://app/outcomes/object'));

  assert.equal(rejection.status, 403);
  assert.equal(rejection.headers.get('x-a'), '1');

  assert.deepEqual(await rejection.json(), {
    error: { code: 'admins_only', message: 'Only admins may look.' },
  });

  assert.deepEqual([nothing.status, (await errorOf(nothing)).code], [404, 'not_found']);
  assert.equal(none.status, 204);
  assert.equal(await none.text(), '');
  assert.equal(object.status, 202);
  assert.equal(object.headers.get('x-a'), '1');
  assert.deepEqual(await object.json(), { ok: true });
});

test('a serve method may return null (404) or a Rejection directly', async () => {
  await using rt = await edgeRuntime();
  const nothing = await rt.fetch(new Request('http://app/outcomes/direct-null'));
  const gone = await rt.fetch(new Request('http://app/outcomes/direct-rejection'));

  assert.equal(nothing.status, 404);
  assert.deepEqual([gone.status, (await errorOf(gone)).code], [410, 'gone']);
});

test('an If-None-Match hit (weak comparison) answers 304 with the etag; a miss answers 200', async () => {
  await using rt = await edgeRuntime();
  const first = await rt.fetch(new Request('http://app/items/7'));
  const etag = first.headers.get('etag') ?? '';
  const hit = await rt.fetch(new Request('http://app/items/7', { headers: { 'if-none-match': etag } }));
  const miss = await rt.fetch(new Request('http://app/items/7', { headers: { 'if-none-match': '"1"' } }));

  const weak = await rt.fetch(
    new Request('http://app/items/7', { headers: { 'if-none-match': `"1", W/${etag}` } }),
  );

  const missing = await rt.fetch(new Request('http://app/items/404'));

  assert.equal(first.status, 200);
  assert.equal(etag, '"3"');
  assert.equal(first.headers.get('x-item'), 'yes');
  assert.equal(hit.status, 304);
  assert.equal(hit.headers.get('etag'), '"3"');
  assert.equal(await hit.text(), '');
  assert.equal(miss.status, 200);
  assert.equal(weak.status, 304);
  assert.equal(missing.status, 404);
});

test('a domain Rejection reaches the client through the envelope from a method and from a shorthand route', async () => {
  await using rt = await edgeRuntime();
  const stale = await rt.fetch(patch('/items/i1', '{"title":"milk"}', { 'if-match': '"2"' }));
  const updated = await rt.fetch(patch('/items/i1', '{"title":"milk"}', { 'if-match': '"3"' }));
  const locked = await rt.fetch(new Request('http://app/items/locked', { method: 'DELETE' }));
  const removed = await rt.fetch(new Request('http://app/items/i1', { method: 'DELETE' }));

  assert.equal(stale.status, 409);

  assert.deepEqual(await stale.json(), {
    error: {
      code: 'version_conflict',
      message: 'The object changed since you read it.',
      details: [{ path: 'if-match', code: 'stale', current: 3 }],
    },
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.headers.get('etag'), '"4"');
  assert.equal(locked.status, 423);
  assert.equal(locked.headers.get('retry-after'), '5');
  assert.deepEqual(await locked.json(), { error: { code: 'locked', message: 'The object is locked.' } });
  assert.equal(removed.status, 204);
});

test('a thrown domain error is still 502', async () => {
  await using rt = await edgeRuntime();
  const response = await rt.fetch(new Request('http://app/items/i1/fail', { method: 'POST' }));

  assert.equal(response.status, 502);
  assert.equal((await errorOf(response)).code, 'upstream_failed');
});
