import { serializeError } from '../../model/errors.ts';
import { ShutdownError } from '../errors.ts';
import { answeredLocally, closeRequests } from './request.ts';
import { inSequence, sinkLine, type BusState } from './state.ts';
import type { StopOptions } from './types.ts';

type Phase = () => Promise<unknown>;

async function settledWithin(work: readonly Promise<unknown>[], ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(resolve, ms, false);
  });

  try {
    return await Promise.race([Promise.allSettled(work).then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function attempt(state: BusState, errors: unknown[], name: string, phase: Phase): Promise<void> {
  try {
    await phase();
  } catch (error) {
    errors.push(error);
    sinkLine(state, {
      level: 'error',
      piece: 'bus',
      msg: `stop: ${name} failed`,
      error: serializeError(error, state.mode === 'dev'),
    });
  }
}

function abortInflight(state: BusState, reason: string): void {
  for (const ctrl of state.inflight.keys()) {
    ctrl.abort(new ShutdownError(`bus stopping: ${reason}`));
  }
}

async function stopPieces(state: BusState, errors: unknown[], forceMs: number): Promise<void> {
  await inSequence(state.registrations.toReversed(), (registration) =>
    attempt(state, errors, `onStop ${registration.piece}`, () =>
      registration.stop(AbortSignal.timeout(forceMs)),
    ),
  );
}

async function dispose(stack: AsyncDisposable | undefined): Promise<void> {
  await stack?.[Symbol.asyncDispose]();
}

async function closeTransport(state: BusState, forceMs: number): Promise<void> {
  await Promise.all([...state.observers].map((subscription) => subscription.unsubscribe()));
  state.observers.clear();
  await state.transport.close(AbortSignal.timeout(forceMs));
}

export async function stopBus(state: BusState, reason: string, options: StopOptions = {}): Promise<void> {
  const { graceMs = 10_000, forceMs = 2_000 } = options;
  const started = performance.now();
  const errors: unknown[] = [];
  state.sys('runtime.stopping', { reason });
  state.stopping.abort(new ShutdownError(`bus stopping: ${reason}`));
  await attempt(state, errors, 'ingress', () => dispose(state.stacks.ingress));
  await attempt(state, errors, 'unsubscribe', () => state.subscriptions.disposeAsync());
  const drained = await settledWithin([...state.inflight.values()], graceMs);
  abortInflight(state, reason);
  const settled = await settledWithin([...state.inflight.values(), ...state.zombies], forceMs);
  await stopPieces(state, errors, forceMs);
  await settledWithin(answeredLocally(state), forceMs);
  await attempt(state, errors, 'requests', () => closeRequests(state, reason));
  await attempt(state, errors, 'capabilities', () => dispose(state.stacks.capabilities));
  const durationMs = Math.round(performance.now() - started);
  state.sys('runtime.stopped', { drained, forced: !settled, durationMs });
  await attempt(state, errors, 'transport', () => closeTransport(state, forceMs));

  if (errors.length > 0) {
    throw errors[0];
  }
}
