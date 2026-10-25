import assert from 'node:assert/strict';
import { test } from 'node:test';

import { systemClock } from 'murmur';
import { fakeClock, fakeIds, fakeLog } from 'murmur/testing';

test('fakeIds issues sequential uuids and 8-char shorts', () => {
  const ids = fakeIds();
  const a = ids.uuid();
  const b = ids.short();
  const c = ids.uuid();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(b, /^[a-z0-9]{8}$/);
  assert.notEqual(a, c);
  assert.deepEqual(ids.issued, [a, b, c]);
});

test('fakeClock starts frozen at the given instant, advances, and sleep advances instead of waiting', async () => {
  const clock = fakeClock('2026-10-24T10:00:00Z');
  assert.equal(clock.now().toString(), '2026-10-24T10:00:00Z');
  await clock.advance(1500);
  assert.equal(clock.now().toString(), '2026-10-24T10:00:01.5Z');
  await clock.sleep(60_000);
  assert.equal(clock.now().toString(), '2026-10-24T10:01:01.5Z');
  await clock.freeze('2027-01-01T00:00:00Z');
  assert.equal(clock.zonedNow('Europe/Athens').hour, 2);
  assert.equal(clock.zonedNow().timeZoneId, 'UTC');
});

test('fakeClock.clear returns to system time and a later freeze holds again', async () => {
  const clock = fakeClock('2020-01-01T00:00:00Z');
  await clock.clear();
  const live = clock.now().epochMilliseconds;
  assert.ok(Math.abs(live - Date.now()) < 5_000, `expected system time, got ${clock.now().toString()}`);
  await clock.freeze(Temporal.Instant.from('2030-01-01T00:00:00Z'));
  assert.equal(clock.now().toString(), '2030-01-01T00:00:00Z');
});

test('the system clock refuses freeze, advance and clear and names the yaml switch', async () => {
  const refusal = /clock\.freeze needs capabilities\.clock\.overridable: true in murmur\.yaml/;
  await assert.rejects(systemClock.freeze('2030-01-01T00:00:00Z'), refusal);
  await assert.rejects(systemClock.advance(1), /clock\.advance needs capabilities\.clock\.overridable: true/);
  await assert.rejects(systemClock.clear(), /clock\.clear needs capabilities\.clock\.overridable: true/);
});

test('fakeLog records every level and child() merges fields into the same records', () => {
  const log = fakeLog();
  log.info('a');
  log.child({ piece: 'x' }).warn('b', { n: 1 });
  log.error('c', { error: new Error('boom') });
  assert.deepEqual(
    log.records.map((r) => [r.level, r.message, r.data && Object.keys(r.data)]),
    [
      ['info', 'a', undefined],
      ['warn', 'b', ['piece', 'n']],
      ['error', 'c', ['error']],
    ],
  );
});
