import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';

import { forwardedExecArgv } from '../src/relaunch.ts';
import { launch, postJson, startDev, waitUntil, type Launched } from './dev-helpers.ts';
import { contextMd, makeApp, murmur } from './helpers.ts';

const CALC = [
  'function tag(value: unknown, context: DecoratorContext) {',
  '  return undefined',
  '}',
  '',
  '@tag',
  'export class Calc {',
  '  @tag',
  '  add(a: number, b: number): number {',
  '    return a + b',
  '  }',
  '',
  '  @tag',
  '  unused(a: number): number {',
  '    if (a > 0) {',
  '      return a * 2',
  '    }',
  '',
  '    return -a',
  '  }',
  '}',
  '',
].join('\n');

const UNCOVERED_BODY = [14, 15, 16, 17, 18, 19];

const CALC_TEST = [
  "import assert from 'node:assert/strict'",
  "import { test } from 'node:test'",
  '',
  "import { Calc } from './calc.ts'",
  '',
  'function named(label: string) {',
  '  return (_value: unknown, context: ClassMethodDecoratorContext) => {',
  '    context.metadata[String(context.name)] = label',
  '  }',
  '}',
  '',
  'class Probe {',
  "  @named('probe.run')",
  '  run(): number {',
  '    return new Calc().add(2, 3)',
  '  }',
  '}',
  '',
  "test('adds through a decorated class', () => {",
  '  assert.equal(new Calc().add(2, 3), 5)',
  '})',
  '',
  "test('a decorator inside the test file records metadata', () => {",
  "  const metadata = (Probe as unknown as Record<symbol, Record<string, unknown>>)[Symbol.metadata ?? Symbol.for('Symbol.metadata')]",
  '',
  "  assert.equal(metadata?.['run'], 'probe.run')",
  '  assert.equal(new Probe().run(), 5)',
  '})',
  '',
].join('\n');

const HELLO_FILES: Readonly<Record<string, string>> = {
  'contracts/hello.ts': [
    "import { Query } from 'murmur'",
    "import { z } from 'zod'",
    '',
    "export class HelloAsked extends Query({ name: z.string() }, { text: z.string() }, { name: 'hello.asked' }) {}",
    '',
  ].join('\n'),
  'pieces/hello/context.md': contextMd('hello', 'Greets through a decorated helper class.'),
  'pieces/hello/greeter.ts': [
    'const greetings: string[] = []',
    '',
    'function greeting(_value: unknown, context: ClassMethodDecoratorContext): void {',
    '  greetings.push(String(context.name))',
    '}',
    '',
    'export class Greeter {',
    '  @greeting',
    '  greet(name: string): string {',
    "    return `hello ${name} via ${greetings.join(',')}`",
    '  }',
    '}',
    '',
  ].join('\n'),
  'pieces/hello/piece.ts': [
    "import { Handle, Piece } from 'murmur'",
    '',
    "import { HelloAsked } from '#contracts/hello'",
    '',
    "import { Greeter } from './greeter.ts'",
    '',
    'const greeter = new Greeter()',
    '',
    'export class Hello extends Piece() {',
    '  @Handle(HelloAsked)',
    '  async greet(input: HelloAsked): Promise<{ text: string }> {',
    '    return { text: greeter.greet(input.name) }',
    '  }',
    '}',
    '',
  ].join('\n'),
  'pieces/hello/calc.ts': CALC,
  'pieces/hello/calc.test.ts': CALC_TEST,
};

interface TestJson {
  readonly passed: number;
  readonly failed: number;
  readonly failures: unknown[];
  readonly coverage?: { file: string; uncoveredLines: number[] }[];
}

interface DoctorJson {
  readonly ok: boolean;
  readonly packages: Record<string, string | null>;
  readonly transformer: {
    name: string;
    package: string;
    version: string;
    binary: string | null;
    registerUrl: string;
    works: boolean;
    error: string | null;
  };
}

const outside = tmpdir();

describe('murmur test through the loader', () => {
  test('--coverage reports only the body of the unused decorated method as uncovered', () => {
    using app = makeApp(HELLO_FILES);
    const result = murmur(['test', '--coverage', '--cwd', app.root], { cwd: outside });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /calc\.ts\s+\|[^\n]*\|\s*14-19\s*$/m);
    assert.doesNotMatch(result.stdout, /calc\.test\.ts\s+\|/);
  });

  test('--json from a cwd outside the app runs decorated tests green', () => {
    using app = makeApp(HELLO_FILES);
    const result = murmur(['test', '--json', '--cwd', app.root], { cwd: outside });
    const json = result.json<TestJson>();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(json.passed, 2);
    assert.equal(json.failed, 0);
    assert.equal(json.coverage, undefined);
  });

  test('--json --coverage lists the uncovered lines per piece file', () => {
    using app = makeApp(HELLO_FILES);
    const json = murmur(['test', '--json', '--coverage', '--cwd', app.root], {
      cwd: outside,
    }).json<TestJson>();

    assert.deepEqual(
      json.coverage?.map(({ file, uncoveredLines }) => ({ file, uncoveredLines })),
      [{ file: 'pieces/hello/calc.ts', uncoveredLines: UNCOVERED_BODY }],
    );
  });

  test('MURMUR_TRANSFORM=esbuild has the known coverage gap: decorator lines read as uncovered', () => {
    using app = makeApp(HELLO_FILES);
    const json = murmur(['test', '--json', '--coverage', '--cwd', app.root], {
      cwd: outside,
      env: { MURMUR_TRANSFORM: 'esbuild' },
    }).json<TestJson>();

    assert.deepEqual(json.coverage?.[0]?.uncoveredLines, [7, 12, 13, ...UNCOVERED_BODY, 20]);
  });

  test('with no target it also runs lib/**/*.test.ts', () => {
    using app = makeApp({
      ...HELLO_FILES,
      'lib/text.ts': 'export function shout(text: string): string {\n  return text.toUpperCase()\n}\n',
      'lib/text.test.ts': [
        "import assert from 'node:assert/strict'",
        "import { test } from 'node:test'",
        '',
        "import { shout } from './text.ts'",
        '',
        "test('shouts', () => {",
        "  assert.equal(shout('hi'), 'HI')",
        '})',
        '',
      ].join('\n'),
    });
    const result = murmur(['test', '--json', '--cwd', app.root], { cwd: outside });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json<TestJson>().passed, 3);
  });

  test('MURMUR_TRANSFORM=esbuild runs the same decorated tests green', () => {
    using app = makeApp(HELLO_FILES);
    const result = murmur(['test', '--json', '--cwd', app.root], {
      cwd: outside,
      env: { MURMUR_TRANSFORM: 'esbuild' },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json<TestJson>().passed, 2);
  });
});

const HEAP_FLAG = '--max-old-space-size=300';

const START_FILES: Readonly<Record<string, string>> = {
  ...HELLO_FILES,
  'pieces/hello/greeter.ts': `console.log('app execArgv', process.execArgv.join(' '))\n\n${HELLO_FILES['pieces/hello/greeter.ts']}`,
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function startedPid(start: Launched): Promise<number> {
  return waitUntil(() => {
    const pid = /murmur start {2}pieces=1 {2}pid=(\d+)/.exec(start.output())?.[1];

    return pid === undefined ? undefined : Number(pid);
  });
}

function killStart(start: Launched): void {
  const pid = /pid=(\d+)/.exec(start.output())?.[1];

  start.child.kill('SIGKILL');

  if (pid !== undefined && isAlive(Number(pid))) {
    process.kill(Number(pid), 'SIGKILL');
  }
}

describe('relaunch', () => {
  test('forwards the CLI node flags except the inspector, whose port the parent holds', () => {
    assert.deepEqual(
      forwardedExecArgv([
        '--max-old-space-size=4096',
        '--inspect=9229',
        '--inspect-port',
        '9230',
        '--stack-size=2000',
      ]),
      ['--max-old-space-size=4096', '--stack-size=2000'],
    );
    assert.deepEqual(forwardedExecArgv(['--inspect-brk', '--enable-source-maps']), ['--enable-source-maps']);
  });
});

describe('app processes run through the loader', () => {
  test('the describe worker imports a piece whose private file is decorated', () => {
    using app = makeApp(HELLO_FILES);
    const result = murmur(['catalog', '--json', '--cwd', app.root], { cwd: outside });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /"hello\.asked"/);
    assert.doesNotMatch(result.stdout, /SyntaxError/);
  });

  test(
    'murmur start boots a decorated app in a child that keeps the CLI node flags and stops on SIGTERM',
    { timeout: 30_000 },
    async (t) => {
      using app = makeApp(START_FILES);
      const start = launch(['start', '--cwd', app.root], outside, { nodeArgs: [HEAP_FLAG] });

      t.after(() => killStart(start));

      await startedPid(start);
      start.child.kill('SIGTERM');

      assert.equal(await start.exited, 0, start.output());
      assert.match(start.output(), new RegExp(`app execArgv .*${HEAP_FLAG}`));
    },
  );

  test('the murmur start app child stops when its parent is killed', { timeout: 30_000 }, async (t) => {
    using app = makeApp(START_FILES);
    const start = launch(['start', '--cwd', app.root], outside);

    t.after(() => killStart(start));

    const pid = await startedPid(start);

    start.child.kill('SIGKILL');

    await waitUntil(() => (isAlive(pid) ? undefined : true));
  });

  test('murmur dev boots a decorated app and answers through it', { timeout: 30_000 }, async (t) => {
    using app = makeApp(HELLO_FILES);
    const dev = await startDev(app.root);
    t.after(() => dev.child.kill('SIGKILL'));

    const reply = await waitUntil(async () => {
      const response = await postJson(`${dev.base}/api/emit`, {
        contract: 'hello.asked',
        payload: { name: 'ada' },
        mode: 'request',
      });

      return response.status === 200 ? response.body : undefined;
    });

    assert.deepEqual(reply['reply'], { text: 'hello ada via greet' });
    dev.child.kill('SIGTERM');
    await dev.exited;
  });
});

describe('murmur doctor', () => {
  test('names the transformer, its package version, its platform binary, the register URL and zod', () => {
    using app = makeApp({});
    const json = murmur(['doctor', '--json', '--cwd', app.root], { cwd: outside }).json<DoctorJson>();

    assert.equal(json.transformer.name, 'swc');
    assert.equal(json.transformer.package, '@swc/core');
    assert.equal(json.transformer.version, '1.16.20');
    assert.match(json.transformer.binary ?? '', /^@swc\/core-[\w-]+ 1\.16\.20$/);
    assert.equal(json.transformer.works, true, json.transformer.error ?? '');
    assert.match(json.transformer.registerUrl, /^file:\/\/.*\/register\/index\.ts\?root=/);
    assert.equal(json.packages['zod'], '4.6.7');
  });

  test('follows MURMUR_TRANSFORM and reports an unknown transformer as a failure', () => {
    using app = makeApp({});
    const esbuild = murmur(['doctor', '--json', '--cwd', app.root], {
      cwd: outside,
      env: { MURMUR_TRANSFORM: 'esbuild' },
    });
    const unknown = murmur(['doctor', '--json', '--cwd', app.root], {
      cwd: outside,
      env: { MURMUR_TRANSFORM: 'oxc' },
    });

    assert.equal(esbuild.json<DoctorJson>().transformer.name, 'esbuild');
    assert.equal(esbuild.json<DoctorJson>().transformer.works, true);
    assert.match(esbuild.json<DoctorJson>().transformer.binary ?? '', /^@esbuild\/[\w-]+ 0\.28\.2$/);
    assert.equal(unknown.status, 1);
    assert.match(unknown.json<DoctorJson>().transformer.error ?? '', /MURMUR_TRANSFORM=oxc/);
  });
});
