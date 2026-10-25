import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { bootstrap, onShutdown } from './bootstrap.ts';
import { buildHandlers } from './jobs/registry.ts';
import { heartbeat, sweep, unregister } from './jobs/recovery.ts';
import { startRunner } from './jobs/runner.ts';
import { errorFields } from './log.ts';
import { startSchedulerDriver } from './scheduler/scheduler.ts';
import { schedulerRules, SLICES } from './slices/index.ts';
import { appNow } from './time/clock.ts';

const LIVENESS_INTERVAL_MS = 500;

function main(): void {
  const { config, db, log } = bootstrap('worker');
  const workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const handlers = buildHandlers(SLICES);
  const now = () => appNow(db, config.testMode);
  heartbeat(db, workerId, process.pid, Date.now());
  const liveness = setInterval(() => {
    try {
      heartbeat(db, workerId, process.pid, Date.now());
      sweep(db, handlers, now, log);
    } catch (err) {
      log.warn('liveness tick failed', errorFields(err));
    }
  }, LIVENESS_INTERVAL_MS);
  sweep(db, handlers, now, log);
  const runner = startRunner({ db, config, log, workerId, handlers, slots: 8, pollMs: config.testMode ? 25 : 200 });
  const scheduler = config.testMode ? null : startSchedulerDriver(db, config, log, schedulerRules(SLICES));
  log.info('worker started', { workerId, types: Object.keys(handlers), testMode: config.testMode });
  onShutdown(log, async () => {
    scheduler?.stop();
    await runner.stop(3000);
    clearInterval(liveness);
    unregister(db, workerId);
    db.close();
  });
}

main();
