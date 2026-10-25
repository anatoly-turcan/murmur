import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { Logger } from '../log.ts';
import type { Router } from './router.ts';

export interface App {
  db: DatabaseSync;
  config: Config;
  log: Logger;
  router: Router;
  cursorSecret: string;
}
