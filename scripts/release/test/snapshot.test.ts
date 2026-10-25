import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';

import { walk } from '../src/files.ts';
import { releaseNotes } from '../src/release-notes.ts';
import { pinWorkspaceSpecs, snapshot } from '../src/snapshot.ts';

const scratch = mkdtempSync(join(tmpdir(), 'murmur-snapshot-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const json = (value: unknown): string => JSON.stringify(value);

const ROOT_FILES: Readonly<Record<string, string>> = {
  'README.md':
    '# murmur\n\n## Install\n\npnpm install\n\n## Releasing\n\npnpm release:publish\n\n## Repository\n\ninternal\n',
  LICENSE: 'MIT\n',
  'CLAUDE.md': 'internal\n',
  'AGENTS.md': 'internal\n',
  '.agents/state.md': 'internal\n',
  'docs/cli.md': '# cli\n',
  'plugins/.claude-plugin/marketplace.json': json({ name: 'murmur' }),
  'plugins/murmur/.claude-plugin/plugin.json': json({ name: 'murmur' }),
  'plugins/murmur/node_modules/x/index.js': '',
  'plugins/murmur/package.json': json({
    name: '@murmur/plugin',
    devDependencies: { '@murmur/cli': 'workspace:*' },
  }),
  'examples/app/package.json': json({
    name: 'app',
    dependencies: { murmur: 'workspace:*', '@murmur/node': 'workspace:^', zod: '4.6.7' },
  }),
  'examples/app/pieces/a/piece.ts': 'export {}\n',
  'examples/app/node_modules/x/index.js': '',
  'examples/app/.murmur/dev.json': '{}',
  'examples/app/todo.db': '',
  'packages/core/package.json': json({ name: 'murmur', version: '0.1.0' }),
  'packages/cli/package.json': json({ name: '@murmur/cli', version: '0.1.0' }),
  'packages/cli/src/templates/app/pnpm-workspace.yaml.tmpl':
    "allowBuilds:\n  '@swc/core': true\n  esbuild: true\n",
  'packages/node/package.json': json({
    name: '@murmur/node',
    version: '0.1.0',
    dependencies: { murmur: 'workspace:*' },
  }),
};

function makeRoot(name: string, files: Readonly<Record<string, string>>): string {
  const root = join(scratch, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  return root;
}

function run(root: string, out: string): string[] {
  return snapshot({ root, out, sha: 'abc123', date: '2026-10-24T00:00:00.000Z', tarballs: false });
}

describe('snapshot', () => {
  const root = makeRoot('repo', ROOT_FILES);
  const out = join(scratch, 'out');
  const written = run(root, out);
  const files = walk(out).map((path) => path.slice(out.length + 1));

  test('copies the user-facing tree and writes RELEASE.md', () => {
    assert.deepEqual(written, ['README.md', 'LICENSE', 'docs', 'plugins', 'examples', 'RELEASE.md']);

    for (const path of [
      'README.md',
      'LICENSE',
      'docs/cli.md',
      'plugins/.claude-plugin/marketplace.json',
      'plugins/murmur/.claude-plugin/plugin.json',
    ]) {
      assert.ok(files.includes(path), path);
    }

    assert.ok(files.includes(join('examples/app/pieces/a/piece.ts')));
  });

  test('writes a user-facing README without the Releasing and Repository sections', () => {
    assert.equal(readFileSync(join(out, 'README.md'), 'utf8'), '# murmur\n\n## Install\n\npnpm install\n');
  });

  test('leaves out agent memory, git, node_modules, tool state and databases', () => {
    const leaked = files.filter((path) =>
      /(^|\/)(\.agents|\.git|node_modules|\.murmur|CLAUDE\.md|AGENTS\.md)(\/|$)|\.db$/.test(path),
    );
    assert.deepEqual(leaked, []);
    assert.equal(existsSync(join(out, 'packages')), false);
  });

  test('pins workspace links in copied manifests to the released versions', () => {
    const manifest = JSON.parse(readFileSync(join(out, 'examples/app/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.deepEqual(manifest.dependencies, { murmur: '0.1.0', '@murmur/node': '^0.1.0', zod: '4.6.7' });
    assert.ok(!readFileSync(join(out, 'plugins/murmur/package.json'), 'utf8').includes('workspace:'));
  });

  test('gives each example app the scaffold template pnpm-workspace.yaml', () => {
    const workspace = readFileSync(join(out, 'examples/app/pnpm-workspace.yaml'), 'utf8');
    assert.equal(workspace, ROOT_FILES['packages/cli/src/templates/app/pnpm-workspace.yaml.tmpl']);
  });

  test('RELEASE.md carries the git sha and every package version', () => {
    const notes = readFileSync(join(out, 'RELEASE.md'), 'utf8');
    assert.match(notes, /^# murmur 0\.1\.0$/m);
    assert.match(notes, /abc123/);
    assert.match(notes, /\| `murmur` \| 0\.1\.0 \|/);
    assert.match(notes, /\| `@murmur\/node` \| 0\.1\.0 \|/);
  });

  test('refuses a non-empty output directory', () => {
    assert.throws(() => run(root, out), /not empty/);
  });

  test('fails without a LICENSE', () => {
    const { LICENSE: _license, ...rest } = ROOT_FILES;
    assert.throws(() => run(makeRoot('no-license', rest), join(scratch, 'out-2')), /LICENSE is missing/);
  });
});

describe('pinWorkspaceSpecs', () => {
  const versions = new Map([['murmur', '0.1.0']]);

  test('maps workspace:* / ^ / ~ and keeps everything else', () => {
    assert.deepEqual(
      pinWorkspaceSpecs({ murmur: 'workspace:~', zod: '4.6.7', other: 'workspace:*' }, versions),
      { murmur: '~0.1.0', zod: '4.6.7', other: 'workspace:*' },
    );
  });
});

describe('releaseNotes', () => {
  test('lists tarballs in publish order, matching each package exactly', () => {
    const packages = ['murmur', '@murmur/cli'].map((name) => ({
      dir: `/x/${name}`,
      manifest: { name, version: '0.1.0' },
    }));
    const notes = releaseNotes({
      sha: 'abc',
      date: 'today',
      packages,
      tarballs: ['murmur-cli-0.1.0.tgz', 'murmur-0.1.0.tgz'],
    });
    const lines = notes.split('\n').filter((line) => line.startsWith('pnpm publish packages/'));
    assert.deepEqual(lines, [
      'pnpm publish packages/murmur-0.1.0.tgz --registry "$NPM_REGISTRY"',
      'pnpm publish packages/murmur-cli-0.1.0.tgz --registry "$NPM_REGISTRY"',
    ]);
  });
});
