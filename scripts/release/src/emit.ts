import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { packageBin, walk } from './files.ts';

const SOURCE_DIRS = ['src', 'bin'];
const PACK_TSCONFIG = 'tsconfig.pack.json';

function isSource(path: string): boolean {
  return path.endsWith('.ts') && !path.endsWith('.d.ts');
}

function emittedFiles(dir: string): string[] {
  return SOURCE_DIRS.flatMap((sub) => walk(join(dir, sub)))
    .filter(isSource)
    .map((path) => path.replace(/\.ts$/, '.js'))
    .filter((path) => existsSync(path));
}

export function cleanPackage(dir: string): number {
  const files = emittedFiles(dir);
  for (const file of files) {
    rmSync(file);
  }

  return files.length;
}

function packTsconfig(): string {
  const config = {
    extends: './tsconfig.json',
    include: SOURCE_DIRS,
    exclude: ['**/*.test.ts', '**/fixtures/**'],
    compilerOptions: { noEmit: false, noCheck: true, rewriteRelativeImportExtensions: true },
  };

  return `${JSON.stringify(config, null, 2)}\n`;
}

export function emitPackage(dir: string): number {
  cleanPackage(dir);
  const config = join(dir, PACK_TSCONFIG);
  writeFileSync(config, packTsconfig());

  try {
    const result = spawnSync(process.execPath, [packageBin('typescript', 'tsc'), '-p', config], {
      cwd: dir,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(`tsc failed in ${dir}\n${result.stdout}${result.stderr}`);
    }
  } finally {
    rmSync(config, { force: true });
  }

  return emittedFiles(dir).length;
}
