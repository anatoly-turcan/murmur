import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { snapshot } from './src/snapshot.ts';

function gitSha(root: string): string {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim();

  return `${head || 'unknown'}${dirty === '' ? '' : '-dirty'}`;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'no-tarballs': { type: 'boolean' } },
});
const [out] = positionals;

if (out === undefined) {
  console.error('usage: pnpm release:snapshot <output dir> [--no-tarballs]');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '../..');
const written = snapshot({
  root,
  out: resolve(process.env['INIT_CWD'] ?? process.cwd(), out),
  sha: gitSha(root),
  date: new Date().toISOString(),
  tarballs: values['no-tarballs'] !== true,
});
console.log(`release snapshot: ${written.join(', ')}`);
