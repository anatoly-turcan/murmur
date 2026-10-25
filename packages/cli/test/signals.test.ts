import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { devStopPolicy } from '@murmur/dev-protocol';

import {
  bind,
  copyFixtureApp,
  freePort,
  HTTP_APP,
  killGroup,
  launch,
  STALL_PIECE,
  startDev,
  waitUntil,
  type Launched,
} from './dev-helpers.ts';
import { writeFiles } from './helpers.ts';

const DEV_BUDGET_MS = devStopPolicy.graceMs + devStopPolicy.forceMs + 1_000;
const START_BUDGET_MS = 10_000 + 2_000;
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

async function answers(url: string): Promise<true | undefined> {
  try {
    return (await fetch(url)).ok ? true : undefined;
  } catch {
    return undefined;
  }
}

async function signalPid(
  launched: Launched,
  signal: NodeJS.Signals,
): Promise<{ code: number | null; ms: number }> {
  const started = performance.now();
  process.kill(launched.child.pid as number, signal);
  const code = await launched.exited;

  return { code, ms: Math.round(performance.now() - started) };
}

async function httpApp(root: string): Promise<number> {
  const port = await freePort();
  writeFiles(root, { ...HTTP_APP, '.env': `MURMUR__CAP_WEB__PORT=${port}\n` });

  return port;
}

for (const signal of SIGNALS) {
  test(`detached murmur dev stops on ${signal} to its pid alone`, { timeout: 60_000 }, async (t) => {
    using app = copyFixtureApp();
    const appPort = await httpApp(app.root);
    const dev = await startDev(app.root, [], { detached: true });
    t.after(() => killGroup(dev));
    await waitUntil(() => answers(`http://127.0.0.1:${appPort}/healthz`));
    const devPort = Number(new URL(dev.base).port);

    const { code, ms } = await signalPid(dev, signal);

    assert.equal(code, 0, dev.output());
    assert.ok(ms < DEV_BUDGET_MS, `took ${ms} ms, budget ${DEV_BUDGET_MS} ms`);
    assert.equal(existsSync(join(app.root, '.murmur', 'dev.json')), false, 'lock removed');
    assert.equal(await bind(devPort), true, 'dev server port free');
    assert.equal(await bind(appPort), true, 'app http port free');
  });
}

test(
  'detached murmur dev stops within the budget when SIGTERM lands mid-boot',
  { timeout: 60_000 },
  async (t) => {
    using app = copyFixtureApp();
    writeFiles(app.root, STALL_PIECE);
    const dev = await startDev(app.root, [], { detached: true });
    t.after(() => killGroup(dev));

    const { code, ms } = await signalPid(dev, 'SIGTERM');

    assert.equal(code, 0, dev.output());
    assert.ok(ms < DEV_BUDGET_MS, `took ${ms} ms, budget ${DEV_BUDGET_MS} ms`);
    assert.equal(existsSync(join(app.root, '.murmur', 'dev.json')), false, 'lock removed');
    assert.doesNotMatch(dev.output(), /did not boot/);
  },
);

for (const signal of SIGNALS) {
  test(`detached murmur start stops on ${signal} to its pid alone`, { timeout: 60_000 }, async (t) => {
    using app = copyFixtureApp();
    const appPort = await httpApp(app.root);
    const start = launch(['start', '--cwd', app.root], app.root, { detached: true });
    t.after(() => killGroup(start));
    await waitUntil(() => answers(`http://127.0.0.1:${appPort}/healthz`));
    const { code, ms } = await signalPid(start, signal);

    assert.equal(code, 0, start.output());
    assert.ok(ms < START_BUDGET_MS, `took ${ms} ms, budget ${START_BUDGET_MS} ms`);
    assert.equal(await bind(appPort), true, 'app http port free');
  });
}
