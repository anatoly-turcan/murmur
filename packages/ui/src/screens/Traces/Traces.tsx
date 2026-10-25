import type { ContractView, LogLine, Trace } from '@murmur/dev-protocol';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { api } from '../../api/client.ts';
import { EmptyState } from '../../components/EmptyState.tsx';
import { Json } from '../../components/Json.tsx';
import { layoutWaterfall } from '../../components/waterfall-math.ts';
import { Waterfall } from '../../components/Waterfall.tsx';
import { useNow } from '../../hooks/useNow.ts';
import { useUiState } from '../../hooks/useUiState.ts';
import { useHotkeys } from '../../keys/useHotkeys.ts';
import { formatRoute, navigate, useRoute } from '../../router.ts';
import { ringByTrace } from '../../store/ring.ts';
import { selectTraces, type TraceSummary } from '../../store/selectors.ts';
import { inScope } from '../../store/tree.ts';
import { age, ms, shortId } from '../format.ts';
import { groupByRoot, resolveTraceId } from './resolve.ts';

function TraceList({ traces, active, now }: { traces: TraceSummary[]; active: string | null; now: number }) {
  return (
    <div className="flex flex-col gap-3 overflow-auto">
      {groupByRoot(traces).map(([root, items]) => (
        <section key={root}>
          <h3 className="mb-1 font-mono text-xs text-ink-muted">{root}</h3>
          {items.map((t) => (
            <a
              key={t.traceId}
              href={formatRoute({ screen: 'traces', traceId: t.traceId })}
              className={`grid grid-cols-[72px_1fr_auto] gap-2 rounded px-2 py-1 font-mono text-xs ${t.traceId === active ? 'bg-accent/15' : 'hover:bg-panel'}`}
            >
              <span>{shortId(t.traceId)}</span>
              <span className="text-ink-muted">
                {t.events} ev · {ms(t.durationMs)}
                {t.failures ? <span className="text-fail"> · {t.failures} fail</span> : null}
              </span>
              <span className="text-ink-muted">{age(t.startedAt, now)}</span>
            </a>
          ))}
        </section>
      ))}
    </div>
  );
}

function useTrace(traceId: string | null, liveCount: number) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!traceId) {
      return;
    }

    let live = true;
    api.trace(traceId).then(
      (t) => {
        if (live) {
          setTrace(t);
          setError(null);
        }

        return t;
      },
      (e: unknown) => {
        if (live) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },
    );

    return () => {
      live = false;
    };
  }, [traceId, liveCount]);

  return { trace: trace?.traceId === traceId ? trace : null, error };
}

function useTraceLogs(traceId: string | null, enabled: boolean): LogLine[] | null {
  const [logs, setLogs] = useState<LogLine[] | null>(null);
  useEffect(() => {
    if (!traceId || !enabled) {
      setLogs(null);

      return;
    }

    api.logs({ trace: traceId, limit: 500 }).then(
      (r) => setLogs(r.items),
      () => setLogs([]),
    );
  }, [traceId, enabled]);

  return enabled ? (logs ?? []) : null;
}

function guardNames(contracts: readonly ContractView[]): Set<string> {
  return new Set(contracts.filter((c) => c.kind === 'guard').map((c) => c.name));
}

function FocusLogs({ logs }: { logs: LogLine[] }) {
  return (
    <div className="font-mono text-xs">
      {logs.length ? (
        logs.map((l, i) => <div key={i}>{`${l.level} ${l.piece} ${l.msg}`}</div>)
      ) : (
        <span className="text-ink-muted">no logs for this delivery</span>
      )}
    </div>
  );
}

function TraceDetail({ traceId }: { traceId: string }) {
  const state = useUiState();
  const liveCount = ringByTrace(state.ring, traceId).length;
  const { trace, error } = useTrace(traceId, liveCount);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [interleave, setInterleave] = useState(false);
  const logs = useTraceLogs(traceId, interleave || hovered !== null);
  const guards = useMemo(() => guardNames(state.snapshot?.contracts ?? []), [state.snapshot]);
  const model = useMemo(
    () => (trace ? layoutWaterfall(trace, Date.now(), { guards }) : null),
    [trace, guards],
  );
  const setRowCollapsed = (open: boolean) => {
    const row = selected === null ? null : model?.rows[selected];
    if (!row) {
      return;
    }

    const next = new Set(collapsed);
    if (open) {
      next.delete(row.nodeId);
    } else {
      next.add(row.nodeId);
    }

    setCollapsed(next);
  };
  useHotkeys({
    ArrowLeft: () => setRowCollapsed(false),
    ArrowRight: () => setRowCollapsed(true),
    l: () => setInterleave((v) => !v),
  });

  if (error && !trace) {
    return <EmptyState title={`Trace ${shortId(traceId)} not found: ${error}`} />;
  }

  if (!model || !trace) {
    return <EmptyState title="Loading trace…" />;
  }

  const focus = model.rows[hovered ?? selected ?? -1];
  const focusLogs = focus ? (logs ?? []).filter((l) => l.eventId === focus.nodeId) : [];

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-baseline gap-4">
        <h2 className="font-mono">{trace.root.envelope.name}</h2>
        <span className="font-mono text-xs text-ink-muted">{trace.traceId}</span>
        <span className="text-xs text-ink-muted">
          {model.events} events · max hop {model.maxHop} · {ms(trace.durationMs)}
        </span>
        {trace.background ? (
          <span className="text-xs text-ink-muted">background root of {trace.background.piece}</span>
        ) : null}
        {trace.failed ? <span className="text-xs text-fail">failed</span> : null}
        <button
          type="button"
          className="ml-auto text-xs text-accent"
          onClick={() => setInterleave((v) => !v)}
        >
          l {interleave ? 'hide' : 'interleave'} logs
        </button>
      </header>
      <Waterfall
        model={model}
        collapsed={collapsed}
        selected={selected}
        logs={interleave ? logs : null}
        onSelect={setSelected}
        onHover={setHovered}
      />
      {focus ? (
        <div className="grid grid-cols-2 gap-4 border-t border-line pt-3">
          <Json value={focus.node.envelope.payload} />
          <FocusLogs logs={focusLogs} />
        </div>
      ) : null}
    </div>
  );
}

export function Traces(): ReactNode {
  const state = useUiState();
  const route = useRoute();
  const now = useNow(5000);
  const [paste, setPaste] = useState('');
  const traces = selectTraces(state).filter(
    (t) =>
      !route.scope ||
      inScope(t.root.envelope.source ?? '', route.scope) ||
      inScope(t.root.meta.piece ?? '', route.scope),
  );
  const open = (input: string) =>
    navigate(formatRoute({ screen: 'traces', traceId: resolveTraceId(input, traces) }));

  return (
    <div className="grid h-full grid-cols-[320px_1fr] gap-4 p-3">
      <div className="flex min-h-0 flex-col gap-2">
        <input
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && paste.trim() && open(paste)}
          placeholder="paste a trace id (prefix ok)"
          aria-label="trace id"
          className="rounded border border-line bg-paper px-2 py-1 font-mono text-xs outline-none focus:border-accent"
        />
        {traces.length ? (
          <TraceList traces={traces} active={route.traceId} now={now} />
        ) : (
          <p className="text-ink-muted">no traces in the buffer yet</p>
        )}
      </div>
      <div className="min-w-0 overflow-auto">
        {route.traceId ? (
          <TraceDetail traceId={resolveTraceId(route.traceId, traces)} />
        ) : (
          <EmptyState title="Pick a trace or paste an id" />
        )}
      </div>
    </div>
  );
}
