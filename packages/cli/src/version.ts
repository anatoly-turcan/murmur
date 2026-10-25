import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function cliVersion(): string {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    version: string;
  };

  return manifest.version;
}
