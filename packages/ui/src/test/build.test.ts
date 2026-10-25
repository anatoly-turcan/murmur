import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
let outDir = '';

afterAll(async () => {
  if (outDir) {
    await rm(outDir, { recursive: true, force: true });
  }
});

describe('vite build', () => {
  test('emits index.html with relative asset urls so the dev server can serve it at /', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'murmur-ui-'));
    await build({ root, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    const html = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toMatch(/src="\.\/assets\/index-[\w-]+\.js"/);
    expect(html).toMatch(/href="\.\/assets\/index-[\w-]+\.css"/);
  }, 30_000);
});
