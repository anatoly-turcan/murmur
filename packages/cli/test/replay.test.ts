import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StoredEnvelope } from '@murmur/dev-protocol';

import { createReplay } from '../src/dev/replay.ts';
import { parseSince } from '../src/dev/since.ts';

function stored(seq: number, traceId: string, piece = 'a/b'): StoredEnvelope {
  return {
    seq,
    envelope: { id: `id-${seq}`, name: 'x.y', traceId, ts: '2026-10-24T00:00:00Z', hop: 0, payload: {} },
    meta: { internal: false, piece },
  };
}

test('the replay ring evicts the oldest entry and its index slots', () => {
  const replay = createReplay(3);
  for (const [seq, trace] of [
    [1, 'aaaa1111'],
    [2, 'aaaa2222'],
    [3, 'bbbb3333'],
    [4, 'bbbb3333'],
  ] as const) {
    replay.push(stored(seq, trace));
  }

  assert.equal(replay.oldestSeq(), 2);
  assert.deepEqual(replay.traceIds('aaaa'), ['aaaa2222']);
  assert.deepEqual(
    replay.byTrace('bbbb3333').map((s) => s.seq),
    [3, 4],
  );
  assert.deepEqual(
    replay.since(2).map((s) => s.seq),
    [3, 4],
  );
});

test('envelope pages walk backwards with nextBefore', () => {
  const replay = createReplay(10);
  for (let seq = 1; seq <= 5; seq++) {
    replay.push(stored(seq, 'cccc0000', seq % 2 === 0 ? 'even' : 'odd'));
  }

  const first = replay.page({}, 2, null);
  assert.deepEqual(
    first.items.map((s) => s.seq),
    [4, 5],
  );
  assert.equal(first.nextBefore, 4);
  const last = replay.page({}, 10, 4);
  assert.deepEqual(
    last.items.map((s) => s.seq),
    [1, 2, 3],
  );
  assert.equal(last.nextBefore, null);
  assert.deepEqual(
    replay.page({ piece: 'even' }, 10, null).items.map((s) => s.seq),
    [2, 4],
  );
});

test('since accepts a seq or a duration', () => {
  assert.deepEqual(parseSince('42'), { kind: 'seq', seq: 42 });
  assert.deepEqual(parseSince('5m'), { kind: 'age', ms: 300_000 });
  assert.equal(parseSince('soon'), null);
  assert.equal(parseSince(undefined), null);
});
