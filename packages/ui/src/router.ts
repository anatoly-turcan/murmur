import { useCallback, useMemo, useSyncExternalStore } from 'react';

export type Screen = 'flock' | 'events' | 'traces' | 'piece' | 'catalog';

export interface Route {
  screen: Screen;
  traceId: string | null;
  path: string | null;
  scope: string | null;
  query: URLSearchParams;
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart = '/', search = ''] = raw.split('?');
  const query = new URLSearchParams(search);
  const scope = query.get('scope');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const base = { traceId: null, path: null, scope, query };
  const [head, ...rest] = segments;

  if (head === 'events') {
    return { ...base, screen: 'events' };
  }

  if (head === 'traces') {
    return { ...base, screen: 'traces', traceId: rest[0] ?? null };
  }

  if (head === 'pieces' && rest.length) {
    return { ...base, screen: 'piece', path: rest.join('/') };
  }

  if (head === 'catalog') {
    return { ...base, screen: 'catalog' };
  }

  return { ...base, screen: 'flock' };
}

export interface RouteTarget {
  screen: Screen;
  traceId?: string | null;
  path?: string | null;
  scope?: string | null;
  params?: Record<string, string>;
}

const SCREEN_PATH: Record<Screen, string> = {
  flock: '/',
  events: '/events',
  traces: '/traces',
  piece: '/pieces',
  catalog: '/catalog',
};

export function formatRoute(target: RouteTarget): string {
  let path = SCREEN_PATH[target.screen];
  if (target.screen === 'traces' && target.traceId) {
    path += `/${encodeURIComponent(target.traceId)}`;
  }

  if (target.screen === 'piece' && target.path) {
    path += `/${target.path.split('/').map(encodeURIComponent).join('/')}`;
  }

  const query = new URLSearchParams(target.params ?? {});
  if (target.scope) {
    query.set('scope', target.scope);
  }

  const search = query.toString();

  return `#${path}${search ? `?${search}` : ''}`;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);

  return () => window.removeEventListener('hashchange', listener);
}

export function navigate(target: RouteTarget | string): void {
  window.location.hash = typeof target === 'string' ? target : formatRoute(target);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);

  return useMemo(() => parseRoute(hash), [hash]);
}

export function useNavigate(): (target: RouteTarget) => void {
  const route = useRoute();

  return useCallback(
    (target: RouteTarget) =>
      navigate({ ...target, scope: target.scope === undefined ? route.scope : target.scope }),
    [route.scope],
  );
}
