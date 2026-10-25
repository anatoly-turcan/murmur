import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { createSandbox, lintInSandbox, removeSandbox, writeIn } from './oxlint.ts';

const code = 'murmur(tooling-no-runtime)';
const importsBus = "import { createBus } from 'murmur'\nexport const make = createBus\n";

let sandbox = '';

function hits(path: string, source: string) {
  return lintInSandbox(sandbox, writeIn(sandbox, path, source), code);
}

describe('murmur/tooling-no-runtime through the root .oxlintrc.json', () => {
  before(() => {
    sandbox = createSandbox();
  });

  after(() => removeSandbox(sandbox));

  test('a cli source file importing createBus from murmur is flagged', () => {
    assert.equal(hits('packages/cli/src/fixture.ts', importsBus).length, 1);
  });

  test('the allowed app-process entries are not flagged', () => {
    assert.deepEqual(hits('packages/cli/src/dev/child.ts', importsBus), []);
    assert.deepEqual(hits('packages/cli/src/commands/start.ts', importsBus), []);
  });

  test('ui, lint, dev-protocol and plugins are tooling too', () => {
    const importsNode = "import { createRuntime } from '@murmur/node'\nexport const r = createRuntime\n";
    for (const path of [
      'packages/ui/src/a.ts',
      'packages/lint/src/a.ts',
      'packages/dev-protocol/src/a.ts',
      'plugins/murmur/hooks/a.ts',
    ]) {
      assert.equal(hits(path, importsNode).length, 1, path);
    }
  });

  test('app packages may import the runtime', () => {
    assert.deepEqual(hits('packages/node/src/a.ts', importsBus), []);
  });
});
