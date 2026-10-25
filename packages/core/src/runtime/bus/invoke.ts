import type { RunContext } from '../../model/context.ts';
import type { Delivery } from '../../model/delivery.ts';
import type { Envelope } from '../../model/envelope.ts';
import type { EntryFn, InvokeInit } from '../../model/ingress.ts';
import { createEnvelope } from '../envelope.ts';
import { ShutdownError } from '../errors.ts';
import { onAnyAbort } from './abort.ts';
import {
  armTimeout,
  closeEmits,
  durationMs,
  enrolScope,
  nextDeliveryId,
  race,
  report,
  runDeadline,
  serialize,
  type RunJob,
} from './job.ts';
import { registeredPiece, type BusState, type PieceEntry } from './state.ts';

interface Entry extends RunJob {
  readonly init: InvokeInit;
  readonly delivery: Delivery;
}

function ingressEnvelope(state: BusState, init: InvokeInit): Envelope {
  const envelope = createEnvelope({
    name: `$ingress.${init.transport}`,
    payload: { ...init.payload, binding: init.binding },
    ids: state.ids,
    clock: state.clock,
    source: `external:${init.transport}`,
  });

  return { ...envelope, id: init.id ?? envelope.id, traceId: init.traceId ?? envelope.traceId };
}

function entryRun(
  state: BusState,
  piece: PieceEntry,
  envelope: Envelope,
  ctrl: AbortController,
  deliveryId: string,
  attempt: number,
): RunContext {
  return {
    traceId: envelope.traceId,
    eventId: envelope.id,
    hop: 0,
    piece: piece.name,
    deliveryId,
    attempt,
    signal: ctrl.signal,
    deadline: runDeadline(state, piece),
    internal: false,
  };
}

function createEntry(state: BusState, piece: PieceEntry, init: InvokeInit): Entry {
  const ctrl = new AbortController();
  const envelope = ingressEnvelope(state, init);
  const deliveryId = nextDeliveryId(state);
  const attempt = init.attempt ?? 1;
  const run = entryRun(state, piece, envelope, ctrl, deliveryId, attempt);
  const entry: Entry = {
    state,
    piece,
    run,
    ctrl,
    deliveryId,
    startedAt: performance.now(),
    emits: [],
    settled: false,
    init,
    delivery: { envelope, attempt, signal: ctrl.signal, piece: piece.name },
  };
  enrolScope(entry);

  return entry;
}

function ingressRef(entry: Entry) {
  return {
    piece: entry.piece.name,
    transport: entry.init.transport,
    binding: entry.init.binding,
    traceId: entry.run.traceId,
  };
}

function linkAbort(signal: AbortSignal | undefined, ctrl: AbortController): () => void {
  if (signal?.aborted === true) {
    ctrl.abort(signal.reason);
  }

  return onAnyAbort([signal], (reason) => ctrl.abort(reason));
}

async function runEntry<R>(entry: Entry, fn: EntryFn<R>): Promise<Awaited<R>> {
  const timer = armTimeout(entry, entry.delivery.envelope.name);
  report(entry, 'ingress.received', { ...ingressRef(entry), envelope: entry.delivery.envelope });

  try {
    const result = (await race(
      entry,
      Promise.try(() => fn(entry.delivery)),
    )) as Awaited<R>;

    await closeEmits(entry);
    report(entry, 'ingress.completed', { ...ingressRef(entry), durationMs: durationMs(entry) });

    return result;
  } catch (error) {
    entry.settled = true;
    report(entry, 'ingress.failed', {
      ...ingressRef(entry),
      durationMs: durationMs(entry),
      error: serialize(entry, error),
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function invokeEntry<R>(
  state: BusState,
  pieceName: string,
  init: InvokeInit,
  fn: EntryFn<R>,
): Promise<Awaited<R>> {
  const piece = registeredPiece(state, pieceName);

  if (state.stopping.signal.aborted) {
    throw new ShutdownError(`${init.transport} ${init.binding}: the bus is stopping`);
  }

  const entry = createEntry(state, piece, init);
  const unlink = linkAbort(init.signal, entry.ctrl);
  const done = state.context.run(entry.run, () => runEntry(entry, fn));
  state.inflight.set(
    entry.ctrl,
    done.then(
      () => undefined,
      () => undefined,
    ),
  );

  try {
    return await done;
  } finally {
    state.inflight.delete(entry.ctrl);
    unlink();
  }
}
