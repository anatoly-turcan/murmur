import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { emitFixture } from '../../api/emit.ts';
import { EmptyState } from '../../components/EmptyState.tsx';
import { FilterBar } from '../../components/FilterBar.tsx';
import { Json } from '../../components/Json.tsx';
import { Table, type Column } from '../../components/Table.tsx';
import { useNow } from '../../hooks/useNow.ts';
import { useUiState } from '../../hooks/useUiState.ts';
import { useHotkeys } from '../../keys/useHotkeys.ts';
import { formatRoute, navigate, useRoute } from '../../router.ts';
import { useShell } from '../../shell.ts';
import { matchFilter, parseFilter, withScope } from '../../store/filters.ts';
import type { EventRow, RowOutcome } from '../../store/rows.ts';
import { selectRows } from '../../store/selectors.ts';
import { clock, ms, shortId } from '../format.ts';

const OUTCOME_TONE: Record<RowOutcome, string> = {
  pending: 'text-ink-muted',
  inflight: 'text-accent',
  acked: 'text-ok',
  retried: 'text-warn',
  failed: 'text-fail',
  deadLettered: 'text-fail',
};

const columns: Column<EventRow>[] = [
  { key: 'time', title: 'time', width: '110px', render: (r) => clock(r.stored.envelope.ts) },
  { key: 'name', title: 'name', width: 'minmax(160px,1.2fr)', render: (r) => r.stored.envelope.name },
  { key: 'trace', title: 'trace', width: '84px', render: (r) => shortId(r.stored.envelope.traceId) },
  {
    key: 'route',
    title: 'from → to',
    width: 'minmax(180px,1.5fr)',
    render: (r) => `${r.from ?? 'ingress'} → ${r.to.join(', ') || '…'}`,
  },
  { key: 'attempt', title: 'att', width: '44px', render: (r) => r.attempt ?? '—' },
  { key: 'duration', title: 'duration', width: '80px', render: (r) => ms(r.durationMs) },
  {
    key: 'outcome',
    title: 'outcome',
    width: '96px',
    render: (r) => <span className={OUTCOME_TONE[r.outcome]}>{r.outcome}</span>,
  },
];

const rowKey = (r: EventRow) => String(r.stored.seq);

function RowDetail({ row }: { row: EventRow }) {
  const shell = useShell();
  const { payload, ...headers } = row.stored.envelope;

  return (
    <div className="grid grid-cols-2 gap-4">
      <Json value={payload} />
      <div className="font-mono text-xs">
        {Object.entries(headers).map(([k, v]) => (
          <div key={k}>
            <span className="text-ink-muted">{k}</span> {String(v)}
          </div>
        ))}
        <div className="mt-2 flex gap-2">
          <a
            className="text-accent"
            href={formatRoute({ screen: 'traces', traceId: row.stored.envelope.traceId })}
          >
            t open trace
          </a>
          <button
            type="button"
            className="text-accent"
            onClick={() => shell.openDrawer({ kind: 'event', seq: row.stored.seq })}
          >
            card
          </button>
        </div>
      </div>
    </div>
  );
}

function WaitingForEvents() {
  const state = useUiState();
  const shell = useShell();
  const contract = state.snapshot?.contracts.find((c) => c.handlers.length > 0 && c.visibility === 'public');
  const emit = () =>
    contract &&
    emitFixture(contract).then(
      (r) => shell.toast(`emitted ${contract.name} → trace ${shortId(r.traceId)}`),
      (e: unknown) => shell.toast(e instanceof Error ? e.message : String(e), 'error'),
    );

  return (
    <EmptyState title="Waiting for events…" command={`murmur emit ${contract?.name ?? '<Contract>'}`}>
      {contract ? (
        <button
          type="button"
          onClick={() => void emit()}
          className="rounded border border-accent px-2 py-1 text-accent"
        >
          emit fixture
        </button>
      ) : null}
    </EmptyState>
  );
}

function useFilterParam(): [string, (value: string) => void] {
  const route = useRoute();
  const [value, setValue] = useState(route.query.get('q') ?? '');
  useEffect(() => setValue(route.query.get('q') ?? ''), [route.query.get('q')]);

  return [value, setValue];
}

export function Events(): ReactNode {
  const state = useUiState();
  const route = useRoute();
  const now = useNow(5000);
  const [query, setQuery] = useFilterParam();
  const [frozen, setFrozen] = useState<EventRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const filter = useMemo(() => withScope(parseFilter(query), route.scope), [query, route.scope]);
  const all = selectRows(state);
  const live = useMemo(() => all.filter((r) => matchFilter(r, filter, now)).toReversed(), [all, filter, now]);
  const rows = frozen ?? live;
  const fresh = frozen ? live.length - frozen.length : 0;
  const selectedRow = rows.find((r) => rowKey(r) === selected);
  useHotkeys({
    t: () =>
      selectedRow &&
      navigate(formatRoute({ screen: 'traces', traceId: selectedRow.stored.envelope.traceId })),
  });

  if (all.length === 0) {
    return <WaitingForEvents />;
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <FilterBar value={query} onChange={setQuery} />
        </div>
        <button
          type="button"
          onClick={() => setFrozen(frozen ? null : live)}
          className="rounded border border-line px-2 py-1 text-xs"
          aria-pressed={frozen !== null}
        >
          {frozen ? '▶ live' : '▮▮ freeze'}
        </button>
        {fresh > 0 ? (
          <button
            type="button"
            onClick={() => setFrozen(null)}
            className="rounded-full bg-accent px-2 py-0.5 text-xs text-paper"
          >
            {fresh} new
          </button>
        ) : null}
      </div>
      <Table
        rows={rows}
        columns={columns}
        rowKey={rowKey}
        selected={selected}
        expanded={selected}
        onSelect={(r) => setSelected(rowKey(r) === selected ? null : rowKey(r))}
        renderExpanded={(r) => <RowDetail row={r} />}
        height={520}
      />
      <div className="text-xs text-ink-muted">
        {rows.length} of {all.length} envelopes in the buffer
      </div>
    </div>
  );
}
