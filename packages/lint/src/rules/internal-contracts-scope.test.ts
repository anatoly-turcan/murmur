import { inApp, runRule } from '../../test/tester.ts';
import rule from './internal-contracts-scope.ts';

const send = inApp('pieces/notify/send/piece.ts');

runRule('internal-contracts-scope', rule, {
  valid: [
    { code: "import { SimTick } from '../contracts.ts'", filename: inApp('pieces/billing/invoice/piece.ts') },
    {
      code: "import { SimTick } from '../../contracts.ts'",
      filename: inApp('pieces/billing/invoice/rates/piece.ts'),
    },
    { code: "import { SimTick } from './contracts.ts'", filename: inApp('pieces/billing/scenario.test.ts') },
    { code: "import { InvoiceCreated } from '#contracts/billing'", filename: send },
    { code: "import { InvoiceCreated } from '../../contracts/billing.ts'", filename: inApp('src/x.ts') },
  ],
  invalid: [
    {
      code: "import { SimTick } from '../../billing/contracts.ts'",
      filename: send,
      errors: [
        {
          message: 'SimTick is internal to pieces/billing; move it to contracts/ to make it public',
        },
      ],
    },
    {
      code: "import { SimTick } from './pieces/billing/contracts.ts'",
      filename: inApp('murmur.config.ts'),
      errors: [{ message: /^SimTick is internal to pieces\/billing/ }],
    },
    {
      code: "export * from '../../billing/contracts.ts'",
      filename: send,
      errors: [
        {
          message:
            'pieces/billing/contracts.ts is internal to pieces/billing; move it to contracts/ to make it public',
        },
      ],
    },
    { code: "const load = () => import('../../billing/contracts.ts')", filename: send, errors: 1 },
  ],
});
