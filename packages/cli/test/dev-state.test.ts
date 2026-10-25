import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { StoredEnvelope } from '@murmur/dev-protocol';
import type { Envelope } from 'murmur';

import { withEnvFiles } from '../src/dev/env-files.ts';
import { createLive } from '../src/dev/live.ts';
import { createTraceWriter } from '../src/dev/trace-store.ts';

function sys(name: string, payload: unknown): Envelope {
  return {
    id: crypto.randomUUID(),
    name: `$sys.${name}`,
    traceId: 't',
    ts: '2026-10-24T00:00:00Z',
    hop: 0,
    payload,
  };
}

function userStored(traceId: string): StoredEnvelope {
  return {
    seq: 1,
    envelope: { id: 'e', name: 'todos.created', traceId, ts: '2026-10-24T00:00:00Z', hop: 0, payload: {} },
    meta: { internal: false, piece: 'todos/create' },
  };
}

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-traces-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

test('trace writer close flushes traces still inside the quiet window', (t) => {
  const dir = tempDir(t);
  const stored = userStored('abc');
  const writer = createTraceWriter(dir, () => [stored]);
  writer.track(stored);
  writer.close();

  assert.equal(existsSync(join(dir, 'abc.ndjson')), true);
});

test('trace writer prunes the oldest trace files beyond the cap', (t) => {
  const dir = tempDir(t);
  for (const [name, age] of [
    ['old', 200],
    ['older', 300],
  ] as const) {
    writeFileSync(join(dir, `${name}.ndjson`), '\n');
    utimesSync(join(dir, `${name}.ndjson`), Date.now() / 1000 - age, Date.now() / 1000 - age);
  }

  const stored = userStored('new');
  const writer = createTraceWriter(dir, () => [stored], 2);
  writer.track(stored);
  writer.close();

  assert.deepEqual(readdirSync(dir).toSorted(), ['new.ndjson', 'old.ndjson']);
});

test('a child exit clears in-flight counters but keeps session totals', () => {
  const live = createLive();
  live.apply(sys('delivery.received', { piece: 'slow' }));
  live.apply(sys('delivery.received', { piece: 'slow' }));
  live.apply(sys('delivery.acked', { piece: 'slow', at: '2026-10-24T00:00:01Z', durationMs: 5 }));
  live.childExited();
  const counters = live.piece('slow')?.counters;

  assert.equal(counters?.inflight, 0);
  assert.equal(counters?.received, 2);
  assert.equal(counters?.acked, 1);
});

test('env files feed the analysis env without overriding the process env', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, '.env'), 'A=file\nB=file\nC=env\n');
  writeFileSync(join(dir, '.env.local'), 'B=local\n');
  const env = withEnvFiles(dir, ['.env', '.env.local', '.env.missing'], { C: 'process' });

  assert.deepEqual({ A: env['A'], B: env['B'], C: env['C'] }, { A: 'file', B: 'local', C: 'process' });
});
