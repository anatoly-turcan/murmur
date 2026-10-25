import type { BootError } from '@murmur/dev-protocol';
import type { ReactNode } from 'react';

import { useUiState } from '../hooks/useUiState.ts';
import { formatRoute } from '../router.ts';
import { useStore } from '../store/store.ts';

function BootErrorLine({ error }: { error: BootError }) {
  const where = error.file ? `${error.file}: ` : '';

  return (
    <div>
      [{error.phase}] {where}
      {error.message}
    </div>
  );
}

export function BottomStrip(): ReactNode {
  const state = useUiState();
  const store = useStore();
  const report = state.phase === 'boot-failed' ? state.bootReport : null;
  const warnings = state.snapshot?.warnings.length ?? 0;

  return (
    <footer
      className={`flex shrink-0 flex-col border-t text-xs ${report ? 'border-fail bg-fail/10' : 'border-line'}`}
    >
      {report ? (
        <div className="max-h-40 overflow-auto px-3 py-1 font-mono text-fail">
          {report.errors.map((e, i) => (
            <BootErrorLine key={i} error={e} />
          ))}
        </div>
      ) : null}
      <div className="flex h-7 items-center gap-4 px-3">
        {state.missed > 0 ? (
          <span className="text-warn">
            {state.missed} events missed (buffer evicted){' '}
            <button type="button" className="text-accent" onClick={store.clearMissed}>
              dismiss
            </button>
          </span>
        ) : null}
        {state.ring.evicted > 0 ? (
          <span className="text-ink-muted">
            {state.ring.evicted} older envelopes dropped from the local buffer
          </span>
        ) : null}
        <a
          href={`${formatRoute({ screen: 'catalog' })}`}
          className={`ml-auto ${warnings ? 'text-warn' : 'text-ink-muted'}`}
        >
          {warnings} warnings
        </a>
      </div>
    </footer>
  );
}
