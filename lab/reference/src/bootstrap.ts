import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, type Config } from './config.ts';
import { openDatabase } from './db/connection.ts';
import { migrate } from './db/migrate.ts';
import { createLogger, type Logger } from './log.ts';

export interface Runtime {
  config: Config;
  db: DatabaseSync;
  log: Logger;
}

export function bootstrap(component: string): Runtime {
  const config = loadConfig();
  const log = createLogger(config.logLevel, component);
  const db = openDatabase(config.databaseUrl);
  const applied = migrate(db);
  if (applied.length > 0) log.info('migrations applied', { files: applied });

  return { config, db, log };
}

export function onShutdown(log: Logger, stop: () => Promise<void>): void {
  let stopping = false;
  const handler = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(0), 4500);
    stop()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(force);
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}
