import { runRule } from '../../test/tester.ts';
import rule from './model-no-runtime.ts';

const filename = '/repo/packages/core/src/model/piece.ts';
const message =
  'model never imports runtime; declare the shape in model/ and let runtime/ implement it (§3.0)';

runRule('model-no-runtime', rule, {
  valid: [
    { code: "import type { Schema } from './schema.ts'\nexport type S = Schema", filename },
    { code: "import type { X } from '../runtime-notes/x.ts'\nexport type Y = X", filename },
    {
      code: "import type { Bus } from './bus/bus.ts'\nexport type B = Bus",
      filename: '/repo/packages/core/src/runtime/x.ts',
    },
  ],
  invalid: [
    {
      code: "import type { Bus } from '../runtime/bus/bus.ts'\nexport type B = Bus",
      filename,
      errors: [{ message }],
    },
    { code: "export { createBus } from '../runtime/index.ts'", filename, errors: 1 },
    { code: "export const load = () => import('../runtime/bus/bus.ts')", filename, errors: 1 },
  ],
});
