import { bootstrap, onShutdown } from './bootstrap.ts';
import { scalar } from './db/sql.ts';
import { createRouter } from './http/router.ts';
import { closeServer, createApiServer } from './http/server.ts';
import { allRoutes } from './routes.ts';
import { SLICES } from './slices/index.ts';

function main(): void {
  const { config, db, log } = bootstrap('api');
  const cursorSecret = scalar<string>(db, `SELECT value FROM meta WHERE key = 'cursor_secret'`)!;
  const router = createRouter(allRoutes(config, SLICES));
  const server = createApiServer({ db, config, log, router, cursorSecret });
  server.listen(config.port, config.bind, () => log.info('listening', { bind: config.bind, port: config.port, testMode: config.testMode }));
  onShutdown(log, async () => {
    await closeServer(server);
    db.close();
  });
}

main();
