import { inApp, runRule } from '../../test/tester.ts';
import rule from './folder-local-imports.ts';

const invoice = inApp('pieces/billing/invoice/total.ts');
const rates = inApp('pieces/billing/invoice/rates/piece.ts');
const leaves = (spec: string) =>
  `import "${spec}" leaves the piece folder; pieces talk only through contracts`;

runRule('folder-local-imports', rule, {
  valid: [
    { code: "import { total } from './total.ts'", filename: inApp('pieces/billing/invoice/piece.ts') },
    { code: "import { SimTick } from '../contracts.ts'", filename: invoice },
    { code: "import { SimTick } from '../../contracts.ts'", filename: rates },
    { code: "export { helper } from './helpers/format.ts'", filename: invoice },
    { code: "import { x } from '../../y.ts'", filename: inApp('src/a.ts') },
    { code: "import { x } from '../notify/send/legacy.ts'", filename: inApp('pieces/billing/contracts.ts') },
  ],
  invalid: [
    {
      code: "import { rate } from './rates/rate.ts'",
      filename: invoice,
      errors: [{ message: '"./rates/rate.ts" belongs to the nested piece rates' }],
    },
    {
      code: "import { Mailer } from '../../notify/send/legacy.ts'",
      filename: invoice,
      errors: [{ message: leaves('../../notify/send/legacy.ts') }],
    },
    {
      code: "import { SimTick } from '../../billing/contracts.ts'",
      filename: inApp('pieces/notify/send/piece.ts'),
      errors: [{ message: leaves('../../billing/contracts.ts') }],
    },
    {
      code: "import { total } from '../total.ts'",
      filename: rates,
      errors: [{ message: leaves('../total.ts') }],
    },
    { code: "export * from '../other.ts'", filename: invoice, errors: 1 },
    { code: "export const load = () => import('../other.ts')", filename: invoice, errors: 1 },
  ],
});
