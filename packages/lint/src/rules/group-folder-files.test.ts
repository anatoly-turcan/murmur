import { inApp, runRule } from '../../test/tester.ts';
import rule from './group-folder-files.ts';

const groupOnly =
  'group folders hold only context.md, contracts.ts and scenario.test.ts; code belongs in a piece folder';

runRule('group-folder-files', rule, {
  valid: [
    { code: 'export const a = 1', filename: inApp('pieces/billing/contracts.ts') },
    { code: 'export const a = 1', filename: inApp('pieces/billing/scenario.test.ts') },
    { code: 'export const a = 1', filename: inApp('pieces/notify/scenario.test.ts') },
    { code: 'export const a = 1', filename: inApp('pieces/billing/invoice/helpers.ts') },
    { code: 'export const a = 1', filename: inApp('pieces/billing/invoice/piece.test.ts') },
    { code: 'export const a = 1', filename: inApp('src/helpers.ts') },
  ],
  invalid: [
    {
      code: 'export const a = 1',
      filename: inApp('pieces/billing/piece.test.ts'),
      errors: [{ message: 'piece.test.ts needs a piece.ts beside it; a subtree test is scenario.test.ts' }],
    },
    {
      code: 'export const a = 1',
      filename: inApp('pieces/billing/helpers.ts'),
      errors: [{ message: groupOnly }],
    },
    {
      code: 'export const a = 1',
      filename: inApp('pieces/notify/util.ts'),
      errors: [{ message: groupOnly }],
    },
    { code: 'export const a = 1', filename: inApp('pieces/top.ts'), errors: [{ message: groupOnly }] },
  ],
});
