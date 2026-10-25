import type { CatalogRoute, ContractView, PieceView } from '@murmur/dev-protocol';
import type { ReactNode } from 'react';

import { classNameOf, routeTarget } from '../../components/contract-kind.ts';

export function servesOf(piece: Pick<PieceView, 'name'>, routes: readonly CatalogRoute[]): CatalogRoute[] {
  return routes.filter((route) => route.piece === piece.name);
}

function Guards({ route, contracts }: { route: CatalogRoute; contracts: ContractView[] }) {
  if (route.guards.length === 0) {
    return <span className="text-ink-muted">none (open route)</span>;
  }

  return (
    <span className="flex flex-wrap gap-1.5">
      {route.guards.map((wire) => (
        <span key={wire} className="rounded bg-panel px-1" title={wire}>
          {classNameOf(wire, contracts)}
        </span>
      ))}
    </span>
  );
}

export function ServesTab({
  piece,
  routes,
  contracts,
}: {
  piece: PieceView;
  routes: CatalogRoute[];
  contracts: ContractView[];
}): ReactNode {
  const own = servesOf(piece, routes);
  if (own.length === 0) {
    return <p className="text-ink-muted">this piece serves no routes</p>;
  }

  return (
    <table className="w-full font-mono text-xs" aria-label="serves">
      <thead className="text-left text-ink-muted">
        <tr>
          <th className="font-normal">key</th>
          <th className="font-normal">token</th>
          <th className="font-normal">effective guards</th>
          <th className="font-normal">via</th>
        </tr>
      </thead>
      <tbody>
        {own.map((route) => (
          <tr key={route.key}>
            <td className="py-0.5 pr-4">{route.key}</td>
            <td className="pr-4 text-ink-muted">{`${route.token} (${route.transport})`}</td>
            <td className="pr-4">
              <Guards route={route} contracts={contracts} />
            </td>
            <td className="text-ink-muted">{routeTarget(route, contracts)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
