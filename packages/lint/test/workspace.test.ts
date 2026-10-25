import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

type Manifest = {
  name: string;
  type?: string;
  packageManager?: string;
  engines?: Record<string, string>;
  exports?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type TsConfig = {
  extends?: string;
  include?: string[];
  references?: unknown;
  compilerOptions?: Record<string, unknown>;
};

const root = resolve(import.meta.dirname, '../../..');

const packageDirs = [
  'cli',
  'core',
  'dev-protocol',
  'lint',
  'node',
  'transport-amqp',
  'transport-memory',
  'ui',
];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
}

function manifests(): Manifest[] {
  return [
    readJson<Manifest>('package.json'),
    ...packageDirs.map((dir) => readJson<Manifest>(`packages/${dir}/package.json`)),
  ];
}

function guardScript(): string {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const match = /node -e "([^"]*process\.versions\.node[^"]*)"/.exec(ci);
  assert.ok(match?.[1], 'ci.yml has a node version guard step');

  return match[1];
}

function guardExitCode(script: string, nodeVersion: string): number {
  let code = 0;
  const fakeProcess = { versions: { node: nodeVersion }, exit: (status: number) => (code = status) };
  new Function('process', script)(fakeProcess);

  return code;
}

describe('root manifests', () => {
  test('package.json pins pnpm, is ESM and requires node >= 26', () => {
    const pkg = readJson<Manifest>('package.json');
    assert.equal(pkg.packageManager, 'pnpm@12.11.2');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.engines?.['node'], '>=26');
    assert.equal(pkg.scripts?.['check'], 'pnpm lint && pnpm typecheck && pnpm test');
    assert.equal(pkg.scripts?.['typecheck'], 'pnpm -r --parallel --aggregate-output typecheck');
  });

  test('pnpm-workspace.yaml lists packages, plugins and examples', () => {
    const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
    for (const glob of ['packages/*', 'plugins/*', 'examples/*']) {
      assert.match(workspace, new RegExp(glob));
    }
  });

  test('.nvmrc is 26', () => {
    assert.equal(readFileSync(join(root, '.nvmrc'), 'utf8').trim(), '26');
  });

  test('there is no solution tsconfig and the base uses no project references', () => {
    assert.equal(existsSync(join(root, 'tsconfig.json')), false);
    const base = readJson<TsConfig>('tsconfig.base.json');
    assert.equal(base.references, undefined);
    assert.equal(base.compilerOptions?.['composite'], undefined);
    assert.equal(base.compilerOptions?.['noEmit'], true);
    assert.equal(base.compilerOptions?.['erasableSyntaxOnly'], true);
  });

  test('every dependency is pinned exactly or is a workspace link', () => {
    const ranges = manifests().flatMap((pkg) =>
      [pkg.dependencies, pkg.devDependencies].flatMap((deps) =>
        Object.entries(deps ?? {}).map(([dep, version]) => `${pkg.name} ${dep}@${version}`),
      ),
    );
    const loose = ranges.filter((entry) => !/@(workspace:\*|\d+\.\d+\.\d+)$/.test(entry));
    assert.deepEqual(loose, []);
  });

  test('a peer dependency is pinned exactly or a caret range the app satisfies with its own copy', () => {
    const peers = manifests().flatMap((pkg) =>
      Object.entries(pkg.peerDependencies ?? {}).map(([dep, version]) => `${pkg.name} ${dep}@${version}`),
    );
    const loose = peers.filter((entry) => !/@(\d+\.\d+\.\d+|\^\d+\.\d+(\.\d+)?)$/.test(entry));
    assert.deepEqual(loose, []);
  });
});

describe('packages', () => {
  test('packages/ holds exactly the spec layout', () => {
    const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
    assert.deepEqual(dirs, packageDirs);
  });

  for (const dir of packageDirs) {
    test(`${dir} is an ESM node >= 26 package whose entry exists`, () => {
      const pkg = readJson<Manifest>(`packages/${dir}/package.json`);
      assert.equal(pkg.type, 'module');
      assert.equal(pkg.engines?.['node'], '>=26');
      const entry = pkg.exports?.['.'];
      assert.ok(entry, 'exports "." is declared');
      const source = entry.startsWith('./dist/') ? entry.replace('./dist/', './') : entry;
      assert.ok(existsSync(join(root, 'packages', dir, source)), `${source} exists`);
    });

    test(`${dir} typechecks with tsc -p and no project references`, () => {
      const pkg = readJson<Manifest>(`packages/${dir}/package.json`);
      assert.equal(pkg.scripts?.['typecheck'], 'tsc -p tsconfig.json');
      const tsconfig = readJson<TsConfig>(`packages/${dir}/tsconfig.json`);
      assert.equal(tsconfig.extends, '../../tsconfig.base.json');
      assert.deepEqual(tsconfig.include, ['src', 'bin', 'test']);
      assert.equal(tsconfig.references, undefined);
      assert.equal(tsconfig.compilerOptions?.['composite'], undefined);
    });
  }
});

describe('tool configs', () => {
  test('.oxlintrc.json extends the lint preset by path', () => {
    const config = readJson<{ extends: string[] }>('.oxlintrc.json');
    assert.deepEqual(config.extends, ['./packages/lint/preset.json']);
    assert.ok(existsSync(join(root, 'packages/lint/preset.json')));
  });

  test('the preset has no no-restricted-syntax rule', () => {
    const preset = readJson<{ rules: Record<string, unknown> }>('packages/lint/preset.json');
    assert.equal(preset.rules['no-restricted-syntax'], undefined);
  });

  test('.oxfmtrc.json is a copy of packages/lint/oxfmt.json', () => {
    assert.deepEqual(readJson('.oxfmtrc.json'), readJson('packages/lint/oxfmt.json'));
  });
});

describe('node >= 26 guard', () => {
  test('rejects node 24 and 25', () => {
    assert.equal(guardExitCode(guardScript(), '24.18.0'), 1);
    assert.equal(guardExitCode(guardScript(), '25.9.0'), 1);
  });

  test('accepts node 26 and later', () => {
    assert.equal(guardExitCode(guardScript(), '26.0.0'), 0);
    assert.equal(guardExitCode(guardScript(), '27.1.0'), 0);
  });

  test('passes on the running node', () => {
    const result = spawnSync(process.execPath, ['-e', guardScript()]);
    assert.equal(result.status, 0);
  });

  test('the check job runs the guard before install', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const guardAt = ci.indexOf('process.versions.node');
    const installAt = ci.indexOf('pnpm install --frozen-lockfile');
    assert.ok(guardAt > 0 && installAt > guardAt);
  });
});
