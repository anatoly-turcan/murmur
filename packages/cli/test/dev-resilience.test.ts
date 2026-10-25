import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Frame, HealthResponse } from '@murmur/dev-protocol';

import {
  cli,
  copyFixtureApp,
  getJson,
  HTTP_APP,
  openEvents,
  postJson,
  STALL_PIECE,
  startDev,
  waitUntil,
} from './dev-helpers.ts';
import { writeFiles } from './helpers.ts';

type FrameOf<K extends Frame['frame']> = Extract<Frame, { frame: K }>;

const is =
  <K extends Frame['frame']>(kind: K) =>
  (frame: Frame): frame is FrameOf<K> =>
    frame.frame === kind;

const RENAMED_TRANSPORT = [
  "import { defineApp } from '@murmur/node'",
  "import { sqlite } from '@murmur/node/capabilities'",
  "import { createMemoryTransport } from '@murmur/transport-memory'",
  '',
  'export default defineApp({',
  "  name: 'cli-fixture',",
  "  transport: () => ({ ...createMemoryTransport(), name: 'renamed' }),",
  '  capabilities: { sqlite: sqlite() },',
  '})',
  '',
].join('\n');

function rawRequest(url: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('the dev server refuses cross-site and rebinding requests', { timeout: 60_000 }, async (t) => {
  using app = copyFixtureApp();
  const dev = await startDev(app.root);
  t.after(() => dev.child.kill('SIGKILL'));
  const emit = JSON.stringify({ contract: 'slow.requested', payload: { ms: 1 }, mode: 'emit' });
  const send = (headers: Record<string, string>) =>
    fetch(`${dev.base}/api/emit`, { method: 'POST', headers, body: emit }).then((res) => res.status);

  assert.equal(await send({ origin: 'http://evil.example', 'content-type': 'text/plain' }), 403);
  assert.equal(await send({ origin: 'http://evil.example', 'content-type': 'application/json' }), 403);
  assert.equal(await send({ 'content-type': 'text/plain' }), 403);
  const port = new URL(dev.base).port;
  const rebound = { host: `evil.example:${port}`, 'content-type': 'application/json' };
  assert.equal(await rawRequest(`${dev.base}/api/restart`, rebound, '{}'), 403);
  assert.equal((await getJson(`${dev.base}/api/pieces/%E0%A4%A`)).status, 400);
  dev.child.kill('SIGINT');
  assert.equal(await dev.exited, 0, dev.output());
});

test('pause state, non-memory pause and a broken murmur.config.ts', { timeout: 120_000 }, async (t) => {
  using app = copyFixtureApp();
  const dev = await startDev(app.root);
  t.after(() => dev.child.kill('SIGKILL'));
  const events = await openEvents(`${dev.base}/api/events`);
  t.after(() => events.close());
  await events.next(is('dev.boot'));
  const config = join(app.root, 'murmur.config.ts');

  await t.test('pause and resume publish frames', async () => {
    assert.deepEqual((await postJson(`${dev.base}/api/pause`, {})).body, { paused: true });
    await events.next(is('dev.paused'));
    assert.deepEqual((await postJson(`${dev.base}/api/resume`, {})).body, { paused: false });
    await events.next(is('dev.resumed'));
  });

  await t.test('a restart while paused publishes dev.resumed', async () => {
    await postJson(`${dev.base}/api/pause`, {});
    await events.next(is('dev.paused'));
    await postJson(`${dev.base}/api/restart`, {});
    await events.next(is('dev.restart'));
    await events.next(is('dev.resumed'), 20_000);
    await events.next(is('dev.boot'), 20_000);
  });

  await t.test('pause on a transport other than memory answers 409', async () => {
    writeFileSync(config, RENAMED_TRANSPORT);
    await events.next(is('dev.restart'));
    const boot = await events.next(is('dev.boot'), 20_000);
    assert.equal(boot.snapshot.app.transport, 'renamed');
    const paused = await postJson<{ error: { name: string } }>(`${dev.base}/api/pause`, {});
    assert.equal(paused.status, 409);
    assert.equal(paused.body.error.name, 'TransportNotPausableError');
  });

  await t.test('a syntax error in murmur.config.ts reports dev.boot_failed', async () => {
    writeFileSync(config, 'export default (\n');
    const failed = await events.next(is('dev.boot_failed'), 20_000);
    assert.equal(failed.report.ok, false);
    assert.equal(failed.report.errors[0]?.phase, 'load');
    assert.ok(failed.report.errors[0]?.file?.endsWith('murmur.config.ts'), JSON.stringify(failed.report));
    assert.equal((await getJson<HealthResponse>(`${dev.base}/api/health`)).body.ok, true);
  });

  dev.child.kill('SIGINT');
  assert.equal(await dev.exited, 0, dev.output());
});

test('health answers and a second dev exits 5 while describe is pending', { timeout: 60_000 }, async (t) => {
  using app = copyFixtureApp();
  writeFiles(app.root, STALL_PIECE);
  const dev = await startDev(app.root);
  t.after(() => dev.child.kill('SIGKILL'));
  const started = Date.now();
  const health = await getJson<HealthResponse>(`${dev.base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.body.pieces, 0, 'neither the boot nor the describe has finished yet');
  assert.ok(Date.now() - started < 1_500);
  const second = await cli(['dev', '--no-ui', '--port', '0', '--cwd', app.root], app.root);
  assert.equal(second.status, 5, second.stderr);
  dev.child.kill('SIGINT');
  assert.equal(await dev.exited, 0, dev.output());
});

test(
  'a taken app port names EADDRINUSE in the BootReport and hints at the http port env var',
  { timeout: 60_000 },
  async (t) => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    t.after(() => blocker.close());
    const { port } = blocker.address() as AddressInfo;
    using app = copyFixtureApp();
    writeFiles(app.root, { ...HTTP_APP, '.env': `MURMUR__CAP_WEB__PORT=${port}\n` });
    const dev = await startDev(app.root);
    t.after(() => dev.child.kill('SIGKILL'));

    const output = await waitUntil(() =>
      /set MURMUR__CAP_WEB__PORT/.test(dev.output()) ? dev.output() : undefined,
    );

    assert.match(output, new RegExp(`EADDRINUSE on port ${port}`));
    assert.match(output, new RegExp(`port ${port} is taken.*set MURMUR__CAP_WEB__PORT=<free port>`));
    assert.doesNotMatch(output, /^\s+at /m);
    dev.child.kill('SIGINT');
    assert.equal(await dev.exited, 0, dev.output());
  },
);
