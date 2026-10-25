import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { walk } from './files.ts';
import { publishablePackages, type WorkspacePackage } from './manifest.ts';
import { publishOrder } from './order.ts';
import { userReadme } from './readme.ts';
import { releaseNotes } from './release-notes.ts';

export interface SnapshotOptions {
  readonly root: string;
  readonly out: string;
  readonly sha: string;
  readonly date: string;
  readonly tarballs: boolean;
}

const EXCLUDED = new Set([
  '.agents',
  '.git',
  'node_modules',
  '.murmur',
  'CLAUDE.md',
  'AGENTS.md',
  'coverage',
  'research',
]);
const COPIED = ['README.md', 'LICENSE', 'docs', 'plugins', 'examples'];
const REQUIRED = new Set(['README.md', 'LICENSE']);
const APP_WORKSPACE_TEMPLATE = join('packages', 'cli', 'src', 'templates', 'app', 'pnpm-workspace.yaml.tmpl');

function included(path: string): boolean {
  const name = basename(path);

  return !EXCLUDED.has(name) && !name.endsWith('.db') && !name.endsWith('.tgz');
}

function assertEmpty(out: string): void {
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`${out} exists and is not empty`);
  }

  mkdirSync(out, { recursive: true });
}

function copyTree(root: string, out: string): string[] {
  const copied: string[] = [];
  for (const entry of COPIED) {
    const source = join(root, entry);
    if (!existsSync(source)) {
      if (REQUIRED.has(entry)) {
        throw new Error(`${entry} is missing at ${root}`);
      }

      continue;
    }

    cpSync(source, join(out, entry), { recursive: true, filter: included });
    copied.push(entry);
  }

  return copied;
}

export function pinWorkspaceSpecs(
  deps: Readonly<Record<string, string>> | undefined,
  versions: ReadonlyMap<string, string>,
): Record<string, string> | undefined {
  if (deps === undefined) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(deps).map(([name, spec]) => {
      const version = versions.get(name);
      if (!spec.startsWith('workspace:') || version === undefined) {
        return [name, spec];
      }

      const range = spec.slice('workspace:'.length);

      return [name, range === '^' || range === '~' ? `${range}${version}` : version];
    }),
  );
}

function pinManifests(out: string, versions: ReadonlyMap<string, string>): void {
  const manifests = walk(out).filter((path) => basename(path) === 'package.json');
  for (const file of manifests) {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (manifest[field] !== undefined) {
        manifest[field] = pinWorkspaceSpecs(manifest[field] as Record<string, string>, versions);
      }
    }

    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function writeExampleWorkspaces(root: string, out: string): void {
  const examples = join(out, 'examples');
  if (!existsSync(examples)) {
    return;
  }

  const workspace = readFileSync(join(root, APP_WORKSPACE_TEMPLATE), 'utf8');
  for (const name of readdirSync(examples)) {
    const app = join(examples, name);
    if (existsSync(join(app, 'package.json')) && !existsSync(join(app, 'pnpm-workspace.yaml'))) {
      writeFileSync(join(app, 'pnpm-workspace.yaml'), workspace);
    }
  }
}

function rewriteReadme(out: string): void {
  const file = join(out, 'README.md');
  writeFileSync(file, userReadme(readFileSync(file, 'utf8')));
}

function packTarballs(packages: readonly WorkspacePackage[], out: string): string[] {
  const destination = join(out, 'packages');
  mkdirSync(destination, { recursive: true });

  for (const pkg of packages) {
    const result = spawnSync('pnpm', ['pack', '--pack-destination', destination], {
      cwd: pkg.dir,
      stdio: 'inherit',
    });

    if (result.status !== 0) {
      throw new Error(`pnpm pack failed for ${pkg.manifest.name}`);
    }
  }

  return readdirSync(destination).filter((name) => name.endsWith('.tgz'));
}

export function snapshot(options: SnapshotOptions): string[] {
  assertEmpty(options.out);
  const packages = publishOrder(publishablePackages(options.root));
  const versions = new Map(packages.map((pkg) => [pkg.manifest.name, pkg.manifest.version]));
  const copied = copyTree(options.root, options.out);
  rewriteReadme(options.out);
  pinManifests(options.out, versions);
  writeExampleWorkspaces(options.root, options.out);
  const tarballs = options.tarballs ? packTarballs(packages, options.out) : [];
  const notes = releaseNotes({ sha: options.sha, date: options.date, packages, tarballs });
  writeFileSync(join(options.out, 'RELEASE.md'), notes);

  return [...copied, ...(tarballs.length > 0 ? ['packages'] : []), 'RELEASE.md'];
}
