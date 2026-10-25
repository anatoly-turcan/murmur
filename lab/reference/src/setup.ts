import { bootstrap } from './bootstrap.ts';

const { db, log } = bootstrap('setup');
log.info('database schema is up to date');
db.close();
