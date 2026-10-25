import type { ReactNode } from 'react';

import { CopyCommand } from './CopyCommand.tsx';

export function EmptyState({
  title,
  command,
  children,
}: {
  title: string;
  command?: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-8 text-center text-ink-muted">
      <p>{title}</p>
      {command ? <CopyCommand command={command} /> : null}
      {children}
    </div>
  );
}
