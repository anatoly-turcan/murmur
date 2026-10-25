import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { oxlint, root } from './oxlint.ts';

const fixtures = join(import.meta.dirname, 'fixtures/style');
const target = 'src/style.ts';

let app = '';

function tool(bin: string, args: readonly string[]): void {
  const result = spawnSync(join(root, 'node_modules/.bin', bin), args, { cwd: app, encoding: 'utf8' });
  assert.ok(result.status === 0 || result.status === 1, result.stdout + result.stderr);
}

function lintFix(): string {
  tool('oxfmt', [target]);
  tool('oxlint', ['--fix', target]);
  tool('oxfmt', [target]);

  return readFileSync(join(app, target), 'utf8');
}

describe('golden style fixture: pnpm lint:fix turns before.ts into after.ts', () => {
  before(() => {
    app = mkdtempSync(join(tmpdir(), 'murmur-style-golden-'));
    mkdirSync(join(app, 'src'));
    copyFileSync(join(fixtures, 'before.ts'), join(app, target));
    copyFileSync(join(root, 'packages/lint/oxfmt.json'), join(app, '.oxfmtrc.json'));
    writeFileSync(
      join(app, '.oxlintrc.json'),
      JSON.stringify({ extends: [join(root, 'packages/lint/preset.json')] }),
    );
  });

  after(() => rmSync(app, { recursive: true, force: true }));

  test('oxfmt, oxlint --fix, oxfmt write exactly after.ts', () => {
    assert.equal(lintFix(), readFileSync(join(fixtures, 'after.ts'), 'utf8'));
  });

  test('a second run changes nothing and the preset reports nothing', () => {
    const once = readFileSync(join(app, target), 'utf8');

    assert.equal(lintFix(), once);
    assert.deepEqual(oxlint(app, '.oxlintrc.json', [target]), []);
  });
});
