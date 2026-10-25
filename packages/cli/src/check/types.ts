import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { finding, type Finding } from './finding.ts';

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

function tscBin(root: string): string {
  const local = join(root, 'node_modules', '.bin', 'tsc');

  return existsSync(local) ? local : 'tsc';
}

export function typeFindings(root: string): Finding[] {
  const result = spawnSync(tscBin(root), ['-p', 'tsconfig.json', '--pretty', 'false'], {
    cwd: root,
    encoding: 'utf8',
  });

  if (result.error !== undefined) {
    return [finding('types/tsc', 'error', 'tsconfig.json', `tsc could not run: ${result.error.message}`)];
  }

  return result.stdout.split('\n').flatMap((line) => {
    const match = TSC_LINE.exec(line.trim());
    if (match === null) {
      return [];
    }

    const [, file = '', row = '1', col = '1', severity, code = '', message = ''] = match;

    return [
      finding(`types/${code}`, severity === 'error' ? 'error' : 'warn', file, message, {
        line: Number(row),
        col: Number(col),
      }),
    ];
  });
}
