import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import plugin from '@murmur/lint';

import { appConfig, contextMd, makeApp, murmur, repoRoot, TODO_CONTRACTS, writeFiles } from './helpers.ts';

type Finding = {
  rule: string;
  severity: 'error' | 'warn';
  file: string;
  line: number;
  col: number;
  message: string;
  help?: string;
};
type CheckJson = { kind: string; ok: boolean; findings: Finding[]; summary: Record<string, number | null> };

function check(root: string, args: readonly string[] = []) {
  return murmur(['check', '--json', ...args, '--cwd', root]);
}

function rules(json: CheckJson, file?: string): string[] {
  return json.findings.filter((f) => file === undefined || f.file === file).map((f) => f.rule);
}

function lint(root: string): void {
  const oxlint = spawnSync(join(repoRoot, 'node_modules/.bin/oxlint'), [], { cwd: root, encoding: 'utf8' });
  assert.equal(oxlint.status, 0, oxlint.stdout + oxlint.stderr);
  const oxfmt = spawnSync(join(repoRoot, 'node_modules/.bin/oxfmt'), ['--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(oxfmt.status, 0, oxfmt.stdout + oxfmt.stderr);
}

function contractImport(contracts: readonly string[]): string {
  const inline = `import { ${contracts.join(', ')} } from '#contracts/fat';`;

  return inline.length <= 110
    ? inline
    : `import {\n${contracts.map((c) => `  ${c},`).join('\n')}\n} from '#contracts/fat';`;
}

function handlerPiece(name: string, contracts: readonly string[]): string {
  const handlers = contracts.flatMap((c, i) => [
    ...(i === 0 ? [] : ['']),
    `  @Handle(${c})`,
    `  async on${c}(event: ${c}): Promise<void> {`,
    "    this.log.info('seen', { event });",
    '  }',
  ]);

  return [
    "import { Handle, Piece } from 'murmur';",
    '',
    contractImport(contracts),
    '',
    `export class ${name} extends Piece() {`,
    ...handlers,
    '}',
    '',
  ].join('\n');
}

function fatContracts(count: number): string {
  const lines = Array.from(
    { length: count },
    (_, i) => `export class C${i} extends Event({ n: z.number() }, { name: 'fat.c${i}.happened' }) {}`,
  );

  return ["import { Event } from 'murmur';", "import { z } from 'zod';", '', ...lines, ''].join('\n');
}

const BAD_PIECE = [
  "import { Handle, Piece } from 'murmur';",
  '',
  "import { TodoAudited, TodoCreated } from '#contracts/todos';",
  '',
  'export class Bad extends Piece() {',
  '  @Handle(TodoCreated)',
  '  async created(event: TodoCreated): Promise<void> {',
  "    this.log.info('token', { token: process.env.TOKEN });",
  '    await this.emit(TodoAudited, { id: event.id });',
  '  }',
  '}',
  '',
].join('\n');

const UNDECLARED_EMIT = BAD_PIECE.replace(
  "    this.log.info('token', { token: process.env.TOKEN });\n",
  "    this.log.info('created', { id: event.id });\n",
);

const ORDER_CONTRACTS = [
  "import { Command, Event } from 'murmur';",
  "import { z } from 'zod';",
  '',
  'export class OrdersPlaceRequested extends Command(',
  '  {',
  '    sku: z.string(),',
  '    quantity: z.int().positive(),',
  '    gift: z.boolean(),',
  '    notes: z.array(z.string()),',
  '    shipTo: z.object({ city: z.string(), zip: z.string().length(5) }),',
  '  },',
  '  { orderId: z.uuid(), total: z.number(), lines: z.array(z.object({ sku: z.string() })) },',
  "  { name: 'orders.place.requested' },",
  ') {}',
  '',
  'export class OrdersPlaced extends Event(',
  '  { orderId: z.string(), express: z.boolean() },',
  "  { name: 'orders.placed' },",
  ') {}',
  '',
].join('\n');

const GREETING_CONTRACTS = [
  "import { Query } from 'murmur';",
  "import { z } from 'zod';",
  '',
  'export class GreetingsRequested extends Query(',
  '  { name: z.string() },',
  '  { text: z.string() },',
  "  { name: 'greetings.requested' },",
  ') {}',
  '',
  'export class GreetingsComposeRequested extends Query(',
  '  { name: z.string() },',
  '  { text: z.string() },',
  "  { name: 'greetings.compose.requested' },",
  ') {}',
  '',
].join('\n');

function scaffolded(root: string, id: string, args: readonly string[]): void {
  const created = murmur(['new', 'piece', id, ...args, '--cwd', root]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const checked = check(root);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  lint(root);
  const tested = murmur(['test', id, '--cwd', root]);
  assert.equal(tested.status, 0, tested.stdout + tested.stderr);
}

describe('murmur new piece + check + test + lint', () => {
  test('a responder scaffold with emits, needs and config passes check, test and lint', () => {
    using app = makeApp({ 'contracts/todos.ts': TODO_CONTRACTS, 'pieces/context.md': contextMd('pieces') });
    scaffolded(app.root, 'stats/count', [
      '--handles',
      'TodoCountRequested',
      '--emits',
      'TodoAudited',
      '--needs',
      'db=sqlite',
      '--config',
      'limit:number,base:url',
      '--summary',
      'Counts todos.',
    ]);
    assert.match(
      readFileSync(join(app.root, 'pieces/stats/count/piece.ts'), 'utf8'),
      /await this\.emit\(TodoAudited, \{ id: 'example' \}\)/,
    );
    const tested = murmur(['test', 'stats/count', '--json', '--cwd', app.root]);
    const summary = tested.json<{ passed: number; failed: number }>();
    assert.deepEqual([summary.passed, summary.failed], [1, 0]);
  });

  test('samples follow the contract types: fixture, emit and reply stubs carry typed values and stay green', () => {
    using app = makeApp({ 'contracts/orders.ts': ORDER_CONTRACTS, 'pieces/context.md': contextMd('pieces') });
    scaffolded(app.root, 'orders/place', ['--handles', 'OrdersPlaceRequested', '--emits', 'OrdersPlaced']);
    const dir = join(app.root, 'pieces/orders/place');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fixtures/orders-place-requested.json'), 'utf8')), {
      sku: 'example',
      quantity: 1,
      gift: true,
      notes: [],
      shipTo: { city: 'example', zip: 'examp' },
    });
    const source = readFileSync(join(dir, 'piece.ts'), 'utf8');
    assert.match(source, /await this\.emit\(OrdersPlaced, \{ orderId: 'example', express: true \}\)/);
    assert.match(
      source,
      /return \{ orderId: '00000000-0000-4000-8000-000000000000', total: 1, lines: \[\] \}/,
    );
  });

  test('a listener scaffold with --emits emits every declared contract and its test is green', () => {
    using app = makeApp({ 'contracts/todos.ts': TODO_CONTRACTS, 'pieces/context.md': contextMd('pieces') });
    scaffolded(app.root, 'audit/log', ['--handles', 'TodoCreated', '--emits', 'TodoAudited']);
  });

  test('--emits of a query scaffolds this.request and a responder stub that keep the test green', () => {
    using app = makeApp({
      'contracts/greetings.ts': GREETING_CONTRACTS,
      'pieces/context.md': contextMd('pieces'),
    });
    scaffolded(app.root, 'greetings/greeter', [
      '--handles',
      'GreetingsRequested',
      '--emits',
      'GreetingsComposeRequested',
    ]);
    const dir = join(app.root, 'pieces/greetings/greeter');
    assert.match(
      readFileSync(join(dir, 'piece.ts'), 'utf8'),
      /await this\.request\(GreetingsComposeRequested, /,
    );
    assert.match(
      readFileSync(join(dir, 'piece.test.ts'), 'utf8'),
      /t\.respond\(GreetingsComposeRequested, \(\) => \(\{ text: 'example' \}\)\)/,
    );
    assert.match(readFileSync(join(dir, 'context.md'), 'utf8'), /- requests `greetings\.compose\.requested`/);
  });

  test('new piece on an existing piece exits 1, an unknown contract exits 2 with a hint', () => {
    using app = makeApp({ 'contracts/todos.ts': TODO_CONTRACTS });
    assert.equal(murmur(['new', 'piece', 'x', '--cwd', app.root]).status, 0);
    assert.equal(murmur(['new', 'piece', 'x', '--cwd', app.root]).status, 1);
    const unknown = murmur(['new', 'piece', 'y', '--handles', 'Nope', '--cwd', app.root]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /murmur new contract Nope --domain <file> --kind query/);
    assert.equal(existsSync(join(app.root, 'pieces/y')), false);
  });

  test('new contract takes a PascalCase class name; a dotted wire name exits 2', () => {
    using app = makeApp({ 'contracts/todos.ts': TODO_CONTRACTS });
    const dotted = murmur(['new', 'contract', 'todos.renamed', '--domain', 'todos', '--cwd', app.root]);
    assert.equal(dotted.status, 2);
    assert.match(dotted.stderr, /a contract class name is PascalCase, like GetTodo/);
  });
});

describe('murmur check', () => {
  test('finds an undeclared this.emit (structure) with exit 1 and valid --json', () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'pieces/bad/context.md': contextMd('bad'),
      'pieces/bad/piece.ts': BAD_PIECE,
    });
    const result = check(app.root);
    assert.equal(result.status, 1);
    const json = result.json<CheckJson>();
    assert.equal(json.kind, 'check');
    assert.equal(json.ok, false);
    const emit = json.findings.find((f) => f.rule === 'emit-undeclared');
    assert.deepEqual([emit?.file, emit?.line, emit?.severity], ['pieces/bad/piece.ts', 9, 'error']);
    assert.match(
      emit?.message ?? '',
      /this\.emit\(TodoAudited\) but TodoAudited is not in the emits of Piece\(\{ … \}\)/,
    );
    assert.equal(typeof json.summary['structure'], 'number');
    assert.equal(json.summary['types'], null);
  });

  test('an undeclared this.emit is one finding although structure and boundaries both detect it', () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'pieces/bad/context.md': contextMd('bad'),
      'pieces/bad/piece.ts': UNDECLARED_EMIT,
    });
    const result = check(app.root);
    assert.equal(result.status, 1);
    const json = result.json<CheckJson>();
    const emits = json.findings.filter((f) => ['emit-undeclared', 'murmur/emit-declared'].includes(f.rule));
    assert.deepEqual(
      emits.map((f) => [f.rule, f.file, f.line]),
      [['emit-undeclared', 'pieces/bad/piece.ts', 9]],
    );
    const human = murmur(['check', '--cwd', app.root]);
    assert.equal(human.stdout.match(/piece\.ts:9:/g)?.length, 1, human.stdout);
  });

  const hasProcessEnvRule = Object.keys(plugin.rules).includes('no-process-env');
  test(
    'finds a process.env through the boundaries step (murmur/no-process-env)',
    { skip: hasProcessEnvRule ? false : 'murmur/no-process-env ships with M5 (@murmur/lint rules)' },
    () => {
      using app = makeApp({
        'contracts/todos.ts': TODO_CONTRACTS,
        'pieces/bad/context.md': contextMd('bad'),
        'pieces/bad/piece.ts': BAD_PIECE,
      });
      const json = check(app.root).json<CheckJson>();
      const env = json.findings.find((f) => f.rule === 'murmur/no-process-env');
      assert.deepEqual([env?.file, env?.line, env?.severity], ['pieces/bad/piece.ts', 8, 'error']);
      assert.ok((json.summary['lint'] ?? 0) >= 1);
    },
  );

  test('the boundaries step runs the app-facing style rules curly and no-unused-expressions', () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'pieces/bad/context.md': contextMd('bad'),
      'pieces/bad/piece.ts': BAD_PIECE,
      'pieces/bad/clamp.ts':
        'export function clamp(n: number): number {\n  if (n < 0) return 0;\n\n  return n;\n}\n\nexport function touch(flag: boolean): void {\n  flag && clamp(1);\n}\n',
    });
    const json = check(app.root).json<CheckJson>();
    const style = json.findings.filter((f) => f.file === 'pieces/bad/clamp.ts').map((f) => [f.rule, f.line]);
    assert.deepEqual(style, [
      ['eslint/curly', 2],
      ['eslint/no-unused-expressions', 8],
    ]);
  });

  test('sizing caps are warnings: 21 handlers, a 1501-line private file, a 121-line context.md', () => {
    const fat = Array.from({ length: 21 }, (_, i) => `C${i}`);
    using app = makeApp({
      'contracts/fat.ts': fatContracts(22),
      'pieces/fat/context.md': `${contextMd('fat')}\n${'line\n'.repeat(121 - 6)}`,
      'pieces/fat/piece.ts': handlerPiece('Fat', fat),
      'pieces/fat/helpers.ts':
        Array.from({ length: 1501 }, (_, i) => `export const a${i} = ${i};`).join('\n') + '\n',
      'pieces/thin/context.md': contextMd('thin'),
      'pieces/thin/piece.ts': handlerPiece('Thin', ['C21']),
    });
    const result = check(app.root);
    assert.equal(result.status, 0, result.stdout);
    const json = result.json<CheckJson>();
    const sizing = json.findings.filter((f) =>
      ['too-many-handlers', 'piece-too-long', 'context-too-long'].includes(f.rule),
    );
    assert.deepEqual(sizing.map((f) => [f.rule, f.severity, f.file]).toSorted(), [
      ['context-too-long', 'warn', 'pieces/fat/context.md'],
      ['piece-too-long', 'warn', 'pieces/fat/piece.ts'],
      ['too-many-handlers', 'warn', 'pieces/fat/piece.ts'],
    ]);
    const handlers = sizing.find((f) => f.rule === 'too-many-handlers');
    const link = /21 handlers \(cap 20\); see (\S+)$/.exec(handlers?.message ?? '');
    assert.ok(link !== null, String(handlers?.message));
    assert.ok(existsSync(resolve(app.root, link[1] as string)), String(link[1]));
    const help = /heuristics in (\S+)$/.exec(handlers?.help ?? '');
    assert.ok(help !== null && existsSync(resolve(app.root, help[1] as string)), String(handlers?.help));
    assert.match(
      sizing.find((f) => f.rule === 'piece-too-long')?.message ?? '',
      /\d{4} source lines \(cap 1500\)/,
    );
    assert.match(sizing.find((f) => f.rule === 'context-too-long')?.message ?? '', /121 lines \(cap 120\)/);
    writeFiles(app.root, { 'murmur.config.ts': appConfig(', limits: { handlers: 24 }') });
    const relaxed = check(app.root).json<CheckJson>();
    assert.deepEqual(
      rules(relaxed).filter((r) => r === 'too-many-handlers'),
      [],
    );
    assert.ok(rules(relaxed).includes('piece-too-long'));
  });

  test('flags a piece.test.ts in a folder without piece.ts', () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'pieces/grp/context.md': contextMd('grp'),
      'pieces/grp/piece.test.ts': "import { test } from 'node:test'\n\ntest('stray', () => {})\n",
    });
    const result = check(app.root);
    assert.equal(result.status, 1);
    const stray = result.json<CheckJson>().findings.find((f) => f.file === 'pieces/grp/piece.test.ts');
    assert.equal(stray?.rule, 'group-folder-files');
    assert.match(
      stray?.message ?? '',
      /piece\.test\.ts needs a piece\.ts beside it; a subtree test is scenario\.test\.ts/,
    );
  });

  test('check --changed includes an untracked new piece and leaves committed pieces out', () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'pieces/old/context.md': contextMd('old'),
      'pieces/old/piece.ts': UNDECLARED_EMIT,
    });
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: app.root });
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'init');
    writeFiles(app.root, {
      'pieces/fresh/context.md': contextMd('fresh'),
      'pieces/fresh/piece.ts': UNDECLARED_EMIT,
    });
    const json = check(app.root, ['--changed']).json<CheckJson>();
    const files = json.findings.filter((f) => f.rule === 'emit-undeclared').map((f) => f.file);
    assert.deepEqual(files, ['pieces/fresh/piece.ts']);
    const everything = check(app.root).json<CheckJson>();
    assert.deepEqual(
      everything.findings
        .filter((f) => f.rule === 'emit-undeclared')
        .map((f) => f.file)
        .toSorted(),
      ['pieces/fresh/piece.ts', 'pieces/old/piece.ts'],
    );
  });
});

describe('murmur test', () => {
  test('test <group> runs the group scenario.test.ts plus descendant piece tests', () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'pieces/grp/context.md': contextMd('grp'),
      'pieces/grp/scenario.test.ts':
        "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\n\ntest('grp scenario', () => assert.fail('scenario ran'))\n",
      'pieces/grp/child/context.md': contextMd('grp/child'),
      'pieces/grp/child/piece.ts':
        "import { Piece } from 'murmur';\n\nexport class Child extends Piece() {}\n",
      'pieces/grp/child/piece.test.ts': "import { test } from 'node:test'\n\ntest('child unit', () => {})\n",
      'pieces/other/context.md': contextMd('other'),
      'pieces/other/piece.ts': "import { Piece } from 'murmur';\n\nexport class Other extends Piece() {}\n",
      'pieces/other/piece.test.ts':
        "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\n\ntest('other unit', () => assert.fail('other ran'))\n",
    });
    const result = murmur(['test', 'grp', '--json', '--cwd', app.root]);
    assert.equal(result.status, 1);
    const json = result.json<{
      kind: string;
      passed: number;
      failed: number;
      failures: { name: string; file: string; message: string }[];
    }>();
    assert.equal(json.kind, 'test');
    assert.equal(json.passed, 1);
    assert.deepEqual(
      json.failures.map((f) => [f.name, f.file.endsWith('pieces/grp/scenario.test.ts'), f.message]),
      [['grp scenario', true, 'scenario ran']],
    );
    assert.equal(murmur(['test', 'grp/child', '--cwd', app.root]).status, 0);
  });
});

describe('murmur CLI', () => {
  test('an unknown command exits 2', () => {
    assert.equal(murmur(['bogus']).status, 2);
    assert.equal(murmur(['catalog', '--bogus-flag']).status, 2);
  });
});
