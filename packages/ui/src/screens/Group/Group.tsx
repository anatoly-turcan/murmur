import type { ReactNode } from 'react';

import { api } from '../../api/client.ts';
import { Markdown } from '../../components/Markdown.tsx';
import { StatusDot } from '../../components/StatusDot.tsx';
import { useAsync } from '../../hooks/useAsync.ts';
import { useUiState } from '../../hooks/useUiState.ts';
import { formatRoute } from '../../router.ts';
import { useShell } from '../../shell.ts';
import { inScope } from '../../store/tree.ts';

const STATUS_TONE = { running: 'ok', starting: 'accent', stopped: 'idle', failed: 'fail' } as const;

export function Group({ id }: { id: string }): ReactNode {
  const state = useUiState();
  const shell = useShell();
  const ctx = useAsync(() => api.context(id), [id]);
  const pieces = (state.snapshot?.pieces ?? []).filter((p) => inScope(p.name, id));
  const internal = (state.snapshot?.contracts ?? []).filter((c) => c.scope === id);
  const depth = id.split('/').length;

  return (
    <div className="flex flex-col gap-4 p-3">
      <h1 className="font-mono text-lg">{id}</h1>
      {ctx.status === 'ok' ? (
        <Markdown source={ctx.value.markdown} />
      ) : (
        <p className="text-ink-muted">no group context.md</p>
      )}
      <section>
        <h3 className="mb-1 text-xs font-semibold text-ink-muted uppercase">children</h3>
        <table className="w-full text-xs">
          <thead className="text-left text-ink-muted">
            <tr>
              <th className="font-normal">piece</th>
              <th className="font-normal">summary</th>
              <th className="font-normal">status</th>
              <th className="font-normal">recv / ok / fail / dead / inflight</th>
            </tr>
          </thead>
          <tbody>
            {pieces.map((p) => {
              const c = state.live.get(p.name)?.counters ?? p.counters;

              return (
                <tr key={p.name} className="hover:bg-panel">
                  <td
                    className="py-0.5 font-mono"
                    style={{ paddingLeft: (p.name.split('/').length - depth) * 12 }}
                  >
                    <a
                      className="text-accent"
                      href={formatRoute({ screen: 'piece', path: p.name, scope: id })}
                    >
                      {p.title}
                    </a>
                  </td>
                  <td className="text-ink-muted">{p.summary ?? '—'}</td>
                  <td>
                    <StatusDot tone={STATUS_TONE[p.status]} label={p.status} />
                  </td>
                  <td className="font-mono">
                    {c.received} / {c.acked} / <span className={c.failed ? 'text-fail' : ''}>{c.failed}</span>{' '}
                    / {c.deadLettered} / {c.inflight}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section>
        <h3 className="mb-1 text-xs font-semibold text-ink-muted uppercase">internal contracts</h3>
        {internal.length ? (
          internal.map((c) => (
            <button
              key={c.name}
              type="button"
              className="mr-3 font-mono text-xs text-accent"
              onClick={() => shell.openDrawer({ kind: 'contract', name: c.name })}
            >
              {c.name}
            </button>
          ))
        ) : (
          <p className="text-ink-muted">none</p>
        )}
      </section>
    </div>
  );
}
