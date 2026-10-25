import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { pnpmCacheRoot } from './src/pnpm-cache.ts';
import { publish } from './src/publish.ts';

const registry = process.env['NPM_REGISTRY'];
if (registry === undefined || registry === '') {
  console.error(
    'NPM_REGISTRY is required, e.g. NPM_REGISTRY=http://127.0.0.1:4873/ pnpm release:publish [--force]',
  );
  process.exit(2);
}

const { values } = parseArgs({ options: { force: { type: 'boolean' } } });

try {
  const outcomes = await publish({
    root: resolve(import.meta.dirname, '../..'),
    registry,
    token: process.env['NPM_TOKEN'],
    env: process.env,
    log: (line) => console.log(line),
    force: values.force === true,
    cacheRoot: pnpmCacheRoot(process.env, process.platform, homedir()),
  });

  const published = [...outcomes.values()].filter((outcome) => outcome === 'published').length;
  console.log(`${published} published, ${outcomes.size - published} already present on ${registry}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
