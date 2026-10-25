import type { ReactNode } from 'react';

import type { ToastKind } from '../shell.ts';

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

export function Toasts({ items }: { items: ToastItem[] }): ReactNode {
  return (
    <div className="pointer-events-none fixed right-4 bottom-12 z-50 flex flex-col gap-2" role="status">
      {items.map((t) => (
        <div
          key={t.id}
          className={`rounded border bg-paper px-3 py-2 shadow ${t.kind === 'error' ? 'border-fail text-fail' : 'border-line'}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
