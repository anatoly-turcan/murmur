import { spawnSync } from 'node:child_process';

function git(root: string, args: readonly string[]): string[] {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }

  return result.stdout.split('\n').filter((line) => line.trim() !== '');
}

export function changedFiles(root: string): string[] {
  return [
    ...new Set([
      ...git(root, ['diff', '--name-only', '--relative', 'HEAD']),
      ...git(root, ['ls-files', '--others', '--exclude-standard']),
    ]),
  ];
}
