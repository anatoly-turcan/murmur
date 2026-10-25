import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

export interface YamlConfig {
  readonly shared: Readonly<Record<string, unknown>>;
  readonly pieces: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface PackageJson {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

export interface AppFiles {
  readonly yaml: YamlConfig;
  readonly yamlError: string | null;
  readonly packageJson: PackageJson | null;
}

const EMPTY_YAML: YamlConfig = { shared: {}, pieces: {} };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readYaml(root: string): { yaml: YamlConfig; error: string | null } {
  const file = join(root, 'murmur.yaml');
  if (!existsSync(file)) {
    return { yaml: EMPTY_YAML, error: null };
  }

  try {
    const data = asRecord(parse(readFileSync(file, 'utf8'), { schema: 'failsafe' }));
    const pieces = Object.fromEntries(
      Object.entries(asRecord(data['pieces'])).map(([id, v]) => [id, asRecord(v)]),
    );

    return { yaml: { shared: asRecord(data['shared']), pieces }, error: null };
  } catch (error) {
    return { yaml: EMPTY_YAML, error: (error as Error).message };
  }
}

export function readPackageJson(root: string): PackageJson | null {
  const file = join(root, 'package.json');
  if (!existsSync(file)) {
    return null;
  }

  try {
    const data = asRecord(JSON.parse(readFileSync(file, 'utf8')));

    return {
      dependencies: asRecord(data['dependencies']) as Record<string, string>,
      devDependencies: asRecord(data['devDependencies']) as Record<string, string>,
    };
  } catch {
    return null;
  }
}

export function readPackageImports(root: string): Readonly<Record<string, string>> {
  const file = join(root, 'package.json');
  if (!existsSync(file)) {
    return {};
  }

  try {
    const imports = asRecord(asRecord(JSON.parse(readFileSync(file, 'utf8')))['imports']);

    return Object.fromEntries(
      Object.entries(imports).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

export function readAppFiles(root: string): AppFiles {
  const { yaml, error } = readYaml(root);

  return { yaml, yamlError: error, packageJson: readPackageJson(root) };
}
