import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { EmptyState } from '../../components/EmptyState.tsx';
import { Graph, type GraphHandle, type Pulse } from '../../components/Graph.tsx';
import { createPulseLimiter, edgesForDelivery, PULSE_MS } from '../../graph/animate.ts';
import type { GraphEdge } from '../../graph/edges.ts';
import { layoutGraph, type PlacedNode, type Point } from '../../graph/layout.ts';
import { useNow } from '../../hooks/useNow.ts';
import { useUiState } from '../../hooks/useUiState.ts';
import { useHotkeys } from '../../keys/useHotkeys.ts';
import { formatRoute, navigate, useRoute } from '../../router.ts';
import { useShell } from '../../shell.ts';
import { readJsonLocal, writeJsonLocal } from '../../store/local.ts';
import { useStore } from '../../store/store.ts';
import { inScope } from '../../store/tree.ts';
import { nodeLive } from './node-live.ts';

function usePinned(app: string) {
  const key = `murmur.flock.${app}.pinned`;
  const [pinned, setPinned] = useState<Record<string, Point>>(() => readJsonLocal(key, {}));
  const pin = useCallback(
    (id: string, point: Point) =>
      setPinned((current) => {
        const next = { ...current, [id]: point };
        writeJsonLocal(key, next);

        return next;
      }),
    [key],
  );

  return { pinned, pin };
}

function usePulses(
  edges: GraphEdge[],
  repOf: (piece: string) => string | undefined,
  handlersOf: (name: string) => string[],
) {
  const store = useStore();
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const limiter = useRef(createPulseLimiter());
  const counter = useRef(0);
  useEffect(
    () =>
      store.onEnvelope((stored) => {
        if (stored.meta.internal) {
          return;
        }

        const { name, source } = stored.envelope;
        const now = Date.now();
        const admitted = edgesForDelivery(edges, repOf, { name, source, handlers: handlersOf(name) }).filter(
          (e) => limiter.current.admit(e.id, now),
        );

        if (!admitted.length) {
          return;
        }

        const fresh = admitted.map((e) => ({ key: counter.current++, edgeId: e.id }));
        setPulses((p) => [...p, ...fresh]);
        setTimeout(() => setPulses((p) => p.filter((x) => !fresh.includes(x))), PULSE_MS);
      }),
    [store, edges, repOf, handlersOf],
  );

  return { pulses, suppressed: (id: string) => limiter.current.suppressed(id) };
}

export function Flock(): ReactNode {
  const state = useUiState();
  const shell = useShell();
  const route = useRoute();
  const now = useNow(1000);
  const graph = useRef<GraphHandle>(null);
  const snapshot = state.snapshot;
  const app = snapshot?.app.name ?? 'app';
  const { pinned, pin } = usePinned(app);
  const [cleared, setCleared] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const pieces = useMemo(
    () => (snapshot?.pieces ?? []).filter((p) => inScope(p.name, route.scope)),
    [snapshot, route.scope],
  );
  const layout = useMemo(
    () =>
      layoutGraph({
        pieces,
        contracts: snapshot?.contracts ?? [],
        capabilities: snapshot?.capabilities ?? [],
        routes: snapshot?.routes ?? [],
        warnings: snapshot?.warnings ?? [],
        expanded: shell.expanded,
        pinned,
      }),
    [pieces, snapshot, shell.expanded, pinned],
  );
  const repMap = useMemo(
    () => new Map(layout.nodes.flatMap((n) => n.members.map((m) => [m, n.id] as const))),
    [layout],
  );
  const repOf = useCallback((piece: string) => repMap.get(piece), [repMap]);
  const handlersOf = useCallback(
    (name: string) => snapshot?.contracts.find((c) => c.name === name)?.handlers ?? [],
    [snapshot],
  );
  const { pulses, suppressed } = usePulses(layout.edges, repOf, handlersOf);
  const pieceMap = useMemo(() => new Map((snapshot?.pieces ?? []).map((p) => [p.name, p])), [snapshot]);
  const liveOf = (node: PlacedNode) => nodeLive(node, { live: state.live, pieces: pieceMap, cleared, now });

  const toggle = (node: PlacedNode) => shell.toggleExpanded(node.id);
  useHotkeys({
    '0': () => graph.current?.reset(),
    f: () => graph.current?.fit(),
    l: () => selected && shell.toggleExpanded(selected, true),
    h: () => selected && shell.toggleExpanded(selected, false),
  });

  if (!snapshot) {
    return <EmptyState title="Dev server not reachable —" command="murmur dev" />;
  }

  if (snapshot.pieces.length === 0) {
    return <EmptyState title="No pieces yet —" command="murmur new piece <path>" />;
  }

  const onNode = (node: PlacedNode) => {
    setSelected(node.id);

    if (node.kind === 'ghost') {
      shell.openDrawer({ kind: 'contract', name: node.label });
    } else if (pieceMap.has(node.id)) {
      shell.openDrawer({ kind: 'piece', id: node.id });
    } else if (node.kind === 'group') {
      navigate(formatRoute({ screen: 'piece', path: node.id, scope: node.id }));
    }
  };
  const onEdge = (edge: GraphEdge) => {
    if (edge.from.startsWith('ingress:')) {
      return;
    }

    navigate(
      formatRoute({ screen: 'events', scope: route.scope, params: { q: `contract:${edge.contract}` } }),
    );
  };
  const onClearDead = (node: PlacedNode) =>
    setCleared((c) => ({ ...c, [node.id]: (c[node.id] ?? 0) + liveOf(node).deadLettered }));

  return (
    <div className="relative h-full">
      <Graph
        handle={graph}
        layout={layout}
        live={liveOf}
        pulses={pulses}
        suppressed={suppressed}
        selected={selected}
        dimmed={state.phase !== 'running'}
        onNode={onNode}
        onToggle={toggle}
        onEdge={onEdge}
        onDrag={pin}
        onClearDead={onClearDead}
      />
      <div className="absolute right-3 bottom-3 flex gap-2 text-xs text-ink-muted">
        <button
          type="button"
          onClick={() => graph.current?.reset()}
          className="rounded border border-line bg-paper px-2 py-0.5"
        >
          0 reset
        </button>
        <button
          type="button"
          onClick={() => graph.current?.fit()}
          className="rounded border border-line bg-paper px-2 py-0.5"
        >
          f fit
        </button>
      </div>
    </div>
  );
}
