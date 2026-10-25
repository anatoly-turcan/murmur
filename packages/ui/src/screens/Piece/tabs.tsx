import type { ContextResponse, ContractView, PieceDetail, StoredEnvelope } from '@murmur/dev-protocol';
import { useState, type ReactNode } from 'react';

import { api } from '../../api/client.ts';
import { emitFixture, fixtureFor } from '../../api/emit.ts';
import { kindMark } from '../../components/contract-kind.ts';
import { Json } from '../../components/Json.tsx';
import { ContractName } from '../../components/KindBadge.tsx';
import { Markdown } from '../../components/Markdown.tsx';
import { TokenMeter } from '../../components/TokenMeter.tsx';
import { useAsync, type AsyncState } from '../../hooks/useAsync.ts';
import { formatRoute } from '../../router.ts';
import { useShell } from '../../shell.ts';
import { deliveryFact, type DeliveryFact } from '../../store/sys.ts';
import { bytes, clock, ms } from '../format.ts';
import { schemaFields } from './schema.ts';

export const WARN_TOKENS = 20_000;
export const FAIL_TOKENS = 40_000;

const LEVEL_TONES = new Map<string, string>([
  ['error', 'text-fail'],
  ['warn', 'text-warn'],
]);
const SIZING_TONES = new Map<string, string>([
  ['fail', 'text-fail'],
  ['warn', 'text-warn'],
]);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function ContractLinks({ names }: { names: string[] }) {
  const shell = useShell();

  if (!names.length) {
    return <span className="text-ink-muted">—</span>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {names.map((n) => (
        <button
          key={n}
          type="button"
          className="font-mono text-xs text-accent"
          onClick={() => shell.openDrawer({ kind: 'contract', name: n })}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

function PieceLinks({ ids }: { ids: string[] }) {
  if (!ids.length) {
    return <span className="text-ink-muted">—</span>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {ids.map((id) => (
        <a
          key={id}
          className="font-mono text-xs text-accent"
          href={formatRoute({ screen: 'piece', path: id })}
        >
          {id}
        </a>
      ))}
    </div>
  );
}

export function PieceKindLabel({ piece }: { piece: Pick<PieceDetail, 'kind' | 'className'> }): ReactNode {
  return (
    <span className="flex items-center gap-2 text-xs">
      {piece.className ? <span className="font-mono">{piece.className}</span> : null}
      <span className="rounded border border-line px-1.5 text-ink-muted" aria-label="piece kind">
        {piece.kind}
      </span>
    </span>
  );
}

function ConfigTable({ config }: { config: PieceDetail['config'] }) {
  return (
    <table className="font-mono text-xs">
      <tbody>
        {config.map((c) => (
          <tr key={c.key}>
            <td className="pr-4">{c.key}</td>
            <td className="pr-4 text-ink-muted">{c.type}</td>
            <td className={`pr-4 ${c.source === 'missing' ? 'text-fail' : ''}`}>{c.source}</td>
            <td className="text-ink-muted">{c.env}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OverviewTab({ piece }: { piece: PieceDetail }): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold">{piece.title}</h1>
          <PieceKindLabel piece={piece} />
        </div>
        <p className="text-ink-muted">{piece.summary ?? 'no summary'}</p>
      </div>
      {piece.contextMd ? <Markdown source={piece.contextMd} /> : <p className="text-warn">no context.md</p>}
      <div className="grid grid-cols-2 gap-4">
        <Section title="needs">
          <span className="font-mono text-xs">{piece.needs.join(', ') || '—'}</span>
        </Section>
        <Section title="handles">
          <ContractLinks names={piece.handles} />
        </Section>
        <Section title="emits">
          <ContractLinks names={piece.emits} />
        </Section>
        <Section title="parent">
          <PieceLinks ids={piece.parent ? [piece.parent] : []} />
        </Section>
        <Section title="children">
          <PieceLinks ids={piece.children} />
        </Section>
      </div>
      <Section title="config">
        {piece.config.length ? (
          <ConfigTable config={piece.config} />
        ) : (
          <span className="text-ink-muted">no config keys</span>
        )}
      </Section>
    </div>
  );
}

function FieldTable({ schema }: { schema: unknown }) {
  return (
    <table className="mt-2 font-mono text-xs">
      <tbody>
        {schemaFields(schema).map((f) => (
          <tr key={f.path}>
            <td className="pr-4">
              {f.path}
              {f.required ? '' : '?'}
            </td>
            <td className="text-ink-muted">{f.type}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ContractBlock({ contract }: { contract: ContractView }) {
  const shell = useShell();
  const [raw, setRaw] = useState(false);
  const fixture = fixtureFor(contract);
  const emit = () =>
    emitFixture(contract, fixture).then(
      (r) => shell.toast(`emitted ${contract.name} → ${r.traceId.slice(0, 8)}`),
      (e: unknown) => shell.toast(e instanceof Error ? e.message : String(e), 'error'),
    );

  return (
    <div className="rounded border border-line p-3">
      <div className="flex items-center gap-2">
        <span className="font-semibold">
          <ContractName contract={contract} />
        </span>
        <span
          className={`rounded px-1.5 text-[10px] ${contract.visibility === 'internal' ? 'bg-warn/15 text-warn' : 'bg-accent/15 text-accent'}`}
        >
          {contract.visibility}
          {contract.scope ? ` · ${contract.scope}` : ''}
        </span>
        <span className="text-xs text-ink-muted">{kindMark(contract).title}</span>
        <button type="button" className="ml-auto text-xs text-accent" onClick={() => setRaw(!raw)}>
          {raw ? 'fields' : 'JSON Schema'}
        </button>
      </div>
      {raw ? <Json value={contract.schema} /> : <FieldTable schema={contract.schema.payload} />}
      <div className="mt-2 flex items-start gap-2">
        <span className="text-xs text-ink-muted">fixture</span>
        <Json value={fixture} />
        <button
          type="button"
          className="ml-auto rounded border border-line px-2 py-0.5 text-xs hover:border-accent"
          onClick={() => void emit()}
        >
          emit
        </button>
      </div>
    </div>
  );
}

export function ContractsTab({
  piece,
  contracts,
}: {
  piece: PieceDetail;
  contracts: ContractView[];
}): ReactNode {
  const names = new Set([...piece.handles, ...piece.emits]);
  const own = contracts.filter((c) => names.has(c.name));

  return own.length ? (
    <div className="flex flex-col gap-3">
      {own.map((c) => (
        <ContractBlock key={c.name} contract={c} />
      ))}
    </div>
  ) : (
    <p className="text-ink-muted">this piece declares no contracts</p>
  );
}

const FAIL_KINDS = new Set(['failed', 'deadlettered', 'timeout']);

export function deliveriesFirstFailures(stored: StoredEnvelope[], piece: string): DeliveryFact[] {
  const facts = stored
    .flatMap((s) => deliveryFact(s) ?? [])
    .filter((f) => f.piece === piece && f.kind !== 'received');

  return facts.toSorted(
    (a, b) => Number(FAIL_KINDS.has(b.kind)) - Number(FAIL_KINDS.has(a.kind)) || b.at - a.at,
  );
}

export function DeliveriesTab({ facts }: { facts: DeliveryFact[] }): ReactNode {
  if (!facts.length) {
    return <p className="text-ink-muted">no deliveries yet</p>;
  }

  return (
    <table className="w-full font-mono text-xs">
      <tbody>
        {facts.map((f, i) => (
          <tr key={i} className={FAIL_KINDS.has(f.kind) ? 'text-fail' : ''}>
            <td className="pr-3">{clock(new Date(f.at).toISOString())}</td>
            <td className="pr-3">{f.kind}</td>
            <td className="pr-3">#{f.attempt}</td>
            <td className="pr-3">{ms(f.durationMs)}</td>
            <td className="pr-3 text-ink-muted">{f.envelopeId.slice(0, 8)}</td>
            <td>{f.error ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LogsTab({ piece }: { piece: PieceDetail }): ReactNode {
  const logs = useAsync(() => api.logs({ piece: piece.name, limit: 500 }), [piece.name]);
  const items = logs.status === 'ok' ? logs.value.items : piece.logs;

  if (!items.length) {
    return <p className="text-ink-muted">no log lines</p>;
  }

  return (
    <div className="font-mono text-xs">
      {items.map((l, i) => (
        <div key={i} className={LEVEL_TONES.get(l.level) ?? ''}>
          <span className="text-ink-muted">{clock(l.ts)}</span> {l.level} {l.msg}
          {l.traceId ? (
            <a className="ml-2 text-accent" href={formatRoute({ screen: 'traces', traceId: l.traceId })}>
              {l.traceId.slice(0, 8)}
            </a>
          ) : null}
          {l.fields ? <span className="ml-2 text-ink-muted">{JSON.stringify(l.fields)}</span> : null}
        </div>
      ))}
    </div>
  );
}

export function FilesTab({ piece }: { piece: PieceDetail }): ReactNode {
  return (
    <table className="font-mono text-xs">
      <tbody>
        {piece.files.map((f) => (
          <tr key={f.path}>
            <td className="pr-6">{f.path}</td>
            <td className="text-ink-muted">{bytes(f.bytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ContextView({ ctx }: { ctx: ContextResponse }) {
  const shell = useShell();
  const copy = () =>
    void navigator.clipboard?.writeText(ctx.markdown).then(() => shell.toast('context copied'));
  const tone = SIZING_TONES.get(ctx.sizing) ?? 'text-ok';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs">{ctx.tokens} tokens</span>
        <span className={`text-xs ${tone}`}>sizing {ctx.sizing}</span>
        {ctx.overBudget ? <span className="text-xs text-fail">over budget</span> : null}
        <button
          type="button"
          onClick={copy}
          className="ml-auto rounded border border-line px-2 py-0.5 text-xs hover:border-accent"
        >
          copy for agent
        </button>
      </div>
      <TokenMeter tokens={ctx.tokens} warnAt={WARN_TOKENS} failAt={FAIL_TOKENS} />
      <table className="font-mono text-xs">
        <tbody>
          {ctx.sections.map((s) => (
            <tr key={s.id}>
              <td className="pr-4">{s.title}</td>
              <td className="w-48 pr-4">
                <div
                  className="h-1.5 rounded bg-accent/60"
                  style={{ width: `${Math.min(100, (s.tokens / Math.max(1, ctx.tokens)) * 100)}%` }}
                />
              </td>
              <td className="pr-4 text-ink-muted">{s.tokens}</td>
              <td className="text-ink-muted">
                L{s.level}
                {s.truncated ? ' · truncated' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre className="max-h-[480px] overflow-auto rounded bg-panel p-3 font-mono text-xs whitespace-pre-wrap">
        {ctx.markdown}
      </pre>
    </div>
  );
}

function ContextBody({ ctx }: { ctx: AsyncState<ContextResponse> }) {
  if (ctx.status === 'ok') {
    return <ContextView ctx={ctx.value} />;
  }

  if (ctx.status === 'error') {
    return <p className="text-fail">{ctx.error}</p>;
  }

  return <p className="text-ink-muted">assembling context…</p>;
}

export function ContextTab({ id }: { id: string }): ReactNode {
  const [budget, setBudget] = useState<number | null>(null);
  const ctx = useAsync(() => api.context(id, budget ?? undefined), [id, budget]);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-3 text-xs">
        <span className="text-ink-muted">budget</span>
        <input
          type="range"
          min={0}
          max={FAIL_TOKENS}
          step={1000}
          value={budget ?? FAIL_TOKENS}
          onChange={(e) => setBudget(Number(e.target.value))}
          aria-label="budget"
        />
        <span className="font-mono">{budget === null ? 'none' : budget}</span>
        {budget !== null ? (
          <button type="button" className="text-accent" onClick={() => setBudget(null)}>
            no budget
          </button>
        ) : null}
      </label>
      <ContextBody ctx={ctx} />
    </div>
  );
}
