import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { cliVersion } from '@murmur/cli';

import { packageRoot, repoRoot } from './helpers.ts';

test('the package root exports cliVersion, so oxlint --fix has no empty export to remove', () => {
  const lint = spawnSync(
    join(repoRoot, 'node_modules/.bin/oxlint'),
    ['-f', 'json', join(packageRoot, 'src/index.ts')],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const report = JSON.parse(lint.stdout) as { diagnostics: unknown[] };

  assert.match(cliVersion(), /^\d+\.\d+\.\d+/);
  assert.deepEqual(report.diagnostics, []);
});
