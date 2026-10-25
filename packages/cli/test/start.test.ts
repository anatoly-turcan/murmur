import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';

import { cli, copyFixtureApp, freePort, HTTP_APP, killGroup, launch, waitUntil } from './dev-helpers.ts';
import { writeFiles } from './helpers.ts';

const STOP_BUDGET_MS = 5_000;

function childrenOf(pid: number): number[] | undefined {
  const file = `/proc/${pid}/task/${pid}/children`;
  if (!existsSync(file)) {
    return undefined;
  }

  return readFileSync(file, 'utf8')
    .split(' ')
    .filter((entry) => entry.trim() !== '')
    .map(Number);
}

async function answers(url: string): Promise<true | undefined> {
  try {
    return (await fetch(url)).ok ? true : undefined;
  } catch {
    return undefined;
  }
}

test('murmur start exits 4 promptly when the app fails to boot', { timeout: 30_000 }, async () => {
  using app = copyFixtureApp();
  writeFileSync(join(app.root, 'pieces', 'audit', 'piece.ts'), 'export class Broken extends Piece(\n');
  const started = Date.now();
  const result = await cli(['start', '--cwd', app.root], app.root);

  assert.equal(result.status, 4, result.stderr);
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
});

test(
  'the pid murmur start was launched as is the runtime, with no child process',
  { timeout: 60_000 },
  async (t) => {
    using app = copyFixtureApp();
    const port = await freePort();
    writeFiles(app.root, { ...HTTP_APP, '.env': `MURMUR__CAP_WEB__PORT=${port}\n` });
    const start = launch(['start', '--cwd', app.root], app.root, { detached: true });
    t.after(() => killGroup(start));
    await waitUntil(() => answers(`http://127.0.0.1:${port}/ping`));
    const banner = await waitUntil(() => /murmur start {2}pieces=\d+ {2}pid=(\d+)/.exec(start.output())?.[1]);
    const launched = start.child.pid as number;

    assert.equal(Number(banner), launched, start.output());
    const children = childrenOf(launched);
    if (children !== undefined) {
      assert.deepEqual(children, [], `murmur start ${launched} has children ${children.join(', ')}`);
    }

    const signalled = performance.now();
    process.kill(launched, 'SIGTERM');
    const code = await start.exited;
    const ms = Math.round(performance.now() - signalled);

    assert.equal(code, 0, start.output());
    assert.ok(ms < STOP_BUDGET_MS, `took ${ms} ms, budget ${STOP_BUDGET_MS} ms`);
  },
);

const PROCESSES_CONFIG = [
  "import { defineApp } from '@murmur/node';",
  "import { sqlite } from '@murmur/node/capabilities';",
  "import { createMemoryTransport } from '@murmur/transport-memory';",
  '',
  'export default defineApp({',
  "  name: 'cli-fixture',",
  '  transport: () => createMemoryTransport(),',
  '  capabilities: [sqlite],',
  "  processes: { api: { pieces: ['ping'] }, worker: { pieces: ['audit'], jobs: false } },",
  '});',
  '',
].join('\n');

test(
  'murmur start worker loads only its pieces and opens no port when no edge is loaded',
  { timeout: 60_000 },
  async (t) => {
    using app = copyFixtureApp();
    const held = createServer();
    held.listen(0, '127.0.0.1');
    await once(held, 'listening');
    t.after(() => held.close());
    const { port } = held.address() as AddressInfo;
    writeFiles(app.root, {
      ...HTTP_APP,
      'murmur.config.ts': PROCESSES_CONFIG,
      '.env': `MURMUR__CAP_WEB__PORT=${port}\n`,
    });
    const start = launch(['start', 'worker', '--cwd', app.root], app.root, { detached: true });
    t.after(() => killGroup(start));

    await waitUntil(() =>
      /murmur start {2}pieces=1 .* process=worker/.test(start.output()) ? true : undefined,
    );

    assert.match(start.output(), /web not started: no loaded piece serves through it/);
    assert.doesNotMatch(start.output(), /EADDRINUSE/, 'the runtime tried to listen on the held port');
    process.kill(start.child.pid as number, 'SIGTERM');
    assert.equal(await start.exited, 0, start.output());
  },
);

test(
  'murmur start with an unknown process exits 4 naming the defined ones',
  { timeout: 30_000 },
  async () => {
    using app = copyFixtureApp();
    writeFiles(app.root, { ...HTTP_APP, 'murmur.config.ts': PROCESSES_CONFIG });
    const result = await cli(['start', 'mailer', '--cwd', app.root], app.root);

    assert.equal(result.status, 4, result.stderr);
    assert.match(
      result.stderr + result.stdout,
      /process `mailer` is not in defineApp\(\{ processes \}\); start one of api, worker/,
    );
  },
);
