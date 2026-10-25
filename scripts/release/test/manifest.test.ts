import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { importedPackages } from '../src/imports.ts';
import { publishablePackages, publishedBin, publishedExports, publishedTarget } from '../src/manifest.ts';

const root = resolve(import.meta.dirname, '../../..');
const packages = publishablePackages(root);

describe('publishedTarget', () => {
  test('maps a .ts entry to types (source) + default (emitted .js)', () => {
    assert.deepEqual(publishedTarget('./src/index.ts'), {
      types: './src/index.ts',
      default: './src/index.js',
    });
  });

  test('leaves json, html and .d.ts entries alone', () => {
    assert.equal(publishedTarget('./preset.json'), './preset.json');
    assert.equal(publishedTarget('./dist/index.html'), './dist/index.html');
    assert.equal(publishedTarget('./types.d.ts'), './types.d.ts');
  });
});

describe('publishable packages', () => {
  test('are the eight packages, all at one version', () => {
    assert.deepEqual(packages.map((pkg) => pkg.manifest.name).toSorted(), [
      '@murmur/cli',
      '@murmur/dev-protocol',
      '@murmur/lint',
      '@murmur/node',
      '@murmur/transport-amqp',
      '@murmur/transport-memory',
      '@murmur/ui',
      'murmur',
    ]);
    const plugin = JSON.parse(
      readFileSync(join(root, 'plugins/murmur/.claude-plugin/plugin.json'), 'utf8'),
    ) as {
      version: string;
    };
    assert.deepEqual([...new Set(packages.map((pkg) => pkg.manifest.version))], [plugin.version]);
  });

  for (const { dir, manifest } of packages) {
    const hasSource = Object.values(manifest.exports ?? {}).some((path) => path.endsWith('.ts'));

    test(`${manifest.name} publishes with public access`, () => {
      assert.equal(manifest.publishConfig?.access, 'public');
    });

    test(`${manifest.name} publishConfig mirrors exports and bin with emitted .js`, () => {
      const published = manifest.publishConfig?.exports ?? manifest.exports;
      assert.deepEqual(published, publishedExports(manifest.exports ?? {}));

      if (manifest.bin !== undefined) {
        assert.deepEqual(manifest.publishConfig?.bin, publishedBin(manifest.bin));
      }
    });

    test(`${manifest.name} builds what it publishes on prepack`, () => {
      const scripts = (manifest as { scripts?: Record<string, string> }).scripts ?? {};
      if (hasSource) {
        assert.equal(scripts['prepack']?.split(' && ').at(-1), 'node ../../scripts/release/emit.ts');
        assert.equal(scripts['postpack'], 'node ../../scripts/release/emit.ts --clean');
      } else {
        assert.equal(scripts['prepack'], 'vite build');
      }
    });

    test(`${manifest.name} declares every package its source imports`, () => {
      const declared = new Set([
        manifest.name,
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]);
      const missing = hasSource ? importedPackages(dir).filter((name) => !declared.has(name)) : [];
      assert.deepEqual(missing, []);
    });

    test(`${manifest.name} bins carry a node shebang`, () => {
      for (const path of Object.values(manifest.bin ?? {})) {
        assert.ok(existsSync(join(dir, path)), `${path} exists`);
        assert.match(readFileSync(join(dir, path), 'utf8'), /^#!\/usr\/bin\/env node\n/);
      }
    });
  }
});
