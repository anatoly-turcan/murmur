import type { StoredEnvelope, Trace, TraceDelivery, TraceNode } from '@murmur/dev-protocol';
import { isInternal, Rejection, type Envelope, type SerializedError, type SysEvent } from 'murmur';

import { instantMs } from '../render/time.ts';
import { isIngressName, isReplyName, metaOf } from './meta.ts';

interface Draft extends TraceDelivery {
  readonly envelopeId: string;
}

function errorText(error: SerializedError): string {
  return `${error.name}: ${error.message}`;
}

function received(payload: SysEvent<'delivery.received'>): Draft {
  return {
    envelopeId: payload.envelopeId,
    piece: payload.piece,
    attempt: payload.attempt,
    receivedAt: payload.at,
    endedAt: null,
    durationMs: null,
    outcome: 'inflight',
  };
}

function ended(draft: Draft, at: string, durationMs: number, outcome: TraceDelivery['outcome']): Draft {
  return { ...draft, endedAt: at, durationMs, outcome };
}

function failure(
  error: SerializedError,
  reason: string | undefined,
): Pick<TraceDelivery, 'error' | 'reason'> {
  return { error: errorText(error), ...(reason === undefined ? {} : { reason }) };
}

function deadLettered(draft: Draft | undefined, payload: SysEvent<'delivery.deadlettered'>): Draft {
  const base = draft ?? {
    envelopeId: payload.envelope.id,
    piece: payload.piece,
    attempt: payload.attempts,
    receivedAt: payload.at,
    endedAt: null,
    durationMs: null,
    outcome: 'inflight' as const,
  };
  const durationMs = base.durationMs ?? Math.round(instantMs(payload.at) - instantMs(base.receivedAt));

  return {
    ...ended(base, base.endedAt ?? payload.at, durationMs, 'deadLettered'),
    ...failure(payload.error, payload.reason ?? base.reason),
  };
}

function applyDelivery(drafts: Map<string, Draft>, envelope: Envelope): void {
  const payload = envelope.payload as { deliveryId: string };
  const draft = drafts.get(payload.deliveryId);

  switch (envelope.name) {
    case '$sys.delivery.received':
      drafts.set(payload.deliveryId, received(payload as SysEvent<'delivery.received'>));
      break;
    case '$sys.delivery.acked': {
      const acked = payload as SysEvent<'delivery.acked'>;
      if (draft !== undefined) {
        drafts.set(acked.deliveryId, ended(draft, acked.at, acked.durationMs, 'acked'));
      }

      break;
    }
    case '$sys.delivery.failed': {
      const failed = payload as SysEvent<'delivery.failed'>;
      if (draft !== undefined) {
        drafts.set(failed.deliveryId, {
          ...ended(draft, failed.at, failed.durationMs, 'failed'),
          ...failure(failed.error, failed.reason),
        });
      }

      break;
    }
    case '$sys.delivery.deadlettered':
      drafts.set(payload.deliveryId, deadLettered(draft, payload as SysEvent<'delivery.deadlettered'>));
      break;
  }
}

function deliveriesByEnvelope(items: readonly StoredEnvelope[]): Map<string, Draft[]> {
  const drafts = new Map<string, Draft>();
  for (const { envelope } of items) {
    if (envelope.name.startsWith('$sys.delivery.')) {
      applyDelivery(drafts, envelope);
    }
  }

  return Map.groupBy(drafts.values(), (draft) => draft.envelopeId);
}

function rejectionStatus(reply: Envelope): number | undefined {
  const payload = reply.payload as { ok?: unknown; value?: unknown };
  if (payload.ok !== true) {
    return undefined;
  }

  const parsed = Rejection.schema.safeParse(payload.value);

  return parsed.success ? parsed.data.status : undefined;
}

function answered(
  request: Envelope,
  reply: Envelope,
  underIngress: boolean,
): NonNullable<TraceNode['reply']> {
  const durationMs = Math.round(instantMs(reply.ts) - instantMs(request.ts));
  const rejected = underIngress ? rejectionStatus(reply) : undefined;

  return {
    envelopeId: reply.id,
    durationMs,
    timedOut: false,
    ...(rejected === undefined ? {} : { rejected }),
  };
}

function replyOf(
  request: Envelope,
  items: readonly StoredEnvelope[],
  underIngress: boolean,
): TraceNode['reply'] {
  if (request.correlationId === undefined) {
    return undefined;
  }

  const reply = items.find(
    ({ envelope }) => isReplyName(envelope.name) && envelope.correlationId === request.correlationId,
  );

  if (reply !== undefined) {
    return answered(request, reply.envelope, underIngress);
  }

  const timeout = items.find(
    ({ envelope }) =>
      envelope.name === '$sys.request.timeout' &&
      (envelope.payload as SysEvent<'request.timeout'>).correlationId === request.correlationId,
  );

  return timeout === undefined
    ? undefined
    : {
        envelopeId: '',
        durationMs: (timeout.envelope.payload as SysEvent<'request.timeout'>).timeoutMs,
        timedOut: true,
      };
}

function depthOf(id: string, parents: ReadonlyMap<string, string | null>): number {
  let depth = 0;
  for (let parent = parents.get(id); parent != null && depth < 1_000; parent = parents.get(parent)) {
    depth++;
  }

  return depth;
}

function stripDraft({ envelopeId: _envelopeId, ...delivery }: Draft): TraceDelivery {
  return delivery;
}

function dedupedCallers(items: readonly StoredEnvelope[]): Map<string, string[]> {
  const records = items
    .filter(({ envelope }) => envelope.name === '$sys.request.deduped')
    .map(({ envelope }) => envelope.payload as SysEvent<'request.deduped'>);
  const byLeader = Map.groupBy(records, (record) => record.firstEnvelopeId);

  return new Map([...byLeader].map(([leader, list]) => [leader, list.map((record) => record.byPiece)]));
}

function dedupeOf(callers: readonly string[] | undefined): Pick<TraceNode, 'deduped'> {
  if (callers === undefined) {
    return {};
  }

  return { deduped: { count: callers.length, by: [...new Set(callers)] } };
}

function nodesOf(user: readonly StoredEnvelope[], items: readonly StoredEnvelope[]): TraceNode[] {
  const ids = new Set(user.map(({ envelope }) => envelope.id));
  const parents = new Map(
    user.map(({ envelope: e }) => [
      e.id,
      e.causationId !== undefined && ids.has(e.causationId) ? e.causationId : null,
    ]),
  );
  const deliveries = deliveriesByEnvelope(items);
  const ingress = new Set(
    user.filter(({ envelope }) => isIngressName(envelope.name)).map(({ envelope }) => envelope.id),
  );
  const deduped = dedupedCallers(items);

  return user.map(({ envelope }) => {
    const reply = replyOf(envelope, items, ingress.has(parents.get(envelope.id) ?? ''));

    return {
      id: envelope.id,
      parentId: parents.get(envelope.id) ?? null,
      depth: depthOf(envelope.id, parents),
      envelope,
      deliveries: (deliveries.get(envelope.id) ?? []).map(stripDraft),
      ...(reply === undefined ? {} : { reply }),
      ...dedupeOf(deduped.get(envelope.id)),
    };
  });
}

function endOf(nodes: readonly TraceNode[], items: readonly StoredEnvelope[]): string | null {
  const deliveries = nodes.flatMap((node) => node.deliveries);
  if (deliveries.some((delivery) => delivery.endedAt === null)) {
    return null;
  }

  const instants = [
    ...nodes.map((node) => node.envelope.ts),
    ...deliveries.flatMap((delivery) => delivery.endedAt ?? []),
    ...items.filter(({ envelope }) => isReplyName(envelope.name)).map(({ envelope }) => envelope.ts),
  ];

  return instants.reduce((latest, ts) => (instantMs(ts) > instantMs(latest) ? ts : latest));
}

function untappedIngressEntries(items: readonly StoredEnvelope[]): StoredEnvelope[] {
  const storedIds = new Set(items.map(({ envelope }) => envelope.id));

  return items
    .filter(({ envelope }) => envelope.name === '$sys.ingress.received')
    .map(({ seq, envelope }) => ({
      seq,
      envelope: (envelope.payload as SysEvent<'ingress.received'>).envelope,
    }))
    .filter(({ envelope }) => !storedIds.has(envelope.id))
    .map(({ seq, envelope }) => ({ seq, envelope, meta: metaOf(envelope) }));
}

function uniqueById(items: readonly StoredEnvelope[]): StoredEnvelope[] {
  return [...Map.groupBy(items, (stored) => stored.envelope.id).values()].flatMap((group) =>
    group.slice(0, 1),
  );
}

function userEnvelopes(items: readonly StoredEnvelope[]): StoredEnvelope[] {
  const user = items.filter(({ envelope }) => !isInternal(envelope.name) && !isReplyName(envelope.name));

  return [...untappedIngressEntries(items), ...user].toSorted((a, b) => a.seq - b.seq);
}

function backgroundOf(items: readonly StoredEnvelope[]): Pick<Trace, 'background'> {
  const record = items.find(({ envelope }) => envelope.name === '$sys.emit.background');
  if (record === undefined) {
    return {};
  }

  return { background: { piece: (record.envelope.payload as SysEvent<'emit.background'>).piece } };
}

export function buildTrace(items: readonly StoredEnvelope[]): Trace | null {
  const user = userEnvelopes(items);
  const nodes = nodesOf(uniqueById(user), items);
  const rootNode = nodes.find((node) => node.parentId === null);
  const root = user.find((stored) => stored.envelope.id === rootNode?.id);

  if (rootNode === undefined || root === undefined) {
    return null;
  }

  const endedAt = endOf(nodes, items);
  const deliveries = nodes.flatMap((node) => node.deliveries);

  return {
    traceId: root.envelope.traceId,
    root,
    nodes,
    startedAt: root.envelope.ts,
    endedAt,
    durationMs: endedAt === null ? null : Math.round(instantMs(endedAt) - instantMs(root.envelope.ts)),
    failed: deliveries.some((d) => d.outcome === 'failed' || d.outcome === 'deadLettered'),
    maxHop: Math.max(...nodes.map((node) => node.envelope.hop)),
    ...backgroundOf(items),
  };
}
