import { inApp, runRule } from '../../test/tester.ts';
import rule from './declared-deps-only.ts';

const invoice = inApp('pieces/billing/invoice/total.ts');
const todos = inApp('pieces/todos/repository.ts');
const todosTest = inApp('pieces/todos/piece.test.ts');

runRule('declared-deps-only', rule, {
  valid: [
    { code: "import { nanoid } from 'nanoid'", filename: todos },
    { code: "import { customAlphabet } from 'nanoid/non-secure'", filename: todos },
    {
      code: "import { readFileSync } from 'node:fs'\nimport { createHash } from 'node:crypto'",
      filename: todos,
    },
    { code: "import web from '#capabilities/web'\nimport { Todo } from '#contracts/todos'", filename: todos },
    { code: "import { nfcTrim } from '#lib/text'", filename: todosTest },
    {
      code: "import { sqlite } from '@murmur/node/capabilities'\nimport { bearer } from '@murmur/node/lib'\nimport { testPiece } from '@murmur/node/testing'",
      filename: todos,
    },
    { code: "import fc from 'fast-check'", filename: todosTest },
    { code: "import { z } from 'zod'\nimport { Piece } from 'murmur'", filename: invoice },
    { code: "import { format } from 'date-fns'", filename: invoice },
    { code: "import { sum } from 'lodash'", filename: inApp('src/a.ts') },
  ],
  invalid: [
    {
      code: "import { sum } from 'lodash'",
      filename: todos,
      errors: [
        { message: '"lodash" is not in dependencies of package.json; add it there or prefer a capability' },
      ],
    },
    {
      code: "import fc from 'fast-check'",
      filename: todos,
      errors: [
        {
          message: '"fast-check" is not in dependencies of package.json; add it there or prefer a capability',
        },
      ],
    },
    {
      code: "import { sum } from 'lodash'",
      filename: todosTest,
      errors: [
        {
          message:
            '"lodash" is not in dependencies or devDependencies of package.json; add it there or prefer a capability',
        },
      ],
    },
    {
      code: "import { nanoid } from 'nanoid'",
      filename: '/murmur-no-manifest/pieces/todos/repository.ts',
      errors: [{ message: '"nanoid" is not declared: no package.json found above this file' }],
    },
    { code: "import { internal } from 'murmur/internal'", filename: todos, errors: 1 },
    { code: "export { pad } from 'left-pad'", filename: invoice, errors: 1 },
    {
      code: "import { Piece } from 'murmur'\nimport { v4 } from 'uuid'\nexport class Send extends Piece() {}",
      filename: inApp('pieces/notify/send/piece.ts'),
      errors: 1,
    },
  ],
});
