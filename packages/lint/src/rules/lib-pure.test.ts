import { inApp, runRule } from '../../test/tester.ts';
import rule from './lib-pure.ts';

const text = inApp('lib/text.ts');
const mail = inApp('lib/mail.ts');
const nested = inApp('lib/money/round.ts');

const IO =
  'lib modules are pure. Move the I/O to a capability (`capabilities/<name>/capability.ts`) and keep the formatting here';

runRule('lib-pure', rule, {
  valid: [
    { code: "import { createHash } from 'node:crypto'\nimport { z } from 'zod'", filename: text },
    { code: "import { Todo } from '#contracts/todos'\nimport { fold } from '#lib/text'", filename: mail },
    { code: "import { reject } from 'murmur'\nimport { sha256 } from '@murmur/node/lib'", filename: nested },
    { code: "import { format } from 'node:util'\nexport const MAX = 3;", filename: text },
    { code: 'export function next(): number {\n  let n = 0;\n  n += 1;\n  return n;\n}', filename: text },
    { code: "import { readFileSync } from 'node:fs'\nlet x = 1;", filename: inApp('lib/text.test.ts') },
    {
      code: "import { readFileSync } from 'node:fs'\nlet x = 1;",
      filename: inApp('pieces/todos/repository.ts'),
    },
  ],
  invalid: [
    {
      code: "import { readFileSync } from 'node:fs'",
      filename: mail,
      errors: [{ message: `lib/mail.ts imports \`node:fs\`; ${IO}` }],
    },
    {
      code: "import { readFile } from 'fs/promises'\nimport { spawn } from 'node:child_process'",
      filename: mail,
      errors: [
        { message: `lib/mail.ts imports \`fs/promises\`; ${IO}` },
        { message: `lib/mail.ts imports \`node:child_process\`; ${IO}` },
      ],
    },
    {
      code: "import web from '#capabilities/web'",
      filename: nested,
      errors: [{ message: `lib/money/round.ts imports \`#capabilities/web\`; ${IO}` }],
    },
    {
      code: 'let counter = 0;\nexport function bump(): number {\n  counter += 1;\n  return counter;\n}',
      filename: text,
      errors: [
        {
          message:
            'lib/text.ts declares top-level `let counter`; lib modules hold no state. Use `const`, or keep the state in a capability (`capabilities/<name>/capability.ts`)',
        },
      ],
    },
    {
      code: 'export let current = 1;',
      filename: text,
      errors: [{ message: /declares top-level `let current`/ }],
    },
    {
      code: "import { sum } from 'lodash'\nimport { testPiece } from '@murmur/node/testing'",
      filename: text,
      errors: [
        {
          message:
            'lib/text.ts imports `lodash`; a lib module imports only `node:*` without I/O, `zod`, `murmur`, `@murmur/node/lib`, `#contracts/*` and `#lib/*`',
        },
        { message: /imports `@murmur\/node\/testing`; a lib module imports only/ },
      ],
    },
    {
      code: "import { fold } from './text.ts'",
      filename: mail,
      errors: [{ message: 'lib/mail.ts imports `./text.ts`; reach another lib module as `#lib/text`' }],
    },
  ],
});
