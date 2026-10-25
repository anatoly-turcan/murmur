import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { metadataCacheWarning, pnpmCacheRoot } from '../src/pnpm-cache.ts';
import { publish } from '../src/publish.ts';

const scratch = mkdtempSync(join(tmpdir(), 'murmur-publish-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function makeRoot(): string {
  const root = join(scratch, 'repo');
  for (const [dir, name] of [
    ['core', 'murmur'],
    ['cli', '@murmur/cli'],
  ] as const) {
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify({ name, version: '0.1.0' }));
  }

  return root;
}

function fakeRegistry(published: ReadonlySet<string>): Server {
  return createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').slice(1));
    if (!published.has(name)) {
      response.writeHead(404).end('{}');

      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name, versions: { '0.1.0': {} } }));
  });
}

describe('publish against a registry that already has the version', () => {
  const root = makeRoot();
  const server = fakeRegistry(new Set(['murmur', '@murmur/cli']));
  let registry = '';
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    registry = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/`;
  });
  after(() => server.close());

  const run = (force: boolean, lines: string[]) =>
    publish({
      root,
      registry,
      token: 'token',
      env: {},
      log: (line) => lines.push(line),
      force,
      cacheRoot: scratch,
    });

  test('refuses without --force, naming every version already present, and publishes nothing', async () => {
    const lines: string[] = [];

    await assert.rejects(run(false, lines), (error: Error) => {
      assert.match(error.message, /murmur@0\.1\.0/);
      assert.match(error.message, /@murmur\/cli@0\.1\.0/);
      assert.match(error.message, /--force/);
      assert.match(error.message, /bump the version/);

      return true;
    });

    assert.deepEqual(
      lines.filter((line) => line.startsWith('publish ')),
      [],
    );
  });

  test('with --force skips the present versions instead', async () => {
    const lines: string[] = [];
    const outcomes = await run(true, lines);
    assert.deepEqual(Object.fromEntries(outcomes), { murmur: 'skipped', '@murmur/cli': 'skipped' });
    assert.ok(lines.some((line) => line.startsWith('skip murmur@0.1.0')));
  });
});

describe('metadataCacheWarning', () => {
  const cacheRoot = join(scratch, 'cache');
  const cached = [
    join(cacheRoot, 'v12', 'metadata', 'http%3A+127.0.0.1+4873'),
    join(cacheRoot, 'v12', 'metadata-full', 'http%3A+127.0.0.1+4873'),
  ];
  before(() => {
    for (const dir of [...cached, join(cacheRoot, 'v12', 'metadata', 'https%3A+registry.npmjs.org')]) {
      mkdirSync(dir, { recursive: true });
    }
  });

  test('names the cached metadata folders of exactly that registry', () => {
    const warning = metadataCacheWarning('http://127.0.0.1:4873/', cacheRoot);
    assert.match(warning, /^warning: pnpm caches registry metadata/);

    for (const dir of cached) {
      assert.ok(warning.includes(dir), warning);
    }

    assert.ok(!warning.includes('registry.npmjs.org'), warning);
  });

  test('without cached metadata it still warns and names where pnpm would keep it', () => {
    const warning = metadataCacheWarning('http://127.0.0.1:4999/', cacheRoot);
    assert.match(warning, /^warning: pnpm caches registry metadata/);
    assert.ok(warning.includes(join(cacheRoot, 'v*', 'metadata*', 'http%3A+127.0.0.1+4999')), warning);
  });
});

describe('pnpmCacheRoot', () => {
  test('follows XDG_CACHE_HOME, then the platform default', () => {
    assert.equal(pnpmCacheRoot({ XDG_CACHE_HOME: '/x' }, 'linux', '/home/a'), join('/x', 'pnpm'));
    assert.equal(pnpmCacheRoot({}, 'linux', '/home/a'), join('/home/a', '.cache', 'pnpm'));
    assert.equal(pnpmCacheRoot({}, 'darwin', '/Users/a'), join('/Users/a', 'Library', 'Caches', 'pnpm'));
    assert.equal(pnpmCacheRoot({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U'), join('C:\\L', 'pnpm-cache'));
  });
});
