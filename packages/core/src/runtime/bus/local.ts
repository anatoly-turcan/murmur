import type { Envelope } from '../../model/envelope.ts';
import type { TransportDelivery } from '../transport.ts';
import type { BusState, PieceEntry } from './state.ts';

export type ReplySettler = (reply: Envelope) => Promise<void>;

export interface LocalDelivery extends TransportDelivery {
  readonly settleReply: ReplySettler;
}

export type Dispatch = (delivery: TransportDelivery) => Promise<void>;

export function isLocalDelivery(delivery: TransportDelivery): delivery is LocalDelivery {
  return 'settleReply' in delivery;
}

export function localResponder(state: BusState, name: string): PieceEntry | undefined {
  const owner = state.localRequests ? state.responders.get(name) : undefined;

  return owner === undefined ? undefined : state.pieces.get(owner);
}

interface LocalRun {
  readonly state: BusState;
  readonly dispatch: Dispatch;
  readonly envelope: Envelope;
  readonly settleReply: ReplySettler;
}

function redeliver(run: LocalRun, attempt: number, delayMs: number): void {
  setTimeout(() => {
    if (!run.state.stopping.signal.aborted) {
      deliver(run, attempt);
    }
  }, delayMs);
}

function localDelivery(run: LocalRun, attempt: number): LocalDelivery {
  return {
    envelope: run.envelope,
    attempt,
    redelivered: attempt > 1,
    settleReply: run.settleReply,
    ack: async () => {},
    nack: async (requeue, options = {}) => {
      if (!requeue || run.state.stopping.signal.aborted) {
        return;
      }

      redeliver(run, options.consumeAttempt === false ? attempt : attempt + 1, options.delayMs ?? 0);
    },
  };
}

function deliver(run: LocalRun, attempt: number): void {
  run.dispatch(localDelivery(run, attempt)).catch(() => {});
}

export function deliverLocally(run: LocalRun): void {
  deliver(run, 1);
}
