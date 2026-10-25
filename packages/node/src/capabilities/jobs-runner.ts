import {
  backoff,
  durationMs,
  MurmurError,
  serializeError,
  ShutdownError,
  type Clock,
  type Ids,
  type IngressPort,
  type JobTarget,
  type Log,
} from 'murmur';

import {
  buryJob,
  claimJobs,
  finishJob,
  insertJob,
  leaseSchedule,
  rescheduleJob,
  type ClaimedJob,
  type ExpiredJob,
} from './jobs-store.ts';
import type { DrainResult, Sqlite } from './types.ts';

export interface RunnerConfig {
  readonly poll: boolean;
  readonly pollMs: number;
  readonly concurrency: number;
}

export interface RunnerDeps {
  readonly sql: Sqlite;
  readonly ingress: IngressPort;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly log: Log;
  readonly config: RunnerConfig;
  readonly mode: 'dev' | 'prod';
}

export interface Runner {
  drain(): Promise<DrainResult>;
  stop(signal: AbortSignal): Promise<void>;
}

type Outcome = 'ran' | 'failed' | 'dead' | 'released';

interface Running {
  readonly job: ClaimedJob;
  readonly ctrl: AbortController;
  released: boolean;
  done?: Promise<Outcome>;
}

interface State {
  readonly deps: RunnerDeps;
  readonly running: Map<string, Running>;
  readonly leased: Map<string, number>;
  targets: Map<string, JobTarget> | undefined;
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  polling: Promise<void> | undefined;
}

function nowMs(state: State): number {
  return state.deps.clock.now().epochMilliseconds;
}

function targetsOf(state: State): Map<string, JobTarget> {
  state.targets ??= new Map(state.deps.ingress.jobTargets().map((target) => [target.contract, target]));

  return state.targets;
}

function targetOf(state: State, contract: string): JobTarget {
  const target = targetsOf(state).get(contract);
  if (target === undefined) {
    throw new MurmurError(`jobs: no handler for ${contract} in this process`, { retryable: false });
  }

  return target;
}

function attemptsOf(target: JobTarget): number {
  return target.retry?.attempts ?? target.policyRetry.maxAttempts;
}

function delayOf(target: JobTarget, attempt: number): number {
  const ladder = target.retry?.after;
  if (ladder === undefined || ladder.length === 0) {
    return backoff(target.policyRetry, attempt);
  }

  return durationMs(ladder[Math.min(attempt, ladder.length) - 1]) ?? 0;
}

function retryable(error: unknown): boolean {
  return !(typeof error === 'object' && error !== null && Reflect.get(error, 'retryable') === false);
}

function jobRef(job: Pick<ClaimedJob, 'id' | 'contract' | 'attempt'>, target: JobTarget) {
  return { id: job.id, contract: job.contract, piece: target.piece, attempt: job.attempt };
}

async function settleFailure(
  state: State,
  running: Running,
  error: unknown,
  started: number,
): Promise<Outcome> {
  const { job } = running;
  const { deps } = state;
  const target = targetOf(state, job.contract);
  const serialized = serializeError(error, deps.mode === 'dev');
  const durationMs = Math.round(performance.now() - started);
  const text = `${serialized.name}: ${serialized.message}`;

  if (!retryable(error) || job.attempt >= attemptsOf(target)) {
    await buryJob(deps.sql, job, text);
    deps.ingress.report('job.dead', { ...jobRef(job, target), durationMs, error: serialized });

    return 'dead';
  }

  const runAt = nowMs(state) + delayOf(target, job.attempt);
  await rescheduleJob(deps.sql, job, { runAt, error: text, refund: false });
  const nextRunAt = Temporal.Instant.fromEpochMilliseconds(runAt).toString();
  deps.ingress.report('job.failed', { ...jobRef(job, target), durationMs, error: serialized, nextRunAt });

  return 'failed';
}

async function execute(state: State, running: Running): Promise<Outcome> {
  const { job, ctrl } = running;
  const { deps } = state;
  const target = targetOf(state, job.contract);
  const started = performance.now();
  deps.ingress.report('job.claimed', { ...jobRef(job, target), groupKey: job.groupKey ?? undefined });

  try {
    await deps.ingress.invokeLocal(job.contract, JSON.parse(job.input), {
      id: job.id,
      attempt: job.attempt,
      signal: ctrl.signal,
    });
  } catch (error) {
    return running.released ? 'released' : settleFailure(state, running, error, started);
  }

  if (running.released) {
    return 'released';
  }

  await finishJob(deps.sql, job);
  deps.ingress.report('job.succeeded', {
    ...jobRef(job, target),
    durationMs: Math.round(performance.now() - started),
  });

  return 'ran';
}

function launch(state: State, job: ClaimedJob): Promise<Outcome> {
  const running: Running = { job, ctrl: new AbortController(), released: false };
  state.running.set(job.id, running);

  const done = execute(state, running)
    .catch((error: unknown) => {
      state.deps.log.error(`jobs: ${job.contract} could not be settled`, { id: job.id, error });

      return 'released' as const;
    })
    .finally(() => state.running.delete(job.id));
  running.done = done;

  return done;
}

function lockedUntil(state: State, now: number): (contract: string) => number {
  return (contract) => now + targetOf(state, contract).timeoutMs;
}

function reportExpired(state: State, job: ExpiredJob): void {
  const { deps } = state;
  const error = new MurmurError(job.error, { code: 'jobs-claim-expired', retryable: false });

  deps.ingress.report('job.dead', {
    ...jobRef(job, targetOf(state, job.contract)),
    durationMs: 0,
    error: serializeError(error, deps.mode === 'dev'),
  });
}

async function claim(state: State, limit: number): Promise<{ claimed: ClaimedJob[]; expired: number }> {
  const contracts = [...targetsOf(state).keys()];
  const now = nowMs(state);

  if (contracts.length === 0 || limit <= 0) {
    return { claimed: [], expired: 0 };
  }

  const { claimed, expired } = await claimJobs(state.deps.sql, {
    contracts,
    busy: [...state.running.keys()],
    now,
    limit,
    lockedUntil: lockedUntil(state, now),
    attempts: (contract) => attemptsOf(targetOf(state, contract)),
    claim: () => state.deps.ids.uuid(),
  });

  for (const job of expired) {
    reportExpired(state, job);
  }

  return { claimed, expired: expired.length };
}

function scheduleDue(now: number, every: number): number {
  return Math.floor(now / every) * every;
}

async function tickOne(state: State, target: JobTarget, every: number): Promise<void> {
  const now = nowMs(state);
  const due = scheduleDue(now, every);

  if (state.leased.get(target.contract) === due) {
    return;
  }

  const dueText = Temporal.Instant.fromEpochMilliseconds(due).toString();

  await state.deps.sql.transaction(async (tx) => {
    if (!(await leaseSchedule(tx, target.contract, due))) {
      return;
    }

    await insertJob(tx, {
      id: state.deps.ids.uuid(),
      contract: target.contract,
      input: '{}',
      runAt: now,
      dedupeKey: `${target.contract}@${dueText}`,
      groupKey: null,
      now,
    });
  });

  state.leased.set(target.contract, due);
}

async function tick(state: State): Promise<void> {
  for (const target of targetsOf(state).values()) {
    const every = durationMs(target.every);
    if (every !== undefined) {
      await tickOne(state, target, every);
    }
  }
}

async function fill(state: State): Promise<void> {
  await tick(state);
  const { claimed } = await claim(state, state.deps.config.concurrency - state.running.size);
  for (const job of claimed) {
    void launch(state, job);
  }
}

async function poll(state: State): Promise<void> {
  if (state.stopped) {
    return;
  }

  state.polling = fill(state).catch((error: unknown) => {
    state.deps.log.error('jobs: poll failed', { error });
  });
  await state.polling;

  if (!state.stopped) {
    state.timer = setTimeout(() => void poll(state), state.deps.config.pollMs);
  }
}

function addOutcome(totals: { ran: number; failed: number; dead: number }, outcome: Outcome): void {
  if (outcome !== 'released') {
    totals[outcome] += 1;
  }
}

async function drainAll(state: State): Promise<DrainResult> {
  const totals = { ran: 0, failed: 0, dead: 0 };
  for (;;) {
    await tick(state);
    const { claimed, expired } = await claim(state, state.deps.config.concurrency);
    totals.dead += expired;

    if (claimed.length === 0 && expired === 0) {
      return totals;
    }

    for (const outcome of await Promise.all(claimed.map((job) => launch(state, job)))) {
      addOutcome(totals, outcome);
    }
  }
}

async function settledWithin(work: readonly Promise<unknown>[], signal: AbortSignal): Promise<void> {
  if (signal.aborted || work.length === 0) {
    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  signal.addEventListener('abort', () => resolve(), { once: true });
  await Promise.race([Promise.allSettled(work), promise]);
}

async function release(state: State, running: Running): Promise<void> {
  running.released = true;
  running.ctrl.abort(new ShutdownError('jobs stopping: the claim was released'));
  await rescheduleJob(state.deps.sql, running.job, { runAt: nowMs(state), error: null, refund: true });
}

async function stopRunner(state: State, signal: AbortSignal): Promise<void> {
  state.stopped = true;
  clearTimeout(state.timer);
  await state.polling;

  await settledWithin(
    [...state.running.values()].flatMap((running) => running.done ?? []),
    signal,
  );

  await Promise.all([...state.running.values()].map((running) => release(state, running)));
}

export function createRunner(deps: RunnerDeps): Runner {
  const state: State = {
    deps,
    running: new Map(),
    leased: new Map(),
    targets: undefined,
    stopped: false,
    timer: undefined,
    polling: undefined,
  };
  let ready = false;

  void deps.ingress.ready.then(() => {
    ready = true;

    if (deps.config.poll && targetsOf(state).size > 0) {
      void poll(state);
    }
  });

  return {
    drain: async () => {
      if (!ready) {
        throw new MurmurError(
          'jobs.drain() before the runtime started; call `await runtime.start()` first, or call it from a handler',
          { code: 'jobs-not-started', retryable: false },
        );
      }

      return drainAll(state);
    },
    stop: (signal) => stopRunner(state, signal),
  };
}
