import type { ReactNode } from 'react';
export type DotTone = 'ok' | 'warn' | 'fail' | 'idle' | 'accent';

const TONE: Record<DotTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  fail: 'bg-fail',
  idle: 'bg-ink-muted/50',
  accent: 'bg-accent',
};

export function StatusDot({ tone, label }: { tone: DotTone; label?: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span className={`inline-block size-2 rounded-full ${TONE[tone]}`} aria-hidden />
      {label ? <span className="text-ink-muted">{label}</span> : null}
    </span>
  );
}
