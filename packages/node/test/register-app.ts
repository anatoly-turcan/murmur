import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TRANSFORMERS = ['swc', 'esbuild'] as const;

export const REGISTER_FILE = join(import.meta.dirname, '..', 'src', 'register', 'index.ts');

export const STACK_THROW_LINE = 9;

const MAIN = `const seen: string[] = []

function handle(name: string) {
  return (_value: unknown, context: ClassMethodDecoratorContext) => {
    context.metadata[String(context.name)] = name
    context.addInitializer(() => seen.push(name))
  }
}

class Todos {
  @handle('todos.CreateTodo')
  create(title: string): string {
    return title.toUpperCase()
  }
}

const metadata = (Todos as unknown as Record<symbol, Record<string, unknown>>)[
  Symbol.metadata ?? Symbol.for('Symbol.metadata')
]

console.log(JSON.stringify({ result: new Todos().create('milk'), metadata, seen }))
`;

const STACK = `function traced(_value: unknown, _context: ClassMethodDecoratorContext) {}

class Thrower {
  @traced
  run(items: readonly string[]): number {
    const length = items.length

    if (length > 0) {
      throw new Error(\`boom (\${length})\`)
    }

    return length
  }
}

new Thrower().run(['a', 'b', 'c'])
`;

const JSON_TEST = `import assert from 'node:assert/strict'
import { test } from 'node:test'

import fixture from './fixture.json' with { type: 'json' }

test('a json import with attributes loads', () => {
  assert.deepEqual(fixture, { title: 'milk' })
})
`;

const DISPOSAL_TEST = `import assert from 'node:assert/strict'
import { test } from 'node:test'

function resource(name: string, log: string[], failure?: string): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      log.push(name)

      if (failure !== undefined) {
        throw new Error(failure)
      }
    },
  }
}

test('await using disposes in reverse order', async () => {
  const log: string[] = []

  {
    await using first = resource('first', log)
    await using second = resource('second', log)
    log.push(\`body \${first === second}\`)
  }

  assert.deepEqual(log, ['body false', 'second', 'first'])
})

test('a dispose that throws after the body threw surfaces SuppressedError', async () => {
  const log: string[] = []
  const body = async (): Promise<void> => {
    await using held = resource('held', log, 'dispose failed')
    log.push(\`body \${held !== undefined}\`)
    throw new Error('body failed')
  }
  const error = await body().catch((caught: unknown) => caught)

  assert.ok(error instanceof SuppressedError, String(error))
  assert.equal((error.error as Error).message, 'dispose failed')
  assert.equal((error.suppressed as Error).message, 'body failed')
  assert.deepEqual(log, ['body true', 'held'])
})
`;

const ENUM = `enum Color {
  Red,
  Green,
}

class Point {
  constructor(private readonly x: number) {}

  plus(y: number): number {
    return this.x + y
  }
}

console.log(Color.Green, new Point(1).plus(2))
`;

const MODULE_MTS = `function named(_value: unknown, context: ClassDecoratorContext) {
  context.metadata['kind'] = 'mts'
}

@named
class Marked {}

console.log(JSON.stringify((Marked as unknown as Record<symbol, unknown>)[Symbol.metadata ?? Symbol.for('Symbol.metadata')]))
`;

export const DEPENDENCY_HELPER = 'own 0.4 helper';

const FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "loader-fixture", "private": true, "type": "module" }\n',
  'main.ts': MAIN,
  'plain.ts': 'export const answer: number = 42\n',
  'stack.ts': STACK,
  'fixture.json': '{ "title": "milk" }\n',
  'json.test.ts': JSON_TEST,
  'disposal.test.ts': DISPOSAL_TEST,
  'enum.ts': ENUM,
  'module.mts': MODULE_MTS,
  'dependency.ts': "import { mine } from 'dep'\n\nconsole.log(mine)\n",
  'node_modules/dep/package.json': '{ "name": "dep", "type": "module", "exports": "./index.js" }\n',
  'node_modules/dep/index.js': "export { mine } from '@swc/helpers/lib/_mine.js'\n",
  'node_modules/@swc/helpers/package.json':
    '{ "name": "@swc/helpers", "version": "0.4.14", "type": "module" }\n',
  'node_modules/@swc/helpers/lib/_mine.js': `export const mine = '${DEPENDENCY_HELPER}'\n`,
};

export interface LoaderApp {
  readonly root: string;
  [Symbol.dispose](): void;
}

export function makeLoaderApp(): LoaderApp {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'murmur-register-')));
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  return { root, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) };
}

export function registerUrl(root: string | undefined): string {
  const url = pathToFileURL(REGISTER_FILE);
  if (root !== undefined) {
    url.searchParams.set('root', root);
  }

  return url.href;
}

export interface NodeRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface NodeRunOptions {
  readonly cwd: string;
  readonly transformer: string;
  readonly url?: string;
}

function childEnv(transformer: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MURMUR_TRANSFORM: transformer, NO_COLOR: '1' };

  delete env['NODE_TEST_CONTEXT'];
  delete env['NODE_OPTIONS'];

  return env;
}

export function runNode(args: readonly string[], options: NodeRunOptions): NodeRun {
  const url = options.url ?? registerUrl(options.cwd);
  const result = spawnSync(process.execPath, ['--enable-source-maps', '--import', url, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: childEnv(options.transformer),
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
