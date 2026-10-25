import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createSandbox, lintInSandbox, removeSandbox, root, writeIn } from './oxlint.ts';

const injected = "import type { Bus } from '../runtime/bus/bus.ts'\n";

let sandbox = '';

function writeModelFile(name: string, source: string): string {
  return writeIn(sandbox, join('packages/core/src/model', name), source);
}

function ruleHits(file: string) {
  return lintInSandbox(sandbox, file, 'murmur(model-no-runtime)');
}

describe('murmur/model-no-runtime through the root .oxlintrc.json', () => {
  before(() => {
    sandbox = createSandbox();
  });

  after(() => removeSandbox(sandbox));

  test('the real model/piece-class.ts is clean', () => {
    const source = readFileSync(join(root, 'packages/core/src/model/piece-class.ts'), 'utf8');
    assert.deepEqual(ruleHits(writeModelFile('piece-class.ts', source)), []);
  });

  test('injecting an import type of the runtime bus into model/piece-class.ts is an error', () => {
    const source = readFileSync(join(root, 'packages/core/src/model/piece-class.ts'), 'utf8');
    const hits = ruleHits(writeModelFile('piece-class.ts', injected + source));
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.message ?? '', /model never imports runtime/);
  });

  test('re-exports and dynamic imports that enter runtime/ are errors too', () => {
    const source = [
      "export { createBus } from '../runtime/index.ts'",
      "export * from '../runtime/errors.ts'",
      "export const load = () => import('../runtime/bus/bus.ts')",
      "import '../runtime'",
    ].join('\n');
    assert.equal(ruleHits(writeModelFile('reexport.ts', source)).length, 4);
  });

  test('imports inside model/ and of other packages are allowed', () => {
    const source = [
      "import type { Schema } from './schema.ts'",
      "import { z } from 'zod'",
      "import type { X } from '../runtime-notes/x.ts'",
      'export type Y = [Schema, typeof z, X]',
    ].join('\n');
    assert.deepEqual(ruleHits(writeModelFile('allowed.ts', source)), []);
  });

  test('files outside model/ are not checked', () => {
    const file = writeIn(
      sandbox,
      'packages/core/src/runtime/x.ts',
      "import type { Bus } from './bus/bus.ts'\nexport type X = Bus\n",
    );
    assert.deepEqual(ruleHits(file), []);
  });
});
