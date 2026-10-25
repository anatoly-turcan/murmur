import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BootFailedError, createRuntime, type Runtime, type Sqlite } from '@murmur/node';
import type { HttpServer, Jobs } from '@murmur/node/capabilities';
import { createTestApp } from '@murmur/node/testing';
import { createMemoryTransport } from '@murmur/transport-memory';
import type { Envelope } from 'murmur';

import { Work } from '../fixtures/v2/processes/contracts/work.ts';
import { fixture } from '../helpers.ts';

const root = fixture('v2/processes');

interface Booted extends AsyncDisposable {
  readonly runtime: Runtime;
  readonly tapped: Envelope[];
  readonly logs: () => string[];
}

async function scratchFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'murmur-processes-')), 'app.db');
}

async function boot(name: string | undefined, env: Record<string, string> = {}): Promise<Booted> {
  const tapped: Envelope[] = [];

  const runtime = await createRuntime({
    root,
    signals: false,
    mode: 'prod',
    tap: (envelope) => tapped.push(envelope),
    env: { MURMUR_LOG_LEVEL: 'info', DATABASE_PATH: await scratchFile(), ...env },
    ...(name === undefined ? {} : { process: name }),
  });

  await runtime.start();

  return {
    runtime,
    tapped,
    logs: () =>
      tapped.filter((e) => e.name === '$sys.log').map((e) => String(Reflect.get(Object(e.payload), 'msg'))),
    [Symbol.asyncDispose]: () => runtime.stop('test'),
  };
}

function names(runtime: Runtime): string[] {
  return runtime.pieces.map((piece) => piece.name);
}

function started(tapped: readonly Envelope[]): string[] {
  return tapped
    .filter((e) => e.name === '$sys.piece.started')
    .map((e) => String(Reflect.get(Object(e.payload), 'piece')))
    .toSorted();
}

function jobsOf(runtime: Runtime): Jobs {
  return runtime.capabilities.get('jobs') as Jobs;
}

function urlOf(runtime: Runtime): string {
  return (runtime.capabilities.get('web') as HttpServer).url;
}

test('a piece outside the process is not loaded or constructed and its routes are 404', async () => {
  await using api = await boot('api');

  assert.deepEqual(names(api.runtime), ['admin', 'edge']);
  assert.deepEqual(started(api.tapped), ['admin', 'edge']);
  assert.equal((await fetch(`${urlOf(api.runtime)}/ping`)).status, 200);
  assert.equal((await fetch(`${urlOf(api.runtime)}/status`)).status, 200);
  await using quiet = await boot('quiet');

  assert.deepEqual(names(quiet.runtime), ['edge', 'worker']);
  assert.equal((await fetch(`${urlOf(quiet.runtime)}/status`)).status, 404);
});

test('a process whose pieces do not handle a job never claims it; the worker process does', async () => {
  const file = await scratchFile();
  await using api = await boot('api', { DATABASE_PATH: file });
  await using worker = await boot('worker', { DATABASE_PATH: file });
  assert.equal((await fetch(`${urlOf(api.runtime)}/work`, { method: 'POST' })).status, 202);
  assert.deepEqual(await jobsOf(api.runtime).drain(), { ran: 0, failed: 0, dead: 0 });
  assert.deepEqual(await jobsOf(api.runtime).counts(), { pending: 1, running: 0, dead: 0 });
  assert.deepEqual(await jobsOf(worker.runtime).drain(), { ran: 1, failed: 0, dead: 0 });

  const db = worker.runtime.capabilities.get('sqlite') as Sqlite;

  assert.deepEqual(await db.all('SELECT label FROM runs'), [{ label: 'from edge' }]);
});

test('jobs: false stops claiming even when the process loads the handler', async () => {
  const file = await scratchFile();
  await using quiet = await boot('quiet', { DATABASE_PATH: file, MURMUR__CAP_JOBS__POLL: 'true' });
  await jobsOf(quiet.runtime).enqueue(Work, { label: 'left for a worker' });
  assert.deepEqual(await jobsOf(quiet.runtime).drain(), { ran: 0, failed: 0, dead: 0 });
  assert.deepEqual(await jobsOf(quiet.runtime).counts(), { pending: 1, running: 0, dead: 0 });
  await using worker = await boot('worker', { DATABASE_PATH: file });
  assert.deepEqual(await jobsOf(worker.runtime).drain(), { ran: 1, failed: 0, dead: 0 });
});

test('a process with no edge starts no ingress and says why', async () => {
  await using worker = await boot('worker');

  assert.deepEqual(names(worker.runtime), ['worker']);
  assert.equal(worker.runtime.capabilities.has('web'), false);
  assert.ok(
    worker
      .logs()
      .some((line) =>
        /web not started: no loaded piece serves through it \(capabilities\.web\.healthz: true listens for \/healthz only\)/.test(
          line,
        ),
      ),
    worker.logs().join('\n'),
  );
});

test('capabilities.web.healthz: true listens with only the built-in /healthz on a worker', async () => {
  await using worker = await boot('worker', { MURMUR__CAP_WEB__HEALTHZ: 'true' });
  const health = await fetch(`${urlOf(worker.runtime)}/healthz`);

  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal((await fetch(`${urlOf(worker.runtime)}/ping`)).status, 404);
});

test('a bad capabilities.web.healthz value on a worker fails the boot instead of staying silent', async () => {
  const message = await bootFailure({
    root,
    process: 'worker',
    signals: false,
    env: { DATABASE_PATH: await scratchFile(), MURMUR__CAP_WEB__HEALTHZ: 'yes' },
  });

  assert.match(message, /web\.config: invalid config: healthz/);
});

test('no process name loads every piece', async () => {
  await using all = await boot(undefined);

  assert.deepEqual(names(all.runtime), ['admin', 'edge', 'worker']);
});

test('createTestApp({ process }) boots that process', async () => {
  await using app = await createTestApp({ root, process: 'worker' });

  assert.deepEqual(names(app.runtime), ['worker']);
  assert.deepEqual(await app.jobs.counts(), { pending: 0, running: 0, dead: 0 });
});

async function bootFailure(options: Parameters<typeof createRuntime>[0]): Promise<string> {
  const error = await createRuntime(options).then(
    () => assert.fail('boot succeeded'),
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof BootFailedError);

  return error.report.errors.map((e) => `${e.code ?? ''}: ${e.message}`).join('\n');
}

test('an unknown process name fails the boot naming the defined ones', async () => {
  const message = await bootFailure({ root, process: 'mailer', signals: false, env: {} });

  assert.match(
    message,
    /process-unknown: process `mailer` is not in defineApp\(\{ processes \}\); start one of api, quiet, worker/,
  );
});

test('a process name on an app without processes fails the boot naming the form', async () => {
  const app = { name: 'flat', transport: () => createMemoryTransport() };
  const message = await bootFailure({ root, app, process: 'api', signals: false, env: {} });

  assert.match(
    message,
    /process-unknown: process `api` needs defineApp\(\{ processes: \{ api: \{ pieces: \['api\/\*\*'\] \} \} \}\)/,
  );
});

test('a process whose globs match no piece id fails the boot naming the id form', async () => {
  const app = {
    name: 'paths',
    transport: () => createMemoryTransport(),
    processes: { api: { pieces: ['pieces/edge'] } },
  };
  const message = await bootFailure({ root, app, process: 'api', signals: false, env: {} });

  assert.match(
    message,
    /process-invalid: processes\.api\.pieces \['pieces\/edge'\] matches no piece; globs are piece ids \(pieces\/<id>\/piece\.ts → '<id>'\), e\.g\. pieces: \['admin', 'admin\/\*\*'\]/,
  );
});
