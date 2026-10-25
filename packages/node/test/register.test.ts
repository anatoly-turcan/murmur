import assert from 'node:assert/strict';
import type { LoadFnOutput, LoadHookContext, ResolveFnOutput, ResolveHookContext } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { appRootOf, isAppTs, loadWith, resolveHelpersFor } from '../src/register/hooks.ts';
import { SWC_OPTIONS, transformerBinary, transformerName } from '../src/register/transform.ts';
import {
  DEPENDENCY_HELPER,
  makeLoaderApp,
  registerUrl,
  runNode,
  STACK_THROW_LINE,
  TRANSFORMERS,
  type LoaderApp,
} from './register-app.ts';

const ROOT = '/app';
const fileUrl = (path: string): string => pathToFileURL(path).href;

function loadThrough(url: string): { transformed: string[]; passedOn: string[] } {
  const transformed: string[] = [];
  const passedOn: string[] = [];
  const load = loadWith(ROOT, (filename) => {
    transformed.push(filename);

    return 'export {}';
  });
  const nextLoad = (next: string): LoadFnOutput => {
    passedOn.push(next);

    return { format: 'module', source: '' };
  };

  load(url, { conditions: [], format: undefined, importAttributes: {} } as LoadHookContext, nextLoad);

  return { transformed, passedOn };
}

function resolveParentOf(specifier: string, parentURL: string): string | undefined {
  const seen: (string | undefined)[] = [];
  const resolve = resolveHelpersFor(ROOT);
  const nextResolve = (_specifier: string, context?: Partial<ResolveHookContext>): ResolveFnOutput => {
    seen.push(context?.parentURL);

    return { url: 'file:///resolved.js' };
  };

  resolve(specifier, { conditions: [], importAttributes: {}, parentURL }, nextResolve);

  return seen[0];
}

describe('register hooks', () => {
  test('every .ts and .mts file under the app root is an app file, query strings included', () => {
    assert.equal(isAppTs(fileUrl('/app/pieces/todos/piece.ts'), ROOT), true);
    assert.equal(isAppTs(`${fileUrl('/app/pieces/todos/piece.ts')}?v=2`, ROOT), true);
    assert.equal(isAppTs(fileUrl('/app/murmur.config.ts'), ROOT), true);
    assert.equal(isAppTs(fileUrl('/app/pieces/todos/module.mts'), ROOT), true);
  });

  test('node_modules, files outside the root, non-ts files and builtins are not', () => {
    assert.equal(isAppTs(fileUrl('/app/node_modules/@murmur/node/src/index.ts'), ROOT), false);
    assert.equal(isAppTs(fileUrl('/repo/packages/node/src/index.ts'), ROOT), false);
    assert.equal(isAppTs(fileUrl('/application/piece.ts'), ROOT), false);
    assert.equal(isAppTs(fileUrl('/app/pieces/todos/fixture.json'), ROOT), false);
    assert.equal(isAppTs(fileUrl('/app/pieces/todos/piece.js'), ROOT), false);
    assert.equal(isAppTs(fileUrl('/app/pieces/todos/legacy.cts'), ROOT), false);
    assert.equal(isAppTs('node:fs', ROOT), false);
  });

  test('an app file without any decorator still goes through the transform (no content heuristic)', () => {
    using app = makeLoaderApp();
    const plain = join(app.root, 'plain.ts');
    const transformed: string[] = [];
    const load = loadWith(app.root, (filename, source) => {
      transformed.push(`${filename}:${source.includes('@') ? 'decorated' : 'plain'}`);

      return source;
    });
    const json = join(app.root, 'fixture.json');

    load(fileUrl(plain), {} as LoadHookContext, () => ({ format: 'module', source: '' }));
    load(fileUrl(json), {} as LoadHookContext, () => ({ format: 'json', source: '' }));

    assert.deepEqual(transformed, [`${plain}:plain`]);
  });

  test('framework and dependency files are handed to the next loader untouched', () => {
    const outside = loadThrough(fileUrl('/repo/packages/node/src/index.ts'));
    const dependency = loadThrough(fileUrl('/app/node_modules/zod/index.ts'));

    assert.deepEqual(outside.transformed, []);
    assert.equal(outside.passedOn.length, 1);
    assert.deepEqual(dependency.transformed, []);
    assert.equal(dependency.passedOn.length, 1);
  });

  test("only swc helper imports from app files are sent to @murmur/node's copy of @swc/helpers", () => {
    const appFile = fileUrl('/app/pieces/todos/piece.ts');
    const dependencyFile = fileUrl('/app/node_modules/dep/index.js');

    assert.notEqual(resolveParentOf('@swc/helpers/_/_using_ctx', appFile), appFile);
    assert.equal(resolveParentOf('@swc/helpers/_/_using_ctx', dependencyFile), dependencyFile);
    assert.equal(resolveParentOf('zod', appFile), appFile);
  });

  test('the app root comes from the register URL, else from the working directory', () => {
    using app = makeLoaderApp();

    assert.equal(appRootOf(registerUrl(app.root), '/elsewhere'), app.root);
    assert.equal(appRootOf(registerUrl(undefined), app.root), app.root);
  });

  test('MURMUR_TRANSFORM selects swc by default, esbuild on request, and rejects anything else', () => {
    assert.equal(transformerName(undefined), 'swc');
    assert.equal(transformerName(''), 'swc');
    assert.equal(transformerName('swc'), 'swc');
    assert.equal(transformerName('esbuild'), 'esbuild');
    assert.throws(() => transformerName('oxc'), /MURMUR_TRANSFORM=oxc is not a transformer/);
  });

  test('each transformer names the platform binary that is installed', () => {
    assert.match(transformerBinary('swc') ?? '', /^@swc\/core-[\w-]+ 1\.16\.20$/);
    assert.match(transformerBinary('esbuild') ?? '', /^@esbuild\/[\w-]+ 0\.28\.2$/);
  });

  test('swc runs standard 2023-11 decorators, keeps import attributes and inlines source maps', () => {
    assert.equal(SWC_OPTIONS.jsc.transform.decoratorVersion, '2023-11');
    assert.equal(SWC_OPTIONS.jsc.experimental.keepImportAttributes, true);
    assert.equal(SWC_OPTIONS.sourceMaps, 'inline');
    assert.equal(SWC_OPTIONS.swcrc, false);
  });
});

for (const transformer of TRANSFORMERS) {
  describe(`node --enable-source-maps --import @murmur/node/register (${transformer})`, () => {
    let app: LoaderApp;
    const run = (args: readonly string[], url?: string) =>
      runNode(args, { cwd: app.root, transformer, ...(url === undefined ? {} : { url }) });

    test.before(() => {
      app = makeLoaderApp();
    });
    test.after(() => app[Symbol.dispose]());

    test('runs a decorated fixture: method decorators, metadata and initializers', () => {
      const result = run(['main.ts']);

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        result: 'MILK',
        metadata: { create: 'todos.CreateTodo' },
        seen: ['todos.CreateTodo'],
      });
    });

    test('a thrown error names the .ts file and line', () => {
      const result = run(['stack.ts']);

      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`at Thrower\\.run \\(.*stack\\.ts:${STACK_THROW_LINE}:13\\)`));
    });

    test('a transformed test importing ./fixture.json with { type: "json" } loads', () => {
      const result = run(['--test', '--test-reporter=tap', 'json.test.ts']);

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /# pass 1/);
    });

    test('await using inside a transformed node:test body disposes in order and surfaces SuppressedError', () => {
      const result = run(['--test', '--test-reporter=tap', 'disposal.test.ts']);

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /# pass 2/);
    });

    test('module.register is never called: no DEP0205, no warning at all on stderr', () => {
      const result = run(['--trace-deprecation', 'main.ts']);

      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /DEP0205/);
      assert.equal(result.stderr, '');
    });

    test('a dependency importing its own @swc/helpers gets its own copy', () => {
      const result = run(['dependency.ts']);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), DEPENDENCY_HELPER);
    });

    test('a decorated .mts file is transformed too', () => {
      const result = run(['module.mts']);

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { kind: 'mts' });
    });

    test('enum and parameter properties compile: lint and tsc gate them, not the loader', () => {
      const result = run(['enum.ts']);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), '1 3');
    });

    test('without a root in the URL the working directory is the app root', () => {
      const result = run(['main.ts'], registerUrl(undefined));

      assert.equal(result.status, 0, result.stderr);
    });
  });
}
