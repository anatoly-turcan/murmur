import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createSandbox, lintInSandbox, removeSandbox, root, writeIn } from './oxlint.ts';

const code = 'murmur(core-no-node)';
const index = readFileSync(join(root, 'packages/core/src/index.ts'), 'utf8');

let sandbox = '';

describe('murmur/core-no-node through the root .oxlintrc.json', () => {
  before(() => {
    sandbox = createSandbox();
  });

  after(() => removeSandbox(sandbox));

  test('the real packages/core/src/index.ts is clean', () => {
    const file = writeIn(sandbox, 'packages/core/src/index.ts', index);
    assert.deepEqual(lintInSandbox(sandbox, file, code), []);
  });

  test("injecting import 'node:fs' into packages/core/src/index.ts is an error", () => {
    const file = writeIn(sandbox, 'packages/core/src/index.ts', `import 'node:fs'\n${index}`);
    const hits = lintInSandbox(sandbox, file, code);
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.message ?? '', /core has zero node:\* imports/);
  });

  test('packages outside core may import node builtins', () => {
    const file = writeIn(sandbox, 'packages/node/src/x.ts', "import 'node:fs'\n");
    assert.deepEqual(lintInSandbox(sandbox, file, code), []);
  });
});
