import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ExportTarget = string | { readonly types: string; readonly default: string };

export interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly exports?: Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly publishConfig?: {
    readonly access?: string;
    readonly exports?: Readonly<Record<string, ExportTarget>>;
    readonly bin?: Readonly<Record<string, string>>;
  };
}

export interface WorkspacePackage {
  readonly dir: string;
  readonly manifest: Manifest;
}

export function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
}

export function publishablePackages(root: string): WorkspacePackage[] {
  const packagesDir = join(root, 'packages');

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .map((dir) => ({ dir, manifest: readManifest(dir) }))
    .filter((pkg) => pkg.manifest.private !== true);
}

function compiled(path: string): string {
  return path.replace(/\.ts$/, '.js');
}

export function publishedTarget(path: string): ExportTarget {
  return path.endsWith('.ts') && !path.endsWith('.d.ts') ? { types: path, default: compiled(path) } : path;
}

export function publishedExports(exports: Readonly<Record<string, string>>): Record<string, ExportTarget> {
  return Object.fromEntries(Object.entries(exports).map(([key, path]) => [key, publishedTarget(path)]));
}

export function publishedBin(bin: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(bin).map(([name, path]) => [name, compiled(path)]));
}
