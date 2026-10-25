import type { StoredEnvelope } from '@murmur/dev-protocol';

import { ringByRef, type Ring } from './ring.ts';
import { deliveryFact, type DeliveryFact } from './sys.ts';

export type RowOutcome = 'pending' | 'inflight' | 'acked' | 'retried' | 'failed' | 'deadLettered';

export interface EventRow {
  stored: StoredEnvelope;
  from: string | null;
  to: string[];
  attempt: number | null;
  durationMs: number | null;
  outcome: RowOutcome;
}

const RANK: Record<RowOutcome, number> = {
  pending: 0,
  acked: 1,
  inflight: 2,
  retried: 3,
  failed: 4,
  deadLettered: 5,
};

function outcomeOf(fact: DeliveryFact): RowOutcome {
  if (fact.kind === 'received') {
    return 'inflight';
  }

  if (fact.kind === 'acked') {
    return 'acked';
  }

  if (fact.kind === 'deadlettered') {
    return 'deadLettered';
  }

  if (fact.kind === 'failed' && !fact.willRetry) {
    return 'failed';
  }

  return 'retried';
}

function latestPerPiece(facts: DeliveryFact[]): Map<string, RowOutcome> {
  const latest = new Map<string, RowOutcome>();
  for (const fact of facts) {
    const next = outcomeOf(fact);
    const current = latest.get(fact.piece);
    const terminal = current === 'deadLettered' || current === 'failed';

    if (!terminal || RANK[next] > RANK[current]) {
      latest.set(fact.piece, next);
    }
  }

  return latest;
}

function worst(outcomes: Iterable<RowOutcome>): RowOutcome {
  let result: RowOutcome = 'pending';
  for (const outcome of outcomes) {
    if (RANK[outcome] > RANK[result]) {
      result = outcome;
    }
  }

  return result;
}

export function deliveryFacts(ring: Ring, envelopeId: string): DeliveryFact[] {
  return ringByRef(ring, envelopeId).flatMap((stored) => deliveryFact(stored) ?? []);
}

function internalRow(stored: StoredEnvelope): EventRow {
  const fact = deliveryFact(stored);

  return {
    stored,
    from: stored.envelope.source ?? null,
    to: stored.meta.piece ? [stored.meta.piece] : [],
    attempt: stored.meta.attempt ?? fact?.attempt ?? null,
    durationMs: stored.meta.durationMs ?? fact?.durationMs ?? null,
    outcome: stored.meta.failed ? 'failed' : 'acked',
  };
}

export function eventRow(ring: Ring, stored: StoredEnvelope): EventRow {
  if (stored.meta.internal) {
    return internalRow(stored);
  }

  const facts = deliveryFacts(ring, stored.envelope.id);
  const outcomes = latestPerPiece(facts);
  const finished = facts.filter((f) => f.durationMs !== null);

  return {
    stored,
    from: stored.envelope.source ?? null,
    to: [...outcomes.keys()],
    attempt: facts.length ? Math.max(...facts.map((f) => f.attempt)) : null,
    durationMs: finished.at(-1)?.durationMs ?? null,
    outcome: worst(outcomes.values()),
  };
}
