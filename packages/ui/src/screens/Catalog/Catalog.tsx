import type { CatalogRoute, ContractView, TreeNode } from '@murmur/dev-protocol';
import { useState, type ReactNode } from 'react';

import { classNameOf, kindMark, routeTarget } from '../../components/contract-kind.ts';
import { EmptyState } from '../../components/EmptyState.tsx';
import { ContractName } from '../../components/KindBadge.tsx';
import { useUiState } from '../../hooks/useUiState.ts';
import { formatRoute } from '../../router.ts';
import { useShell } from '../../shell.ts';
import { toMermaid, WHY } from './mermaid.ts';

function Heading({ children }: { children: string }) {
  return <h2 className="mb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase">{children}</h2>;
}

function TreeRows({ nodes, depth }: { nodes: TreeNode[]; depth: number }) {
  return nodes.map((n) => (
    <div key={n.id}>
      <div className="grid grid-cols-[minmax(200px,1fr)_2fr] gap-2 py-0.5 text-xs">
        <a
          href={formatRoute({ screen: 'piece', path: n.id })}
          className={`font-mono ${n.kind === 'group' ? 'text-ink-muted' : 'text-accent'}`}
          style={{ paddingLeft: depth * 14 }}
        >
          {n.title}
        </a>
        <span className="text-ink-muted">{n.summary ?? ''}</span>
      </div>
      <TreeRows nodes={n.children} depth={depth + 1} />
    </div>
  ));
}

function routePiece(route: CatalogRoute): string {
  return route.method === undefined ? route.piece : `${route.piece}.${route.method}`;
}

function GuardNames({ guards, contracts }: { guards: string[]; contracts: ContractView[] }) {
  if (guards.length === 0) {
    return <span className="text-ink-muted">none</span>;
  }

  return guards.map((wire, i) => (
    <span key={wire} title={wire}>
      {i > 0 ? ', ' : ''}
      {classNameOf(wire, contracts)}
    </span>
  ));
}

function RouteTable({
  token,
  routes,
  contracts,
}: {
  token: string;
  routes: CatalogRoute[];
  contracts: ContractView[];
}) {
  return (
    <table className="w-full text-xs" aria-label={`routes ${token}`}>
      <thead className="text-left text-ink-muted">
        <tr>
          <th className="font-normal">{`ROUTES (${token})`}</th>
          <th className="font-normal">piece</th>
          <th className="font-normal">guards</th>
          <th className="font-normal">via</th>
        </tr>
      </thead>
      <tbody>
        {routes.map((route) => (
          <tr key={`${route.piece}:${route.key}`}>
            <td className="py-0.5 font-mono">{route.key}</td>
            <td className="font-mono">
              <a href={formatRoute({ screen: 'piece', path: route.piece })} className="text-accent">
                {routePiece(route)}
              </a>
            </td>
            <td className="font-mono text-ink-muted">
              <GuardNames guards={route.guards} contracts={contracts} />
            </td>
            <td className="font-mono text-ink-muted">{routeTarget(route, contracts)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Routes({ routes, contracts }: { routes: CatalogRoute[]; contracts: ContractView[] }) {
  if (routes.length === 0) {
    return <p className="text-ink-muted">no routes</p>;
  }

  const byToken = Map.groupBy(routes, (route) => route.token);

  return [...byToken].map(([token, rows]) => (
    <RouteTable key={token} token={token} routes={rows} contracts={contracts} />
  ));
}

export function Catalog(): ReactNode {
  const state = useUiState();
  const shell = useShell();
  const [showMermaid, setShowMermaid] = useState(false);
  const snapshot = state.snapshot;

  if (!snapshot) {
    return <EmptyState title="Dev server not reachable —" command="murmur dev" />;
  }

  const mermaid = toMermaid(snapshot.contracts, snapshot.capabilities);

  return (
    <div className="flex flex-col gap-6 p-3">
      <section>
        <Heading>contracts</Heading>
        <table className="w-full text-xs">
          <thead className="text-left text-ink-muted">
            <tr>
              <th className="font-normal">name</th>
              <th className="font-normal">kind</th>
              <th className="font-normal">visibility</th>
              <th className="font-normal">emitters</th>
              <th className="font-normal">requesters</th>
              <th className="font-normal">handlers</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.contracts.map((c) => (
              <tr
                key={c.name}
                className="cursor-pointer hover:bg-panel"
                onClick={() => shell.openDrawer({ kind: 'contract', name: c.name })}
              >
                <td className="py-0.5">
                  <ContractName contract={c} />
                </td>
                <td>{kindMark(c).title}</td>
                <td>
                  {c.visibility}
                  {c.scope ? <span className="text-ink-muted"> · {c.scope}</span> : null}
                </td>
                <td className="font-mono text-ink-muted">{c.emitters.join(', ') || '—'}</td>
                <td className="font-mono text-ink-muted">{c.requesters?.join(', ') || '—'}</td>
                <td className="font-mono text-ink-muted">{c.handlers.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <Heading>routes</Heading>
        <Routes routes={snapshot.routes ?? []} contracts={snapshot.contracts} />
      </section>
      <section>
        <Heading>pieces</Heading>
        <TreeRows nodes={shell.tree} depth={0} />
      </section>
      <section>
        <Heading>capabilities</Heading>
        <table className="text-xs">
          <tbody>
            {snapshot.capabilities.map((c) => (
              <tr key={c.name}>
                <td className="pr-4 font-mono">{c.name}</td>
                <td className="pr-4 text-ink-muted">{c.kind}</td>
                <td className="font-mono text-ink-muted">{c.usedBy.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section id="warnings">
        <Heading>{`warnings (${snapshot.warnings.length})`}</Heading>
        {snapshot.warnings.length ? (
          snapshot.warnings.map((w) => (
            <div key={`${w.code}:${w.subject}`} className="py-1 text-xs">
              <span className="font-mono text-warn">{w.code}</span>{' '}
              <span className="font-mono">{w.subject}</span> — {w.message}
              <div className="text-ink-muted">why it matters: {WHY[w.code]}</div>
            </div>
          ))
        ) : (
          <p className="text-ink-muted">no warnings</p>
        )}
      </section>
      <section>
        <button type="button" className="text-xs text-accent" onClick={() => setShowMermaid(!showMermaid)}>
          {showMermaid ? 'hide' : 'export'} mermaid
        </button>
        {showMermaid ? (
          <div className="mt-2 flex flex-col gap-2">
            <pre className="overflow-auto rounded bg-panel p-3 font-mono text-xs">{mermaid}</pre>
            <button
              type="button"
              className="w-fit rounded border border-line px-2 py-0.5 text-xs"
              onClick={() =>
                void navigator.clipboard?.writeText(mermaid).then(() => shell.toast('mermaid copied'))
              }
            >
              copy
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
