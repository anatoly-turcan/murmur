import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { murmur, packageRoot, repoRoot } from './helpers.ts';

type Manifest = {
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const parent = mkdtempSync(join(tmpdir(), 'murmur-new-app-'));
const app = join(parent, 'demo');
after(() => rmSync(parent, { recursive: true, force: true }));

function run(bin: string, args: readonly string[]): { status: number | null; output: string } {
  const result = spawnSync(join(repoRoot, 'node_modules/.bin', bin), args, { cwd: app, encoding: 'utf8' });

  return { status: result.status, output: result.stdout + result.stderr };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('murmur new app', () => {
  const created = murmur(['new', 'app', app]);
  const cliVersion = readJson<Manifest>(join(packageRoot, 'package.json')).version;

  test('exits 0', () => {
    assert.equal(created.status, 0, created.stdout + created.stderr);
  });

  test('prints next steps as exact commands, one per line, without double spaces', () => {
    const next = created.stdout.split('\n').filter((line) => line.startsWith('next:'));
    assert.deepEqual(next, [
      `next: cd ${app}`,
      'next: pnpm install',
      'next: pnpm exec murmur new contract <Name> --domain <file> --kind query',
      'next: pnpm exec murmur new piece <path> --handles <Name>',
    ]);
    assert.doesNotMatch(created.stdout, /\S {2,}\S/);
  });

  test('writes a README with the commands and no registry section', () => {
    const readme = readFileSync(join(app, 'README.md'), 'utf8');
    assert.match(readme, /^# demo$/m);
    assert.match(readme, /pnpm exec murmur check/);
    assert.doesNotMatch(readme, /registry/i);
  });

  test('pins every murmur package to the CLI version, never workspace:', () => {
    const manifest = readJson<Manifest>(join(app, 'package.json'));
    const murmurDeps = { ...manifest.dependencies, ...manifest.devDependencies };
    const pinned = Object.fromEntries(
      Object.entries(murmurDeps).filter(([name]) => name === 'murmur' || name.startsWith('@murmur/')),
    );
    assert.deepEqual(pinned, {
      murmur: cliVersion,
      '@murmur/node': cliVersion,
      '@murmur/transport-memory': cliVersion,
      '@murmur/cli': cliVersion,
      '@murmur/lint': cliVersion,
    });
    assert.ok(!readFileSync(join(app, 'package.json'), 'utf8').includes('workspace:'));
  });

  test('passes murmur check, oxlint, oxfmt --check and tsc as generated, without warnings', () => {
    symlinkSync(join(packageRoot, 'node_modules'), join(app, 'node_modules'), 'dir');
    const check = murmur(['check', '--cwd', app]);
    assert.equal(check.status, 0, check.stdout + check.stderr);

    for (const [bin, args] of [
      ['oxlint', ['--deny-warnings']],
      ['oxfmt', ['--check']],
      ['tsc', ['-p', 'tsconfig.json']],
    ] as const) {
      const result = run(bin, args);
      assert.equal(result.status, 0, `${bin}: ${result.output}`);
      assert.doesNotMatch(result.output, /^\S+:\d+:\d+: warning /m, `${bin}: ${result.output}`);
    }
  });

  test('writes the web capability with the input failure map and the #capabilities/* alias', () => {
    const capability = readFileSync(join(app, 'capabilities/web/capability.ts'), 'utf8');
    assert.match(capability, /^const web = http\(\{\n {2}guards: \[\],\n {2}errors: \{\n {4}input: \{$/m);
    assert.match(capability, /^ {6}params: \{ status: 404, code: 'not_found' \},$/m);
    assert.match(capability, /^ {6}mediaType: \{ status: 415, code: 'unsupported_media_type' \},$/m);
    assert.match(capability, /^export type WebRequest = RequestOf<typeof web>;$/m);
    const imports = readJson<{ imports: Record<string, string> }>(join(app, 'package.json')).imports;
    assert.equal(imports['#capabilities/*'], './capabilities/*/capability.ts');
  });

  test('a domain piece, a guard piece, two edges and a lib module scaffold into the new app and pass check, test, lint and tsc', () => {
    const steps = [
      [
        'contract',
        'GetX',
        '--domain',
        'x',
        '--kind',
        'query',
        '--input',
        'id:string',
        '--output',
        'label:string',
      ],
      ['contract', 'Authenticate', '--domain', 'auth', '--kind', 'guard', '--output', 'userId:string'],
      ['piece', 'x', '--handles', 'GetX'],
      ['piece', 'auth', '--handles', 'Authenticate'],
      ['piece', 'api/x', '--edge', '--serve', 'get /x/:id=GetX'],
      ['piece', 'api/y', '--edge', '--serve', 'get /y/:id', '--emits', 'GetX'],
      ['lib', 'text'],
    ];

    for (const step of steps) {
      const result = murmur(['new', ...step, '--cwd', app]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }

    const token = join(app, 'capabilities/web/capability.ts');
    writeFileSync(
      token,
      readFileSync(token, 'utf8')
        .replace("capabilities';\n", "capabilities';\n\nimport { Authenticate } from '#contracts/auth';\n")
        .replace('guards: [],', 'guards: [Authenticate],'),
    );
    const check = murmur(['check', '--json', '--cwd', app]);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.deepEqual(check.json<{ findings: unknown[] }>().findings, []);
    const tested = murmur(['test', '--json', '--cwd', app]);
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    const summary = tested.json<{ passed: number; failed: number }>();
    assert.deepEqual([summary.passed, summary.failed], [5, 0]);

    for (const [bin, args] of [
      ['oxlint', []],
      ['oxfmt', ['--check']],
      ['tsc', ['-p', 'tsconfig.json']],
    ] as const) {
      const result = run(bin, args);
      assert.equal(result.status, 0, `${bin}: ${result.output}`);
    }
  });

  test('the scaffolded guard answers Model | Rejection and the edge method reads, requests and replies', () => {
    const contract = readFileSync(join(app, 'contracts/auth.ts'), 'utf8');
    const guard = readFileSync(join(app, 'pieces/auth/piece.ts'), 'utf8');
    const edge = readFileSync(join(app, 'pieces/api/y/piece.ts'), 'utf8');

    assert.match(
      contract,
      /^export class AuthenticateOutput extends Model\(\{ userId: z\.string\(\) \}\) \{\}$/m,
    );
    assert.match(contract, /^export class Authenticate extends Guard\(AuthenticateOutput\) \{\}$/m);
    assert.match(guard, /Promise<AuthenticateOutput \| Rejection>/);
    assert.match(guard, /return reject\(401, 'credentials required'\);/);
    assert.match(edge, /const \{ params \} = await req\.read\(\{ params: GetX\.input \}\);/);
    assert.match(edge, /const output = await this\.request\(GetX, params\);/);
    assert.match(edge, /return req\.reply\(output\);/);
    const ctx = murmur(['ctx', 'api/y', '--cwd', app]);
    assert.equal(ctx.status, 0, ctx.stderr);
    assert.match(ctx.stdout, /\| params \| 404 \| `not_found` \|/);
  });

  test('writes pnpm-workspace.yaml allowing the @swc/core build, so pnpm 12 installs the loader', () => {
    assert.equal(
      readFileSync(join(app, 'pnpm-workspace.yaml'), 'utf8'),
      "allowBuilds:\n  '@swc/core': true\n",
    );
  });

  test('the CLI is the only agent surface: no agent server config, AGENTS.md names CLI commands', () => {
    const entries = readdirSync(app).filter((name) => !['node_modules', '.murmur'].includes(name));
    assert.deepEqual(entries.toSorted(), [
      '.env.example',
      '.gitignore',
      '.oxfmtrc.json',
      '.oxlintrc.json',
      'AGENTS.md',
      'README.md',
      'capabilities',
      'contracts',
      'lib',
      'murmur.config.ts',
      'murmur.yaml',
      'package.json',
      'pieces',
      'pnpm-workspace.yaml',
      'tsconfig.json',
    ]);
    const agents = readFileSync(join(app, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(agents, /m[c]p/i);
    assert.match(agents, /pnpm exec murmur ctx pieces\/<id>/);
  });
});

test('a relative app path prints a relative cd', () => {
  const result = murmur(['new', 'app', 'rel-app', '--cwd', parent]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^next: cd rel-app$/m);
});

describe('murmur new app --registry', () => {
  test('writes .npmrc pointing installs at that registry', () => {
    const dir = join(parent, 'registry-app');
    const result = murmur(['new', 'app', dir, '--registry', 'http://127.0.0.1:4873/']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(dir, '.npmrc'), 'utf8'), 'registry=http://127.0.0.1:4873/\n');
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    assert.match(readme, /^## Registry$/m);
    assert.match(readme, /`http:\/\/127\.0\.0\.1:4873\/`/);
    assert.match(readme, /`\.npmrc`/);
  });

  test('rejects a registry that is not an http(s) URL with exit 2', () => {
    const dir = join(parent, 'bad-registry-app');
    assert.equal(murmur(['new', 'app', dir, '--registry', 'not a url']).status, 2);
    assert.equal(existsSync(dir), false);
  });

  test('without --registry no .npmrc is written', () => {
    assert.equal(existsSync(join(app, '.npmrc')), false);
  });
});

test('murmur --version prints the package version', () => {
  const result = murmur(['--version']);
  assert.equal(result.stdout.trim(), readJson<Manifest>(join(packageRoot, 'package.json')).version);
});
