import { inApp, runRule } from '../../test/tester.ts';
import rule from './no-comments-in-functions.ts';

const filename = inApp('pieces/notify/send/legacy.ts');
const message = 'comment inside a function body; move the knowledge to context.md or into a name';

runRule('no-comments-in-functions', rule, {
  valid: [
    { code: '// top-level note\nexport function f() {\n  return 1\n}', filename },
    { code: '/** Adds. */\nexport function add(a, b) {\n  return a + b\n}', filename },
    {
      code: 'export function f() {\n  // eslint-disable-next-line no-console\n  console.log(1)\n}',
      filename,
    },
    {
      code: 'export function f() {\n  // oxlint-disable-next-line no-console\n  console.log(1)\n}',
      filename,
    },
    { code: 'export function f(x) {\n  // @ts-expect-error untyped\n  return x.y\n}', filename },
    { code: 'export function f(x) {\n  /* c8 ignore next */\n  return x\n}', filename },
  ],
  invalid: [
    {
      code: 'export function f() {\n  // retry later\n  return 1\n}',
      filename,
      errors: [{ message, line: 2 }],
    },
    {
      code: 'export class A {\n  m() {\n    /* why */\n    return 1\n  }\n}',
      filename,
      errors: [{ message, line: 3 }],
    },
    {
      code: 'export function outer() {\n  return () => {\n    // nested\n    return 1\n  }\n}',
      filename,
      errors: [{ message, line: 3 }],
    },
    { code: 'export const f = () => {\n  // arrow\n  return 1\n}', filename, errors: 1 },
  ],
});
