import type { ReactNode } from 'react';

export function Kbd({ children }: { children: ReactNode }): ReactNode {
  return (
    <kbd className="rounded border border-line bg-panel px-1 font-mono text-[11px] text-ink-muted">
      {children}
    </kbd>
  );
}
