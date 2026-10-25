import type { ReactNode } from 'react';

export const MIN_DRAWER = 280;
export const MAX_DRAWER = 760;
export const DRAWER_STEP = 60;

export function resizeDrawer(width: number, key: '[' | ']'): number {
  const next = key === '[' ? width - DRAWER_STEP : width + DRAWER_STEP;

  return Math.min(MAX_DRAWER, Math.max(MIN_DRAWER, next));
}

export function Drawer({
  width,
  title,
  onClose,
  children,
}: {
  width: number;
  title: string;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l border-line bg-paper"
      style={{ width }}
      aria-label="drawer"
    >
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="truncate font-mono text-xs">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-ink-muted hover:text-ink"
          aria-label="close drawer"
        >
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-auto p-3">{children}</div>
    </aside>
  );
}
