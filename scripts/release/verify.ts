import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { readManifest } from './src/manifest.ts';
import { verifyCli, type Command, type CommandResult } from './src/verify.ts';

const [registry, dir] = process.argv.slice(2);
if (registry === undefined || dir === undefined) {
  console.error('usage: pnpm release:verify <registry url> <empty dir>');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '../..');
const version = readManifest(resolve(root, 'packages/cli')).version;

function run({ file, args, cwd, env }: Command): CommandResult {
  const result = spawnSync(file, args, { cwd, env, encoding: 'utf8' });

  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

try {
  const target = resolve(process.env['INIT_CWD'] ?? process.cwd(), dir);
  const printed = verifyCli({ registry, dir: target, version, env: process.env, run });
  console.log(
    `release:verify: @murmur/cli@${version} from ${registry} prints murmur --version ${printed}, the published loader runs a decorated file`,
  );
} catch (error) {
  console.error(`release:verify: ${(error as Error).message}`);
  process.exitCode = 1;
}
