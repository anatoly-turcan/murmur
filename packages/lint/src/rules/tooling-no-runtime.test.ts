import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { runRule } from '../../test/tester.ts';
import rule, { runtimeExports } from './tooling-no-runtime.ts';

const filename = '/repo/packages/cli/src/commands/catalog.ts';
const options = [{ allow: ['packages/cli/src/dev/child.ts', 'packages/cli/src/commands/start.ts'] }];

function exportedNames(source: string): string[] {
  const lists = [...source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)].map((match) => match[1] ?? '');

  return lists
    .flatMap((list) => list.split(','))
    .map((name) => name.trim())
    .filter(Boolean)
    .toSorted();
}

test('the runtime-name constant equals the exports of packages/core/src/runtime/index.ts', () => {
  const index = readFileSync(join(import.meta.dirname, '../../../core/src/runtime/index.ts'), 'utf8');
  assert.deepEqual([...runtimeExports].toSorted(), exportedNames(index));
});

runRule('tooling-no-runtime', rule, {
  valid: [
    {
      code: "import { Model, Query } from 'murmur'\nexport const x = [Model, Query]",
      filename,
      options,
    },
    { code: "import type { Envelope } from 'murmur'\nexport type E = Envelope", filename, options },
    { code: "import type { Frame } from '@murmur/dev-protocol'\nexport type F = Frame", filename, options },
    { code: "import { fakeClock } from 'murmur/testing'\nexport const t = fakeClock", filename, options },
    {
      code: "import { createBus } from 'murmur'\nexport const b = createBus",
      filename: '/repo/packages/cli/src/dev/child.ts',
      options,
    },
    {
      code: "import { createRuntime } from '@murmur/node'\nexport const r = createRuntime",
      filename: '/repo/packages/cli/src/commands/start.ts',
      options,
    },
  ],
  invalid: [
    {
      code: "import { createBus } from 'murmur'\nexport const b = createBus",
      filename,
      options,
      errors: [
        {
          message:
            'tooling imports the piece model only (plus @murmur/dev-protocol); createBus belongs to the app process',
        },
      ],
    },
    {
      code: "import type { Transport } from 'murmur'\nexport type T = Transport",
      filename,
      options,
      errors: 1,
    },
    {
      code: "import { Piece, parseEnvelope, current } from 'murmur'\nexport const x = [Piece, parseEnvelope, current]",
      filename,
      options,
      errors: 2,
    },
    {
      code: "import { createRuntime } from '@murmur/node'\nexport const r = createRuntime",
      filename,
      options,
      errors: [
        {
          message:
            'tooling imports the piece model only (plus @murmur/dev-protocol); @murmur/node belongs to the app process',
        },
      ],
    },
    {
      code: "import { createMemoryTransport } from '@murmur/transport-memory'\nexport const m = createMemoryTransport",
      filename,
      errors: 1,
    },
    { code: "export { parseEnvelope } from 'murmur'", filename, options, errors: 1 },
    { code: "export const load = () => import('@murmur/node/testing')", filename, options, errors: 1 },
  ],
});
