import type { Snapshot } from '@murmur/dev-protocol';

import type { PaletteItem } from '../components/CommandPalette.tsx';
import { formatRoute, navigate, type Screen } from '../router.ts';
import type { TraceSummary } from '../store/selectors.ts';

export interface PaletteActions {
  togglePause: () => void;
  restart: () => void;
  toggleTheme: () => void;
  openContract: (name: string) => void;
}

const SCREENS: Screen[] = ['flock', 'events', 'traces', 'catalog'];

export function paletteItems(
  snapshot: Snapshot | null,
  traces: TraceSummary[],
  actions: PaletteActions,
): PaletteItem[] {
  const pieces = (snapshot?.pieces ?? []).map((p) => ({
    id: `piece:${p.name}`,
    group: 'piece' as const,
    label: p.name,
    hint: p.title,
    run: () => navigate(formatRoute({ screen: 'piece', path: p.name })),
  }));
  const contracts = (snapshot?.contracts ?? []).map((c) => ({
    id: `contract:${c.name}`,
    group: 'contract' as const,
    label: c.name,
    hint: c.visibility,
    run: () => actions.openContract(c.name),
  }));
  const capabilities = (snapshot?.capabilities ?? []).map((c) => ({
    id: `capability:${c.name}`,
    group: 'capability' as const,
    label: c.name,
    hint: c.usedBy.join(', '),
    run: () => navigate(formatRoute({ screen: 'catalog' })),
  }));
  const recent = traces.slice(0, 20).map((t) => ({
    id: `trace:${t.traceId}`,
    group: 'trace' as const,
    label: t.traceId,
    hint: t.root.envelope.name,
    run: () => navigate(formatRoute({ screen: 'traces', traceId: t.traceId })),
  }));
  const screens = SCREENS.map((s) => ({
    id: `screen:${s}`,
    group: 'screen' as const,
    label: s,
    run: () => navigate(formatRoute({ screen: s })),
  }));
  const commands: PaletteItem[] = [
    { id: 'action:pause', group: 'action', label: 'pause / resume transport', run: actions.togglePause },
    { id: 'action:restart', group: 'action', label: 'restart app', run: actions.restart },
    { id: 'action:theme', group: 'action', label: 'toggle theme', run: actions.toggleTheme },
  ];

  return [...screens, ...pieces, ...contracts, ...capabilities, ...recent, ...commands];
}
