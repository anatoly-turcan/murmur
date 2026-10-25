import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CliError, EXIT } from './errors.ts';

export const REGISTER_SPECIFIER = '@murmur/node/register';

export function resolveFromApp(root: string, specifier: string): string {
  try {
    return createRequire(join(root, 'package.json')).resolve(specifier);
  } catch (error) {
    throw new CliError(
      EXIT.boot,
      `cannot resolve ${specifier} from ${root}: ${error instanceof Error ? error.message : String(error)}`,
      'add @murmur/node to the app dependencies and run pnpm install',
    );
  }
}

export function registerPath(root: string): string {
  return resolveFromApp(root, REGISTER_SPECIFIER);
}

export function registerUrl(root: string): string {
  const url = pathToFileURL(registerPath(root));

  url.searchParams.set('root', root);

  return url.href;
}

export function appExecArgv(root: string): string[] {
  return ['--enable-source-maps', '--import', registerUrl(root)];
}

export async function registerAppLoader(root: string): Promise<void> {
  await import(registerUrl(root));
}
