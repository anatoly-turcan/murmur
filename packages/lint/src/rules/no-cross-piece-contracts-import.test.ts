import { inApp, runRule } from '../../test/tester.ts';
import rule from './no-cross-piece-contracts-import.ts';

const invoice = inApp('pieces/billing/invoice/total.ts');

runRule('no-cross-piece-contracts-import', rule, {
  valid: [
    { code: "import { InvoiceCreated } from '#contracts/billing'", filename: invoice },
    { code: "import { SimTick } from '../contracts.ts'", filename: invoice },
    { code: "import { x } from './contracts-helper.ts'", filename: invoice },
    { code: "import { InvoiceCreated } from '../contracts/billing.ts'", filename: inApp('src/a.ts') },
  ],
  invalid: [
    {
      code: "import { InvoiceDue } from '../../../contracts/billing.ts'",
      filename: invoice,
      errors: [{ message: 'import contracts via #contracts/billing, never by relative path' }],
    },
    {
      code: "import { X } from './contracts/orders.ts'",
      filename: invoice,
      errors: [{ message: 'import contracts via #contracts/orders, never by relative path' }],
    },
    { code: "export * from '../../../contracts/billing.ts'", filename: invoice, errors: 1 },
    { code: "const load = () => import('../../../contracts/billing.ts')", filename: invoice, errors: 1 },
  ],
});
