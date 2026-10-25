import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';

import type { WorkspacePackage } from './manifest.ts';
import { publishablePackages } from './manifest.ts';
import { publishOrder } from './order.ts';
import { metadataCacheWarning } from './pnpm-cache.ts';
import { isPublished, throwawayToken, writeUserConfig } from './registry.ts';

export interface PublishOptions {
  readonly root: string;
  readonly registry: string;
  readonly token: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly log: (line: string) => void;
  readonly force: boolean;
  readonly cacheRoot: string;
}

export type PublishOutcome = 'published' | 'skipped';

function label(pkg: WorkspacePackage): string {
  return `${pkg.manifest.name}@${pkg.manifest.version}`;
}

function publishOne(pkg: WorkspacePackage, registry: string, env: NodeJS.ProcessEnv): void {
  const args = ['publish', '--registry', registry, '--no-git-checks', '--access', 'public'];
  const result = spawnSync('pnpm', args, { cwd: pkg.dir, env, stdio: 'inherit' });

  if (result.status !== 0) {
    throw new Error(`pnpm publish failed for ${pkg.manifest.name} (exit ${result.status})`);
  }
}

async function alreadyPublished(
  packages: readonly WorkspacePackage[],
  registry: string,
): Promise<Set<WorkspacePackage>> {
  const present = await Promise.all(
    packages.map((pkg) => isPublished(registry, pkg.manifest.name, pkg.manifest.version)),
  );

  return new Set(packages.filter((_, i) => present[i]));
}

function refusal(existing: ReadonlySet<WorkspacePackage>, registry: string): Error {
  return new Error(
    [
      `already on ${registry}: ${[...existing].map(label).join(', ')}`,
      'A published version is never replaced: bump the version to ship changed code,',
      'or pass --force to publish only the missing packages and skip these.',
    ].join('\n'),
  );
}

async function withUserConfig<T>(options: PublishOptions, work: (env: NodeJS.ProcessEnv) => T): Promise<T> {
  const token = options.token ?? (await throwawayToken(options.registry));
  const userConfig = writeUserConfig(options.registry, token);

  try {
    return work({ ...options.env, npm_config_userconfig: userConfig });
  } finally {
    rmSync(dirname(userConfig), { recursive: true, force: true });
  }
}

function publishMissing(
  packages: readonly WorkspacePackage[],
  existing: ReadonlySet<WorkspacePackage>,
  options: PublishOptions,
  env: NodeJS.ProcessEnv,
): Map<string, PublishOutcome> {
  const outcomes = new Map<string, PublishOutcome>();
  for (const pkg of packages) {
    if (existing.has(pkg)) {
      options.log(`skip ${label(pkg)} (already on ${options.registry})`);
      outcomes.set(pkg.manifest.name, 'skipped');
      continue;
    }

    options.log(`publish ${label(pkg)}`);
    publishOne(pkg, options.registry, env);
    outcomes.set(pkg.manifest.name, 'published');
  }

  return outcomes;
}

export async function publish(options: PublishOptions): Promise<Map<string, PublishOutcome>> {
  const packages = publishOrder(publishablePackages(options.root));
  const existing = await alreadyPublished(packages, options.registry);

  if (existing.size > 0 && !options.force) {
    throw refusal(existing, options.registry);
  }

  if (existing.size === packages.length) {
    return publishMissing(packages, existing, options, options.env);
  }

  const outcomes = await withUserConfig(options, (env) => publishMissing(packages, existing, options, env));
  options.log(metadataCacheWarning(options.registry, options.cacheRoot));

  return outcomes;
}
