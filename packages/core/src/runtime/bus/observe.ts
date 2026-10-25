import type { RunContext } from '../../model/context.ts';
import type { Envelope } from '../../model/envelope.ts';
import { serializeError } from '../../model/errors.ts';
import type { TransportDelivery, Subscription } from '../transport.ts';
import { sinkLine, type BusState } from './state.ts';

export type ObserverFn = (e: Envelope) => void | Promise<void>;

const OBSERVER_OPTIONS = Object.freeze({
  prefetch: 64,
  exclusive: true,
  retention: Object.freeze({ maxLength: 10_000, ttlMs: 60_000 }),
});

function observerRun(state: BusState, piece: string, envelope: Envelope): RunContext {
  return {
    piece,
    internal: true,
    traceId: envelope.traceId,
    hop: envelope.hop,
    signal: state.stopping.signal,
  };
}

async function notify(state: BusState, piece: string, fn: ObserverFn, envelope: Envelope): Promise<void> {
  try {
    await fn(envelope);
  } catch (error) {
    sinkLine(state, {
      level: 'error',
      piece,
      msg: `observer failed on ${envelope.name}`,
      traceId: envelope.traceId,
      error: serializeError(error, state.mode === 'dev'),
    });
  }
}

async function onObserved(
  state: BusState,
  piece: string,
  fn: ObserverFn,
  delivery: TransportDelivery,
): Promise<void> {
  await delivery.ack();
  const { envelope } = delivery;
  await state.context.run(observerRun(state, piece, envelope), () => notify(state, piece, fn, envelope));
}

export async function observe(
  state: BusState,
  pattern: string,
  name: string,
  fn: ObserverFn,
): Promise<Subscription> {
  const piece = `$observer.${name}`;
  const group = `${piece}.${state.instanceId}`;

  const subscription = await state.transport.subscribe(
    [pattern],
    group,
    (delivery) => onObserved(state, piece, fn, delivery),
    OBSERVER_OPTIONS,
  );

  state.observers.add(subscription);

  return subscription;
}
