import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testPiece } from '@murmur/node/testing';

import type { WebRequest } from '#capabilities/web';
import { TodoCompleted, TodoCreated, TodoRemoved } from '#contracts/todos';

import { TodosFeed } from './piece.ts';

const ada = { userId: 'ada', roles: [], remaining: 9 };

async function readUntil(
  reader: ReadableStreamDefaultReader<string>,
  marker: string,
  seen = '',
): Promise<string> {
  if (seen.includes(marker)) {
    return seen;
  }

  const { value, done } = await reader.read();
  if (done) {
    return seen;
  }

  return readUntil(reader, marker, seen + value);
}

test('GET /events/todos streams hello, then every todo event as an SSE frame', async () => {
  await using t = await testPiece(TodosFeed, { auth: ada });
  const client = new AbortController();
  const response = await t.fetch(new Request('http://app/events/todos', { signal: client.signal }));
  const reader = (response.body ?? new ReadableStream()).pipeThrough(new TextDecoderStream()).getReader();
  const hello = await readUntil(reader, '\n\n');
  await t.deliver(TodoCreated, { id: 't1', title: 'milk' });
  await t.deliver(TodoCompleted, { id: 't1' });
  await t.deliver(TodoRemoved, { id: 't1' });
  const frames = await readUntil(reader, 'event: removed');
  client.abort();

  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(hello, 'event: hello\ndata: {"user":"ada"}\n\n');
  assert.match(frames, /event: created\ndata: \{"id":"t1","title":"milk"\}\n\n/);
  assert.match(frames, /event: completed\ndata: \{"id":"t1"\}\n\n/);
  assert.match(frames, /event: removed\ndata: \{"id":"t1"\}\n\n/);
});

test('an event with no client connected, or after the client left, succeeds', async () => {
  await using t = await testPiece(TodosFeed, { auth: ada });
  await t.deliver(TodoCreated, { id: 't1', title: 'milk' });
  const client = new AbortController();
  const response = await t.fetch(new Request('http://app/events/todos', { signal: client.signal }));
  await response.body?.cancel();
  client.abort();

  await assert.doesNotReject(t.deliver(TodoCreated, { id: 't2', title: 'bread' }));
});

test('a frame for a client whose stream closed before its abort listener ran is dropped, not thrown', async () => {
  await using t = await testPiece(TodosFeed, { auth: ada });
  const neverAborted = { auth: ada, signal: new AbortController().signal } as unknown as WebRequest;
  const response = t.piece.stream(neverAborted);
  await response.body?.cancel();
  await assert.doesNotReject(t.deliver(TodoCreated, { id: 't1', title: 'milk' }));
  await assert.doesNotReject(t.deliver(TodoRemoved, { id: 't1' }));
});
