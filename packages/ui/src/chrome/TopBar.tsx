import type { ReactNode } from 'react';

import { api, ApiError } from '../api/client.ts';
import { Kbd } from '../components/Kbd.tsx';
import { StatusDot } from '../components/StatusDot.tsx';
import { useUiState } from '../hooks/useUiState.ts';
import { formatRoute, useRoute, type Screen } from '../router.ts';
import { useShell } from '../shell.ts';
import type { Theme } from '../theme/useTheme.ts';
import { liveStatus } from './status.ts';

const SCREENS: { screen: Screen; label: string }[] = [
  { screen: 'flock', label: 'Flock' },
  { screen: 'events', label: 'Events' },
  { screen: 'traces', label: 'Traces' },
  { screen: 'catalog', label: 'Catalog' },
];

export function togglePause(paused: boolean): Promise<{ paused: boolean }> {
  return paused ? api.resume() : api.pause();
}

export function TopBar({
  theme,
  onTheme,
  onHelp,
}: {
  theme: Theme;
  onTheme: () => void;
  onHelp: () => void;
}): ReactNode {
  const state = useUiState();
  const shell = useShell();
  const route = useRoute();
  const status = liveStatus(state);
  const pause = () =>
    togglePause(state.paused).catch((e: unknown) =>
      shell.toast(
        e instanceof ApiError && e.status === 409 ? 'pause needs the memory transport' : String(e),
        'error',
      ),
    );

  return (
    <header className="flex h-10 shrink-0 items-center gap-4 border-b border-line px-3">
      <span className="font-mono font-semibold">
        murmur <span className="text-ink-muted">▾ {state.snapshot?.app.name ?? '—'}</span>
      </span>
      <nav className="flex gap-1">
        {SCREENS.map((s, i) => (
          <a
            key={s.screen}
            href={formatRoute({ screen: s.screen, scope: route.scope })}
            className={`rounded px-2 py-1 ${route.screen === s.screen || (s.screen === 'traces' && route.screen === 'traces') ? 'bg-accent/15 text-accent' : 'hover:bg-panel'}`}
            title={`${i + 1}`}
          >
            {s.label}
          </a>
        ))}
      </nav>
      <StatusDot tone={status.tone} label={status.label} />
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={shell.openPalette}
          className="flex items-center gap-1 rounded border border-line px-2 py-0.5 text-ink-muted"
        >
          search <Kbd>⌘K</Kbd>
        </button>
        <button
          type="button"
          onClick={() => void pause()}
          className="rounded border border-line px-2 py-0.5"
          aria-pressed={state.paused}
          title="pause the transport"
        >
          {state.paused ? '▶' : '▮▮'}
        </button>
        <button
          type="button"
          onClick={onTheme}
          className="rounded border border-line px-2 py-0.5"
          aria-label="toggle theme"
        >
          {theme === 'dark' ? '☾' : '☀'}
        </button>
        <button
          type="button"
          onClick={onHelp}
          className="rounded border border-line px-2 py-0.5"
          aria-label="shortcuts"
        >
          ?
        </button>
      </div>
    </header>
  );
}
