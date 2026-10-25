import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BootFailedError, createRuntime, type BootReport } from '@murmur/node';
import { sqlite } from '@murmur/node/capabilities';
import type { Envelope } from 'murmur';

import { CreateTodo, TodoCreated } from '../fixtures/v2/app/contracts/todos.ts';
import { CountEffects, JobRequested } from '../fixtures/v2/storage/contracts/storage.ts';
import { fixture, memoryApp, named, payloadOf, until } from '../helpers.ts';

const env = { MURMUR_LOG_LEVEL: 'info' };

function bootApp(tapped: Envelope[] = []) {
  return createRuntime({ root: fixture('v2/app'), env, signals: false, tap: (e) => tapped.push(e) });
}

async function bootReportOf(promise: Promise<unknown>): Promise<BootReport> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  assert.ok(error instanceof BootFailedError, `expected BootFailedError, got ${String(error)}`);

  return error.report;
}

function storageRuntime(tapped: Envelope[]) {
  const { app } = memoryApp('storage');

  return createRuntime({
    root: fixture('v2/storage'),
    app,
    env,
    signals: false,
    policy: { retry: { maxAttempts: 5, baseMs: 1, maxMs: 5, jitter: 0 } },
    tap: (e) => tapped.push(e),
  });
}

test('piece ids equal folder paths; parent, depth and title come from the folders and context.md', async () => {
  await using runtime = await bootApp();
  const invoice = runtime.pieces.find((p) => p.name === 'billing/invoice');

  assert.deepEqual([invoice?.parent, invoice?.depth], ['billing', 1]);
  assert.equal(runtime.pieces.find((p) => p.name === 'todos')?.title, 'Todos');
  assert.deepEqual(runtime.pieces.find((p) => p.name === 'audit')?.config, { label: 'fixture' });
});

test('a process selects its pieces by id glob', async () => {
  await using runtime = await createRuntime({
    root: fixture('v2/app'),
    process: 'billing',
    env,
    signals: false,
  });

  assert.deepEqual(
    runtime.pieces.map((p) => p.name),
    ['billing/invoice'],
  );
});

test('$sys.piece.started carries the loaded needs, config keys and parent group', async () => {
  const tapped: Envelope[] = [];
  await using runtime = await bootApp(tapped);
  await runtime.start();
  await until(() => named(tapped, '$sys.piece.started').length === 3);

  const started = new Map(
    named(tapped, '$sys.piece.started').map((e) => [payloadOf(e)['piece'], payloadOf(e)] as const),
  );
  const fields = (piece: string) => {
    const payload = started.get(piece);

    return [payload?.['group'], payload?.['needs'], payload?.['configKeys']];
  };

  assert.deepEqual(fields('todos'), ['', ['sqlite'], []]);
  assert.deepEqual(fields('audit'), ['', [], ['label']]);
  assert.equal(started.get('billing/invoice')?.['group'], 'billing');
});

test('a $sys.log emitted inside a handler carries the delivery traceId and eventId', async () => {
  const tapped: Envelope[] = [];
  await using runtime = await bootApp(tapped);
  await runtime.start();
  await runtime.bus.request(CreateTodo, { title: 'eggs' });
  await until(() => named(tapped, '$sys.log').some((e) => payloadOf(e)['msg'] === 'todo created'));

  const created = named(tapped, TodoCreated.wireName)[0];
  const log = named(tapped, '$sys.log').find((e) => payloadOf(e)['msg'] === 'todo created');

  assert.ok(created && log);
  assert.equal(payloadOf(log)['piece'], 'audit');
  assert.equal(payloadOf(log)['traceId'], created.traceId);
  assert.equal(payloadOf(log)['eventId'], created.id);
  assert.equal(log.traceId, created.traceId);
  assert.equal(log.source, 'audit');
});

test('withTap sees every publish including $sys.*', async () => {
  const { app, memory } = memoryApp('tapped', { capabilities: [sqlite] });
  const tapped: Envelope[] = [];

  const runtime = await createRuntime({
    root: fixture('v2/app'),
    app,
    env,
    signals: false,
    tap: (e) => tapped.push(e),
  });

  await runtime.start();
  await runtime.bus.request(CreateTodo, { title: 'tea' });
  await until(() => named(tapped, '$sys.log').some((e) => payloadOf(e)['msg'] === 'todo created'));
  await runtime.stop('test');

  const names = new Set(tapped.map((e) => e.name));
  const local = named(tapped, '$sys.event.published').filter((e) => payloadOf(e)['local'] === true);

  assert.equal(tapped.length, memory.stats.published + local.length);
  assert.ok(local.some((e) => payloadOf(e)['name'] === CreateTodo.wireName));

  for (const name of [
    '$sys.runtime.started',
    '$sys.capability.started',
    '$sys.log',
    '$sys.runtime.stopped',
  ]) {
    assert.ok(names.has(name), `tap saw ${name}`);
  }

  assert.ok(names.has(CreateTodo.wireName) && names.has(TodoCreated.wireName));
});

test('a broken import and a bad config value give one report with 2 errors in 2 pieces', async () => {
  const { app } = memoryApp('broken');
  const report = await bootReportOf(createRuntime({ root: fixture('v2/broken'), app, env, signals: false }));
  const config = report.errors.find((e) => e.phase === 'config');

  assert.equal(report.ok, false);
  assert.deepEqual(report.errors.map((e) => e.phase).toSorted(), ['config', 'load']);
  assert.deepEqual(
    report.pieces.filter((p) => p.errors.length > 0).map((p) => p.name),
    ['bad', 'cfg'],
  );
  assert.deepEqual(config?.issues?.[0]?.path, ['port']);
});

test('billing/invoice and billing-invoice collide on one env name', async () => {
  const { app } = memoryApp('collision');

  const report = await bootReportOf(
    createRuntime({ root: fixture('v2/collision'), app, env, signals: false }),
  );

  const collisions = report.errors.filter((e) => e.code === 'config-env-collision');

  assert.equal(collisions.length, 1);
  assert.equal(collisions[0]?.phase, 'config');
  assert.match(collisions[0]?.message ?? '', /MURMUR__BILLING_INVOICE__TAX_RATE/);
  assert.match(collisions[0]?.message ?? '', /billing\/invoice/);
  assert.match(collisions[0]?.message ?? '', /billing-invoice/);
});

test('capabilities start in dependency order and stop LIFO', async () => {
  const tapped: Envelope[] = [];
  const runtime = await storageRuntime(tapped);
  await runtime.start();
  await runtime.stop('test');

  const names = (event: string) => named(tapped, event).map((e) => payloadOf(e)['name']);
  const order = tapped.map((e) => e.name);

  assert.deepEqual(names('$sys.capability.started'), ['sqlite', 'kv']);
  assert.deepEqual(names('$sys.capability.stopped'), ['kv', 'sqlite']);
  assert.ok(order.lastIndexOf('$sys.capability.stopped') < order.indexOf('$sys.runtime.stopped'));
});

test('a kv.once effect that throws once is applied on retry, exactly once with its marker', async () => {
  const tapped: Envelope[] = [];
  await using runtime = await storageRuntime(tapped);
  await runtime.start();
  await runtime.bus.emit(JobRequested, { id: 'job-1' });

  const acked = () =>
    named(tapped, '$sys.delivery.acked').filter((e) => payloadOf(e)['name'] === JobRequested.wireName);
  await until(() => acked().length === 1);
  const failed = named(tapped, '$sys.delivery.failed');

  assert.equal(failed.length, 1);
  assert.equal(payloadOf(failed[0])['willRetry'], true);
  assert.equal(payloadOf(acked()[0])['attempt'], 2);
  assert.deepEqual(await runtime.bus.request(CountEffects, { id: 'job-1' }), { effects: 1, markers: 1 });
});
