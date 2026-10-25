import type { ReactNode } from 'react';

import { formatRoute } from '../router.ts';

export function crumbs(path: string): { id: string; label: string }[] {
  const segments = path.split('/');

  return segments.map((label, i) => ({ id: segments.slice(0, i + 1).join('/'), label }));
}

export function Breadcrumb({ path, scope }: { path: string | null; scope: string | null }): ReactNode {
  const target = path ?? scope;

  return (
    <nav className="flex items-center gap-1 font-mono text-xs text-ink-muted" aria-label="breadcrumb">
      <a href={formatRoute({ screen: 'flock', scope: null })} className="hover:text-accent">
        pieces
      </a>
      {target
        ? crumbs(target).map((c) => (
            <span key={c.id} className="flex items-center gap-1">
              <span>›</span>
              <a href={formatRoute({ screen: 'piece', path: c.id, scope })} className="hover:text-accent">
                {c.label}
              </a>
            </span>
          ))
        : null}
    </nav>
  );
}
