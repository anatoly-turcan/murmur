import type { RunContext } from '../../model/context.ts';
import { serializeError, type SerializedError } from '../../model/errors.ts';
import type { SysName, SysPayloads } from '../../model/internal.ts';
import { HandlerTimeoutError } from '../errors.ts';
import { raceAbort } from './abort.ts';
import { drainEmits } from './emit-scope.ts';
import { aboutRun, type BusState, type EmitScope, type PieceEntry } from './state.ts';

export interface RunJob {
  readonly state: BusState;
  readonly piece: PieceEntry;
  readonly run: RunContext;
  readonly ctrl: AbortController;
  readonly deliveryId: string;
  readonly startedAt: number;
  readonly emits: Promise<void>[];
  settled: boolean;
}

export function nextDeliveryId(state: BusState): string {
  return `${state.instanceId}-${++state.counters.deliveries}`;
}

export function runDeadline(state: BusState, piece: PieceEntry): string {
  return state.clock.now().add({ milliseconds: piece.policy.timeoutMs }).toString();
}

export function report<K extends SysName>(job: RunJob, name: K, payload: SysPayloads[K]): void {
  if (!job.run.internal) {
    job.state.sys(name, payload, aboutRun(job.run));
  }
}

export function durationMs(job: RunJob): number {
  return Math.round(performance.now() - job.startedAt);
}

export function serialize(job: RunJob, error: unknown): SerializedError {
  return serializeError(error, job.state.mode === 'dev');
}

export function scopeOf(job: RunJob): EmitScope {
  return {
    state: job.state,
    piece: job.piece,
    run: job.run,
    emits: job.emits,
    isLate: () => job.settled,
  };
}

export function enrolScope(job: RunJob): EmitScope {
  const scope = scopeOf(job);
  job.state.scopes.set(job.run, scope);

  return scope;
}

function watchZombie(job: RunJob, work: Promise<unknown>): void {
  const { state } = job;
  const tracked: Promise<unknown> = work
    .then(
      () => undefined,
      (error: unknown) => {
        if (error === job.ctrl.signal.reason) {
          return;
        }

        report(job, 'delivery.zombie-failed', {
          deliveryId: job.deliveryId,
          piece: job.piece.name,
          error: serialize(job, error),
        });
      },
    )
    .finally(() => state.zombies.delete(tracked));
  state.zombies.add(tracked);
}

export function race(job: RunJob, work: Promise<unknown>): Promise<unknown> {
  return raceAbort(work, job.ctrl.signal, () => watchZombie(job, work));
}

export async function closeEmits(job: RunJob): Promise<void> {
  await drainEmits(job.emits);
  job.settled = true;
  await drainEmits(job.emits);
}

export function armTimeout(job: RunJob, contract: string): ReturnType<typeof setTimeout> {
  const { timeoutMs } = job.piece.policy;

  return setTimeout(
    () => job.ctrl.abort(new HandlerTimeoutError(job.piece.name, contract, timeoutMs)),
    timeoutMs,
  );
}
