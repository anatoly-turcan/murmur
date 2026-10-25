import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

type Env = Readonly<Record<string, string | undefined>>;

export function existingEnvFiles(root: string, files: readonly string[]): string[] {
  return files.filter((file) => existsSync(resolve(root, file)));
}

export function withEnvFiles(root: string, files: readonly string[], env: Env): Env {
  const fromFiles = existingEnvFiles(root, files).map((file) =>
    parseEnv(readFileSync(resolve(root, file), 'utf8')),
  );

  return Object.assign({}, ...fromFiles, env) as Env;
}
