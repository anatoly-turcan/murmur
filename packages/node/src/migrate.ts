import { join, resolve } from 'node:path';

import { SqliteError } from './capabilities/sqlite-error.ts';
import {
  databasePath,
  openConfigured,
  sqliteConfig,
  unmatchedSources,
  type SqliteConfig,
} from './capabilities/sqlite.ts';
import { resolveCapabilityConfig } from './config/resolve.ts';
import { readYamlConfig, type Env } from './config/sources.ts';

export interface MigrateResult {
  readonly path: string;
  readonly files: readonly string[];
  readonly applied: readonly string[];
  readonly unmatched: readonly string[];
}

export async function sqliteSettings(root: string, env: Env): Promise<SqliteConfig> {
  const yaml = await readYamlConfig(join(root, 'murmur.yaml'), env);

  return (await resolveCapabilityConfig('sqlite', sqliteConfig, { env, yaml })) as SqliteConfig;
}

function fileBacked(base: string, config: SqliteConfig): void {
  if (databasePath(base, config.path) === ':memory:') {
    throw new SqliteError(
      'migrate: capabilities.sqlite.path is :memory:, so the migrations would land in a throwaway database; set capabilities.sqlite.path in murmur.yaml to a file, e.g. sqlite:./app.db',
    );
  }
}

export async function migrate(root: string, env: Env = process.env): Promise<MigrateResult> {
  const base = resolve(root);
  const config = await sqliteSettings(base, env);
  fileBacked(base, config);
  const database = openConfigured(base, config);

  try {
    const report = await database.migrate(config.migrations, base);

    return {
      path: databasePath(base, config.path),
      files: report.files.map((file) => file.name),
      applied: report.applied,
      unmatched: unmatchedSources(report),
    };
  } finally {
    database.close();
  }
}
