import type { ContractView, PieceView, StoredEnvelope } from '@murmur/dev-protocol';
import type { ReactNode } from 'react';

import { emitFixture } from '../api/emit.ts';
import { formatRoute } from '../router.ts';
import { useShell } from '../shell.ts';
import type { PieceLive } from '../store/live.ts';
import { ringByPiece, ringByTrace, type Ring } from '../store/ring.ts';
import { deliveryFact } from '../store/sys.ts';
import { kindMark } from './contract-kind.ts';
import { Json } from './Json.tsx';
import { ContractName } from './KindBadge.tsx';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 py-0.5">
      <span className="text-ink-muted">{label}</span>
      <span className="min-w-0 font-mono text-xs break-all">{children}</span>
    </div>
  );
}

function lastFailure(ring: Ring, piece: string): string | null {
  const facts = ringByPiece(ring, piece).flatMap((s) => deliveryFact(s) ?? []);
  const failed = facts.findLast(
    (f) => f.piece === piece && (f.kind === 'failed' || f.kind === 'deadlettered'),
  );

  return failed ? `${failed.error ?? 'failed'} (attempt ${failed.attempt})` : null;
}

export function PieceCard({
  piece,
  live,
  ring,
  contracts,
}: {
  piece: PieceView;
  live: PieceLive | undefined;
  ring: Ring;
  contracts: ContractView[];
}): ReactNode {
  const shell = useShell();
  const counters = live?.counters ?? piece.counters;
  const handled = contracts.filter((c) => piece.handles.includes(c.name));
  const failure = lastFailure(ring, piece.name);
  const emit = (c: ContractView) =>
    emitFixture(c).then(
      (r) => shell.toast(`emitted ${c.name} → trace ${r.traceId.slice(0, 8)}`),
      (e: unknown) => shell.toast(String(e instanceof Error ? e.message : e), 'error'),
    );

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="font-semibold">{piece.title}</div>
        <div className="text-ink-muted">{piece.summary ?? 'no summary'}</div>
      </div>
      <div>
        <Field label="status">{piece.status}</Field>
        <Field label="counters">
          {counters.received} recv · {counters.acked} ok · {counters.failed} fail · {counters.retried} retry ·{' '}
          {counters.deadLettered} dead · {counters.inflight} inflight
        </Field>
        <Field label="needs">{piece.needs.join(', ') || '—'}</Field>
        <Field label="last failure">{failure ? <span className="text-fail">{failure}</span> : '—'}</Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <a
          className="rounded border border-line px-2 py-1 hover:border-accent"
          href={formatRoute({ screen: 'piece', path: piece.name })}
        >
          open
        </a>
        <a
          className="rounded border border-line px-2 py-1 hover:border-accent"
          href={formatRoute({ screen: 'piece', path: piece.name, params: { tab: 'Context' } })}
        >
          ctx
        </a>
        {handled.map((c) => (
          <button
            key={c.name}
            type="button"
            className="rounded border border-line px-2 py-1 font-mono text-xs hover:border-accent"
            onClick={() => void emit(c)}
          >
            emit {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function related(ring: Ring, stored: StoredEnvelope) {
  const trace = ringByTrace(ring, stored.envelope.traceId).filter((s) => !s.meta.internal);
  const parent = trace.find((s) => s.envelope.id === stored.envelope.causationId) ?? null;
  const children = trace.filter((s) => s.envelope.causationId === stored.envelope.id);

  return { parent, children };
}

export function EventCard({ stored, ring }: { stored: StoredEnvelope; ring: Ring }): ReactNode {
  const shell = useShell();
  const { envelope } = stored;
  const { parent, children } = related(ring, stored);
  const { payload, ...headers } = envelope;

  return (
    <div className="flex flex-col gap-3">
      <div className="font-mono font-semibold">{envelope.name}</div>
      <div>
        {Object.entries(headers).map(([k, v]) => (
          <Field key={k} label={k}>
            {String(v)}
          </Field>
        ))}
      </div>
      <Json value={payload} />
      <div className="flex flex-col gap-1">
        {parent ? (
          <button
            type="button"
            className="text-left text-accent"
            onClick={() => shell.openDrawer({ kind: 'event', seq: parent.seq })}
          >
            ↑ parent {parent.envelope.name}
          </button>
        ) : null}
        {children.map((c) => (
          <button
            key={c.seq}
            type="button"
            className="text-left text-accent"
            onClick={() => shell.openDrawer({ kind: 'event', seq: c.seq })}
          >
            ↓ child {c.envelope.name}
          </button>
        ))}
      </div>
      <a
        className="w-fit rounded border border-line px-2 py-1 hover:border-accent"
        href={formatRoute({ screen: 'traces', traceId: envelope.traceId })}
      >
        open trace
      </a>
    </div>
  );
}

export function ContractCard({ contract }: { contract: ContractView }): ReactNode {
  const shell = useShell();
  const emit = () =>
    emitFixture(contract).then(
      (r) => shell.toast(`emitted ${contract.name} → trace ${r.traceId.slice(0, 8)}`),
      (e: unknown) => shell.toast(String(e instanceof Error ? e.message : e), 'error'),
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="font-semibold">
        <ContractName contract={contract} />
      </div>
      <div>
        <Field label="kind">{kindMark(contract).title}</Field>
        <Field label="wire name">{contract.name}</Field>
        <Field label="visibility">
          {contract.visibility}
          {contract.scope ? ` (${contract.scope})` : ''}
        </Field>
        <Field label="file">{contract.file}</Field>
        <Field label="emitters">{contract.emitters.join(', ') || '—'}</Field>
        <Field label="requesters">{contract.requesters?.join(', ') || '—'}</Field>
        <Field label="handlers">{contract.handlers.join(', ') || '—'}</Field>
      </div>
      <div className="text-ink-muted">payload</div>
      <Json value={contract.schema.payload} />
      {contract.schema.reply !== undefined ? (
        <>
          <div className="text-ink-muted">reply</div>
          <Json value={contract.schema.reply} />
        </>
      ) : null}
      <button
        type="button"
        className="w-fit rounded border border-line px-2 py-1 hover:border-accent"
        onClick={() => void emit()}
      >
        emit fixture
      </button>
    </div>
  );
}
