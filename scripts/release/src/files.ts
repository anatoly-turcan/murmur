import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function walk(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((path) => join(dir, path));
  } catch {
    return [];
  }
}

export function packageBin(specifier: string, name: string): string {
  const manifestPath = fileURLToPath(import.meta.resolve(`${specifier}/package.json`));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: Record<string, string> };
  const bin = manifest.bin[name];

  if (bin === undefined) {
    throw new Error(`${specifier} has no bin ${name}`);
  }

  return join(dirname(manifestPath), bin);
}
