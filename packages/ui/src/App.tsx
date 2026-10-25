import type { TreeNode } from '@murmur/dev-protocol';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { api, eventsUrl } from './api/client.ts';
import { BottomStrip } from './chrome/BottomStrip.tsx';
import { paletteItems } from './chrome/palette.ts';
import { ShortcutSheet } from './chrome/ShortcutSheet.tsx';
import { togglePause, TopBar } from './chrome/TopBar.tsx';
import { Breadcrumb } from './components/Breadcrumb.tsx';
import { ContractCard, EventCard, PieceCard } from './components/Cards.tsx';
import { CommandPalette } from './components/CommandPalette.tsx';
import { Drawer, resizeDrawer } from './components/Drawer.tsx';
import { Toasts, type ToastItem } from './components/Toast.tsx';
import { Tree, type TreeRowStats } from './components/Tree.tsx';
import { useUiState } from './hooks/useUiState.ts';
import { useHotkeys } from './keys/useHotkeys.ts';
import { formatRoute, navigate, useRoute, type Screen } from './router.ts';
import { Catalog } from './screens/Catalog/Catalog.tsx';
import { Events } from './screens/Events/Events.tsx';
import { Flock } from './screens/Flock/Flock.tsx';
import { Piece } from './screens/Piece/Piece.tsx';
import { Traces } from './screens/Traces/Traces.tsx';
import { ShellContext, type DrawerCard, type Shell, type ToastKind } from './shell.ts';
import { readJsonLocal, writeJsonLocal } from './store/local.ts';
import { recentlyFailed, selectTraces } from './store/selectors.ts';
import type { UiState } from './store/state.ts';
import { useStore } from './store/store.ts';
import { connectStream } from './store/stream.ts';
import { buildTree, subtreePieces } from './store/tree.ts';
import { useTheme } from './theme/useTheme.ts';

const TOAST_MS = 4000;
const SCREEN_KEYS: Screen[] = ['flock', 'events', 'traces', 'catalog'];

function useStream(): void {
  const store = useStore();
  useEffect(() => {
    const stream = connectStream({
      url: eventsUrl,
      since: () => store.getState().lastSeq || null,
      onFrame: store.dispatch,
      onStatus: store.setConnection,
    });

    return stream.close;
  }, [store]);
}

function useServerTree(state: UiState): TreeNode[] {
  const [groups, setGroups] = useState<TreeNode[]>([]);
  useEffect(() => {
    if (!state.snapshot) {
      return;
    }

    api.tree().then(setGroups, () => setGroups([]));
  }, [state.snapshot]);

  return useMemo(() => buildTree(state.snapshot?.pieces ?? [], groups), [state.snapshot, groups]);
}

function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(0);
  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = next.current++;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_MS);
  }, []);

  return { toasts, toast };
}

function useExpanded(app: string | undefined) {
  const key = `murmur.expanded.${app ?? 'app'}`;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => setExpanded(new Set(readJsonLocal<string[]>(key, []))), [key]);
  const toggle = useCallback(
    (id: string, open?: boolean) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (open ?? !current.has(id)) {
          next.add(id);
        } else {
          next.delete(id);
        }

        writeJsonLocal(key, [...next]);

        return next;
      }),
    [key],
  );

  return { expanded, toggle };
}

function rowTone(hot: boolean, idle: boolean): TreeRowStats['tone'] {
  if (hot) {
    return 'fail';
  }

  return idle ? 'idle' : 'ok';
}

function treeStats(state: UiState, tree: TreeNode[], now: number) {
  return (node: TreeNode): TreeRowStats => {
    const members =
      node.kind === 'piece' && node.children.length === 0 ? [node.id] : subtreePieces(tree, node.id);
    const views = members.flatMap((m) => state.snapshot?.pieces.find((p) => p.name === m) ?? []);
    const lives = members.map((m) => state.live.get(m));
    const failed = lives.reduce((n, l) => n + (l?.counters.failed ?? 0) + (l?.counters.deadLettered ?? 0), 0);
    const hot = lives.some((l) => recentlyFailed(l, now)) || views.some((v) => v.status === 'failed');
    const idle = views.some((v) => v.status !== 'running');

    return {
      tone: rowTone(hot, idle),
      inflight: lives.reduce((n, l) => n + (l?.counters.inflight ?? 0), 0),
      failed,
    };
  };
}

function DrawerContent({ card, state }: { card: DrawerCard; state: UiState }) {
  if (card.kind === 'piece') {
    const piece = state.snapshot?.pieces.find((p) => p.name === card.id);

    return piece ? (
      <PieceCard
        piece={piece}
        live={state.live.get(piece.name)}
        ring={state.ring}
        contracts={state.snapshot?.contracts ?? []}
      />
    ) : (
      <p>gone</p>
    );
  }

  if (card.kind === 'event') {
    const stored = state.ring.bySeq.get(card.seq);

    return stored ? <EventCard stored={stored} ring={state.ring} /> : <p>evicted from the buffer</p>;
  }

  const contract = state.snapshot?.contracts.find((c) => c.name === card.name);

  return contract ? <ContractCard contract={contract} /> : <p>unknown contract</p>;
}

function drawerTitle(card: DrawerCard, state: UiState): string {
  if (card.kind === 'piece') {
    return card.id;
  }

  if (card.kind === 'contract') {
    return card.name;
  }

  return state.ring.bySeq.get(card.seq)?.envelope.name ?? `#${card.seq}`;
}

function ScreenView({ screen }: { screen: Screen }) {
  if (screen === 'events') {
    return <Events />;
  }

  if (screen === 'traces') {
    return <Traces />;
  }

  if (screen === 'piece') {
    return <Piece />;
  }

  if (screen === 'catalog') {
    return <Catalog />;
  }

  return <Flock />;
}

export function App(): ReactNode {
  useStream();
  const state = useUiState();
  const route = useRoute();
  const { theme, toggle: toggleTheme } = useTheme();
  const { toasts, toast } = useToasts();
  const tree = useServerTree(state);
  const { expanded, toggle } = useExpanded(state.snapshot?.app.name);
  const [drawer, setDrawer] = useState<DrawerCard | null>(null);
  const [drawerWidth, setDrawerWidth] = useState(380);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const now = Date.now();
  const unscopedScreen = route.screen === 'piece' ? 'flock' : route.screen;

  useEffect(() => {
    if (state.phase === 'restarting') {
      toast(`restarting: ${state.restartReason.join(', ') || 'files changed'}`);
    }
  }, [state.phase, state.restartReason, toast]);

  const shell: Shell = useMemo(
    () => ({
      drawer,
      openDrawer: setDrawer,
      closeDrawer: () => setDrawer(null),
      toast,
      tree,
      expanded,
      toggleExpanded: toggle,
      openPalette: () => setPalette(true),
    }),
    [drawer, toast, tree, expanded, toggle],
  );
  const actions = {
    togglePause: () => void togglePause(state.paused).catch((e: unknown) => toast(String(e), 'error')),
    restart: () => void api.restart().catch((e: unknown) => toast(String(e), 'error')),
    toggleTheme,
    openContract: (name: string) => setDrawer({ kind: 'contract', name }),
  };
  const closeTop = () => {
    if (palette) {
      setPalette(false);

      return;
    }

    if (help) {
      setHelp(false);

      return;
    }

    setDrawer(null);
  };

  useHotkeys({
    ...(route.screen === 'piece'
      ? {}
      : Object.fromEntries(
          SCREEN_KEYS.map((s, i) => [
            String(i + 1),
            () => navigate(formatRoute({ screen: s, scope: route.scope })),
          ]),
        )),
    'g f': () => navigate(formatRoute({ screen: 'flock', scope: route.scope })),
    'g e': () => navigate(formatRoute({ screen: 'events', scope: route.scope })),
    'g t': () => navigate(formatRoute({ screen: 'traces', scope: route.scope })),
    'g c': () => navigate(formatRoute({ screen: 'catalog', scope: route.scope })),
    'mod+k': () => setPalette(true),
    '/': () => setPalette(true),
    '?': () => setHelp((h) => !h),
    Escape: closeTop,
    '[': () => setDrawerWidth((w) => resizeDrawer(w, '[')),
    ']': () => setDrawerWidth((w) => resizeDrawer(w, ']')),
  });

  const openTreeNode = (node: TreeNode) => {
    const isGroup = node.kind === 'group' || node.children.length > 0;
    navigate(formatRoute({ screen: 'piece', path: node.id, scope: isGroup ? node.id : route.scope }));
  };

  return (
    <ShellContext.Provider value={shell}>
      <div className="flex h-full flex-col">
        <TopBar theme={theme} onTheme={toggleTheme} onHelp={() => setHelp(true)} />
        <div className="flex min-h-0 flex-1">
          <aside className="w-64 shrink-0 border-r border-line">
            <Tree
              tree={tree}
              expanded={expanded}
              selected={route.path ?? route.scope}
              onToggle={toggle}
              onOpen={openTreeNode}
              stats={treeStats(state, tree, now)}
            />
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line px-3">
              <Breadcrumb path={route.path} scope={route.scope} />
              {route.scope ? (
                <a
                  className="text-xs text-ink-muted hover:text-accent"
                  href={formatRoute({ screen: unscopedScreen, scope: null })}
                >
                  clear scope ✕
                </a>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <ScreenView screen={route.screen} />
            </div>
          </main>
          {drawer ? (
            <Drawer width={drawerWidth} title={drawerTitle(drawer, state)} onClose={() => setDrawer(null)}>
              <DrawerContent card={drawer} state={state} />
            </Drawer>
          ) : null}
        </div>
        <BottomStrip />
      </div>
      {palette ? (
        <CommandPalette
          items={paletteItems(state.snapshot, selectTraces(state), actions)}
          onClose={() => setPalette(false)}
        />
      ) : null}
      {help ? <ShortcutSheet onClose={() => setHelp(false)} /> : null}
      <Toasts items={toasts} />
    </ShellContext.Provider>
  );
}
