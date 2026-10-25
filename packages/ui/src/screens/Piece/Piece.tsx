import { useMemo, type ReactNode } from 'react';

import { api } from '../../api/client.ts';
import { EmptyState } from '../../components/EmptyState.tsx';
import { Tabs } from '../../components/Tabs.tsx';
import { useAsync } from '../../hooks/useAsync.ts';
import { useUiState } from '../../hooks/useUiState.ts';
import { useHotkeys } from '../../keys/useHotkeys.ts';
import { formatRoute, navigate, useRoute } from '../../router.ts';
import { ringByPiece } from '../../store/ring.ts';
import { Group } from '../Group/Group.tsx';
import { ServesTab } from './serves.tsx';
import {
  ContextTab,
  ContractsTab,
  DeliveriesTab,
  deliveriesFirstFailures,
  FilesTab,
  LogsTab,
  OverviewTab,
} from './tabs.tsx';

export const PIECE_TABS = [
  'Overview',
  'Contracts',
  'Serves',
  'Deliveries',
  'Logs',
  'Files',
  'Context',
] as const;
export type PieceTab = (typeof PIECE_TABS)[number];

function useTab(): [PieceTab, (tab: PieceTab) => void] {
  const route = useRoute();
  const param = route.query.get('tab');
  const tab = PIECE_TABS.find((t) => t === param) ?? 'Overview';
  const select = (next: PieceTab) =>
    navigate(
      formatRoute({
        screen: 'piece',
        path: route.path,
        scope: route.scope,
        params: next === 'Overview' ? {} : { tab: next },
      }),
    );

  return [tab, select];
}

function PieceScreen({ id }: { id: string }) {
  const state = useUiState();
  const [tab, setTab] = useTab();
  const detail = useAsync(() => api.piece(id), [id, state.snapshot]);
  const recent = ringByPiece(state.ring, id);
  const facts = useMemo(
    () => deliveriesFirstFailures([...(detail.status === 'ok' ? detail.value.recent : []), ...recent], id),
    [detail, recent.length, id],
  );
  useHotkeys(Object.fromEntries(PIECE_TABS.map((t, i) => [String(i + 1), () => setTab(t)])));

  if (detail.status === 'loading') {
    return <EmptyState title="Loading piece…" />;
  }

  if (detail.status === 'error') {
    return <EmptyState title={`Could not load ${id}: ${detail.error}`} command="murmur dev" />;
  }

  const piece = detail.value;

  return (
    <div className="flex flex-col gap-3 p-3">
      <Tabs tabs={PIECE_TABS} active={tab} onSelect={setTab} />
      <div className="min-h-0">
        {tab === 'Overview' ? <OverviewTab piece={piece} /> : null}
        {tab === 'Contracts' ? (
          <ContractsTab piece={piece} contracts={state.snapshot?.contracts ?? []} />
        ) : null}
        {tab === 'Serves' ? (
          <ServesTab
            piece={piece}
            routes={state.snapshot?.routes ?? []}
            contracts={state.snapshot?.contracts ?? []}
          />
        ) : null}
        {tab === 'Deliveries' ? <DeliveriesTab facts={facts} /> : null}
        {tab === 'Logs' ? <LogsTab piece={piece} /> : null}
        {tab === 'Files' ? <FilesTab piece={piece} /> : null}
        {tab === 'Context' ? <ContextTab id={id} /> : null}
      </div>
    </div>
  );
}

export function Piece(): ReactNode {
  const state = useUiState();
  const route = useRoute();
  const id = route.path;

  if (!id) {
    return <EmptyState title="Pick a piece in the tree" />;
  }

  if (state.snapshot?.pieces.some((p) => p.name === id)) {
    return <PieceScreen id={id} />;
  }

  if (state.snapshot?.pieces.some((p) => p.name.startsWith(`${id}/`))) {
    return <Group id={id} />;
  }

  if (!state.snapshot) {
    return <EmptyState title="Dev server not reachable —" command="murmur dev" />;
  }

  return <EmptyState title={`No piece or group at ${id} —`} command={`murmur new piece ${id}`} />;
}
