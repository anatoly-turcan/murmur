import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import { publishablePackages, type Manifest, type WorkspacePackage } from '../src/manifest.ts';
import { publishOrder } from '../src/order.ts';

const root = resolve(import.meta.dirname, '../../..');

function pkg(name: string, dependencies: Record<string, string> = {}): WorkspacePackage {
  const manifest: Manifest = { name, version: '0.1.0', dependencies };

  return { dir: `/x/${name}`, manifest };
}

describe('publishOrder', () => {
  const ordered = publishOrder(publishablePackages(root)).map((p) => p.manifest.name);

  test('puts every workspace package after the workspace packages it depends on', () => {
    for (const { manifest } of publishablePackages(root)) {
      for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
        if (ordered.includes(dep)) {
          assert.ok(ordered.indexOf(dep) < ordered.indexOf(manifest.name), `${dep} before ${manifest.name}`);
        }
      }
    }
  });

  test('starts with murmur and puts the cli after the runtime packages it depends on', () => {
    assert.equal(ordered[0], 'murmur');
    assert.ok(ordered.indexOf('@murmur/node') < ordered.indexOf('@murmur/cli'));
    assert.ok(ordered.indexOf('@murmur/dev-protocol') < ordered.indexOf('@murmur/cli'));
  });

  test('ignores devDependencies, so the core ↔ transport-memory dev cycle does not block', () => {
    assert.equal(ordered.length, 8);
  });

  test('reports a runtime dependency cycle', () => {
    assert.throws(
      () => publishOrder([pkg('a', { b: '1.0.0' }), pkg('b', { a: '1.0.0' })]),
      /cycle: a → b → a/,
    );
  });
});
