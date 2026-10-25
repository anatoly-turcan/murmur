import { inApp, runRule } from '../../test/tester.ts';
import rule from './no-nested-ternary.ts';

const filename = inApp('pieces/todos/repository.ts');
const message = 'nested ternary: make the outer choice an if block, or name the inner value first';

runRule('no-nested-ternary', rule, {
  valid: [
    { code: "export const label = done ? 'done' : 'open'", filename },
    { code: 'const a = x ? 1 : 2\nexport const b = y ? a : 3', filename },
    { code: "export const label = done ? 'done' : open ?? 'none'", filename },
  ],
  invalid: [
    {
      code: "export const label = done ? 'done' : (empty ? 'untitled' : 'open')",
      filename,
      errors: [{ message, line: 1 }],
    },
    { code: "export const label = done ? 'done' : empty ? 'untitled' : 'open'", filename, errors: 1 },
    { code: 'export const n = (a ? b : c) ? 1 : 2', filename, errors: 1 },
    { code: 'export const f = a ? list.map((x) => (x ? 1 : 2)) : []', filename, errors: 1 },
    { code: 'export const deep = a ? (b ? (c ? 1 : 2) : 3) : 4', filename, errors: 2 },
  ],
});
