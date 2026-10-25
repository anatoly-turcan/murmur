import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { immediate } from '../db/tx.ts';
import { errorFields, type Logger } from '../log.ts';
import { appNow } from '../time/clock.ts';
import { claimNext, isOwned } from './claim.ts';
import { applyResult, genericFailure } from './queue.ts';
import type { JobContext, JobHandlers, JobOutcome, JobRow, JobType } from './types.ts';

export interface RunnerOptions {
  db: DatabaseSync;
  config: Config;
  log: Logger;
  workerId: string;
  handlers: JobHandlers;
  slots: number;
  pollMs: number;
}

export interface Runner {
  stop(timeoutMs: number): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jobContext(opts: RunnerOptions): JobContext {
  return {
    db: opts.db,
    config: opts.config,
    log: opts.log,
    workerId: opts.workerId,
    now: () => appNow(opts.db, opts.config.testMode),
    begin: (fn) => immediate(opts.db, fn),
  };
}

async function runHandler(opts: RunnerOptions, ctx: JobContext, job: JobRow): Promise<JobOutcome> {
  const handler = opts.handlers[job.type];
  if (!handler) return { result: { status: 'dead', error: `no handler for ${job.type}` } };
  try {
    return await handler.run(job, ctx);
  } catch (err) {
    return { result: genericFailure(job.attempt_count, ctx.now(), messageOf(err)) };
  }
}

function commitOutcome(opts: RunnerOptions, job: JobRow, outcome: JobOutcome, now: number): boolean {
  return immediate(opts.db, () => {
    if (!isOwned(opts.db, job.id, opts.workerId)) return false;
    outcome.apply?.();
    applyResult(opts.db, job, outcome.result, now);

    return true;
  });
}

function finish(opts: RunnerOptions, ctx: JobContext, job: JobRow, outcome: JobOutcome): { applied: boolean; outcome: JobOutcome } {
  try {
    return { applied: commitOutcome(opts, job, outcome, ctx.now()), outcome };
  } catch (err) {
    opts.log.error('job outcome failed to commit', { job: job.id, ...errorFields(err) });
    const fallback: JobOutcome = { result: genericFailure(job.attempt_count, ctx.now(), messageOf(err)) };

    return { applied: commitOutcome(opts, job, fallback, ctx.now()), outcome: fallback };
  }
}

async function execute(opts: RunnerOptions, ctx: JobContext, job: JobRow): Promise<void> {
  const started = performance.now();
  const done = finish(opts, ctx, job, await runHandler(opts, ctx, job));
  if (done.applied) done.outcome.afterCommit?.();
  opts.log.info('job', {
    job: job.id,
    type: job.type,
    attempt: job.attempt_count,
    outcome: done.applied ? done.outcome.result.status : 'discarded',
    ms: Math.round(performance.now() - started),
  });
}

function tryClaim(opts: RunnerOptions, ctx: JobContext, types: readonly JobType[]): JobRow | null {
  try {
    return claimNext(opts.db, opts.workerId, ctx.now(), types);
  } catch (err) {
    opts.log.warn('claim failed', errorFields(err));

    return null;
  }
}

export function startRunner(opts: RunnerOptions): Runner {
  const ctx = jobContext(opts);
  const types = Object.keys(opts.handlers) as JobType[];
  const inflight = new Set<Promise<void>>();
  let stopping = false;

  const track = (job: JobRow) => {
    const p: Promise<void> = execute(opts, ctx, job)
      .catch((err) => opts.log.error('job crashed', { job: job.id, ...errorFields(err) }))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };

  const loop = async () => {
    while (!stopping) {
      if (inflight.size >= opts.slots) {
        await Promise.race(inflight);
        continue;
      }
      const job = tryClaim(opts, ctx, types);
      if (job) track(job);
      else await sleep(opts.pollMs);
    }
  };
  const looping = loop();

  return {
    async stop(timeoutMs) {
      stopping = true;
      await looping;
      await Promise.race([Promise.allSettled([...inflight]), sleep(timeoutMs)]);
    },
  };
}
