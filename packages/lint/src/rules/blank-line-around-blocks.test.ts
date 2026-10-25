import { inApp, runRule } from '../../test/tester.ts';
import rule from './blank-line-around-blocks.ts';

const filename = inApp('pieces/todos/style.ts');

function indented(lines: readonly string[]): string {
  return lines.map((line) => (line === '' ? '' : `  ${line}`)).join('\n');
}

function body(...lines: string[]): string {
  return `export function run(a, b) {\n${indented(lines)}\n}`;
}

function asyncBody(...lines: string[]): string {
  return `export async function run(a, b) {\n${indented(lines)}\n}`;
}

runRule('blank-line-around-blocks', rule, {
  valid: [
    { code: body('return a'), filename },
    { code: body('if (a) {', '  return 1', '}', '', 'return 2'), filename },
    { code: body('const x = a + 1', 'const y = b + 1', '', 'return x + y'), filename },
    { code: body('const x = a + 1', 'log(x)', '', 'for (const item of b) {', '  log(item)', '}'), filename },
    { code: body('log(a)', '', '// the next block retries', 'while (b) {', '  b = next(b)', '}'), filename },
    { code: body('switch (a) {', '  case 1:', '    log(a)', '', '    break', '}'), filename },
    { code: body('try {', '  log(a)', '} catch {', '  log(b)', '}'), filename },
    { code: 'const x = 1\nconst y = 2\nexport { x, y }', filename },
  ],
  invalid: [
    {
      code: body('const x = a + 1', 'return x'),
      filename,
      output: body('const x = a + 1', '', 'return x'),
      errors: [{ message: 'blank line after the const group, before the return', line: 3 }],
    },
    {
      code: body('log(a)', 'return b'),
      filename,
      output: body('log(a)', '', 'return b'),
      errors: [{ message: 'blank line before return (unless it is the only statement of the block)' }],
    },
    {
      code: body('log(a)', 'if (b) {', '  log(b)', '}', 'log(a)'),
      filename,
      output: body('log(a)', '', 'if (b) {', '  log(b)', '}', '', 'log(a)'),
      errors: [{ message: 'blank line before the if block' }, { message: 'blank line after the if block' }],
    },
    {
      code: body(
        'let open = 0',
        'log(open)',
        'for (const flag of b) {',
        '  log(flag)',
        '}',
        '',
        'return open',
      ),
      filename,
      output: body(
        'let open = 0',
        'log(open)',
        '',
        'for (const flag of b) {',
        '  log(flag)',
        '}',
        '',
        'return open',
      ),
      errors: [{ message: 'blank line before the for…of block' }],
    },
    {
      code: body('log(a) // why', '// the loop', 'while (b) {', '  b = next(b)', '}'),
      filename,
      output: body('log(a) // why', '', '// the loop', 'while (b) {', '  b = next(b)', '}'),
      errors: [{ message: 'blank line before the while block', line: 4 }],
    },
    {
      code: body('try {', '  log(a)', '} finally {', '  log(b)', '}', 'return a'),
      filename,
      output: body('try {', '  log(a)', '} finally {', '  log(b)', '}', '', 'return a'),
      errors: [{ message: 'blank line before return (unless it is the only statement of the block)' }],
    },
    {
      code: body('log(a); if (b) {', '  log(b)', '}'),
      filename,
      output: 'export function run(a, b) {\n  log(a);\n\n  if (b) {\n    log(b)\n  }\n}',
      errors: 1,
    },
    {
      code: body('log(a); /* why */ if (b) {', '  log(b)', '}'),
      filename,
      output: 'export function run(a, b) {\n  log(a);\n\n  /* why */ if (b) {\n    log(b)\n  }\n}',
      errors: 1,
    },
  ],
});

const attachMessage = (name: string, block: string): string =>
  `no blank line between the one-line declaration of ${name} and the ${block} block that reads it`;

runRule('blank-line-around-blocks: attach rule', rule, {
  valid: [
    {
      code: asyncBody(
        'const item = find(a);',
        'if (item === undefined) {',
        '  return 0;',
        '}',
        '',
        'return item.size;',
      ),
      filename,
    },
    {
      code: asyncBody('const rows = await load(a);', 'for (const row of rows) {', '  log(row);', '}'),
      filename,
    },
    {
      code: asyncBody('let count = 0;', 'while (count < a) {', '  count += 1;', '}', '', 'return count;'),
      filename,
    },
    {
      code: asyncBody('log(a);', 'const kind = a.kind;', 'switch (kind) {', '  case 1:', '    log(b);', '}'),
      filename,
    },
    { code: asyncBody('const x = a + 1;', '', 'if (b) {', '  log(b);', '}', '', 'return x;'), filename },
    {
      code: asyncBody('const options = {', '  a,', '};', '', 'if (options.a) {', '  log(b);', '}'),
      filename,
    },
    { code: asyncBody('const x = a;', '', 'try {', '  log(x);', '} catch {', '  log(b);', '}'), filename },
  ],
  invalid: [
    {
      code: asyncBody(
        'const item = find(a);',
        '',
        'if (item === undefined) {',
        '  return 0;',
        '}',
        '',
        'return item.size;',
      ),
      filename,
      output: asyncBody(
        'const item = find(a);',
        'if (item === undefined) {',
        '  return 0;',
        '}',
        '',
        'return item.size;',
      ),
      errors: [{ message: attachMessage('item', 'if'), line: 4 }],
    },
    {
      code: asyncBody('const rows = await load(a);', '', 'for (const row of rows) {', '  log(row);', '}'),
      filename,
      output: asyncBody('const rows = await load(a);', 'for (const row of rows) {', '  log(row);', '}'),
      errors: [{ message: attachMessage('rows', 'for…of') }],
    },
    {
      code: asyncBody('log(a);', 'const total = sum(b);', '', 'while (total > a) {', '  a += 1;', '}'),
      filename,
      output: asyncBody('log(a);', 'const total = sum(b);', 'while (total > a) {', '  a += 1;', '}'),
      errors: [{ message: attachMessage('total', 'while') }],
    },
    {
      code: asyncBody('const kind = a.kind;', '', '', 'switch (kind) {', '  case 1:', '    log(b);', '}'),
      filename,
      output: asyncBody('const kind = a.kind;', 'switch (kind) {', '  case 1:', '    log(b);', '}'),
      errors: [{ message: attachMessage('kind', 'switch') }],
    },
    {
      code: asyncBody('const first = a;', '', 'const second = b;', '', 'if (second) {', '  log(first);', '}'),
      filename,
      output: asyncBody('const first = a;', '', 'const second = b;', 'if (second) {', '  log(first);', '}'),
      errors: [{ message: attachMessage('second', 'if') }],
    },
  ],
});

runRule('blank-line-around-blocks: await groups', rule, {
  valid: [
    { code: asyncBody('await open(a);', 'await write(b);', 'await close(a);'), filename },
    { code: asyncBody('const user = await load(a);', 'await save(user);', 'log(user);'), filename },
    { code: asyncBody('log(a);', '', 'await send(', '  a,', '  b,', ');', '', 'log(b);'), filename },
    { code: asyncBody('await send(', '  a,', ');', '', 'await done(b);'), filename },
    { code: asyncBody('register(async () => {', '  await a();', '});', 'log(b);'), filename },
  ],
  invalid: [
    {
      code: asyncBody('await open(a);', '', 'await write(b);'),
      filename,
      output: asyncBody('await open(a);', 'await write(b);'),
      errors: [{ message: 'no blank line inside a run of one-line await statements (one group)', line: 4 }],
    },
    {
      code: asyncBody('const user = await load(a);', '', 'await save(user);'),
      filename,
      output: asyncBody('const user = await load(a);', 'await save(user);'),
      errors: 1,
    },
    {
      code: asyncBody('log(a);', 'await send(', '  a,', ');'),
      filename,
      output: asyncBody('log(a);', '', 'await send(', '  a,', ');'),
      errors: [
        { message: 'blank line around a multi-line await statement (it is its own paragraph)', line: 3 },
      ],
    },
    {
      code: asyncBody('const result = await send(', '  a,', ');', 'log(result);'),
      filename,
      output: asyncBody('const result = await send(', '  a,', ');', '', 'log(result);'),
      errors: 1,
    },
    {
      code: asyncBody('await open(a);', 'await send(', '  b,', ');'),
      filename,
      output: asyncBody('await open(a);', '', 'await send(', '  b,', ');'),
      errors: 1,
    },
  ],
});

runRule('blank-line-around-blocks: two or more declarations keep the group blank line', rule, {
  valid: [
    {
      code: asyncBody(
        'const first = a;',
        'const second = b;',
        '',
        'if (first === second) {',
        '  log(a);',
        '}',
      ),
      filename,
    },
    {
      code: asyncBody(
        'const [head] = a;',
        'let rest = b;',
        '',
        'for (const item of rest) {',
        '  log(head, item);',
        '}',
      ),
      filename,
    },
    {
      code: asyncBody(
        'const left = await load(a);',
        'const right = await load(b);',
        '',
        'if (left === right) {',
        '  log(a);',
        '}',
      ),
      filename,
    },
    { code: asyncBody('const first = a;', 'const second = b;', '', 'return first + second;'), filename },
  ],
  invalid: [
    {
      code: asyncBody('const first = a;', 'const second = b;', 'if (first === second) {', '  log(a);', '}'),
      filename,
      output: asyncBody(
        'const first = a;',
        'const second = b;',
        '',
        'if (first === second) {',
        '  log(a);',
        '}',
      ),
      errors: [{ message: 'blank line after the const group, before the if', line: 4 }],
    },
    {
      code: asyncBody(
        'let head = a;',
        'let rest = b;',
        'for (const item of rest) {',
        '  log(head, item);',
        '}',
      ),
      filename,
      output: asyncBody(
        'let head = a;',
        'let rest = b;',
        '',
        'for (const item of rest) {',
        '  log(head, item);',
        '}',
      ),
      errors: [{ message: 'blank line after the let group, before the for…of' }],
    },
    {
      code: asyncBody(
        'const left = await load(a);',
        'const right = await load(b);',
        'if (left === right) {',
        '  log(a);',
        '}',
      ),
      filename,
      output: asyncBody(
        'const left = await load(a);',
        'const right = await load(b);',
        '',
        'if (left === right) {',
        '  log(a);',
        '}',
      ),
      errors: 1,
    },
    {
      code: asyncBody(
        'const left = await load(a);',
        '',
        'const right = await load(b);',
        '',
        'if (right) {',
        '  log(left);',
        '}',
      ),
      filename,
      output: asyncBody(
        'const left = await load(a);',
        'const right = await load(b);',
        '',
        'if (right) {',
        '  log(left);',
        '}',
      ),
      errors: [{ message: 'no blank line inside a run of one-line await statements (one group)' }],
    },
  ],
});
