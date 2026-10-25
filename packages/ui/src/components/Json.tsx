import { useState, type ReactNode } from 'react';

export const COLLAPSE_BYTES = 2048;

function Leaf({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    return <span className="text-ok">"{value}"</span>;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="text-accent">{String(value)}</span>;
  }

  return <span className="text-ink-muted">null</span>;
}

function Node({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const isObject = typeof value === 'object' && value !== null;
  const [open, setOpen] = useState(depth < 2);
  const label = name === null ? null : <span className="text-ink-muted">{name}: </span>;

  if (!isObject) {
    return (
      <div>
        {label}
        <Leaf value={value} />
      </div>
    );
  }

  const entries = Object.entries(value);
  const brackets = Array.isArray(value) ? ['[', ']'] : ['{', '}'];

  return (
    <div>
      <button type="button" className="hover:text-accent" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {label}
        {brackets[0]}
        {open ? '' : ` ${entries.length} ${brackets[1]}`}
      </button>
      {open ? (
        <div className="ml-4">
          {entries.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} />
          ))}
          <div>{brackets[1]}</div>
        </div>
      ) : null}
    </div>
  );
}

export function Json({ value }: { value: unknown }): ReactNode {
  const size = JSON.stringify(value ?? null)?.length ?? 0;
  const [expanded, setExpanded] = useState(size <= COLLAPSE_BYTES);

  if (!expanded) {
    return (
      <button
        type="button"
        className="font-mono text-xs text-ink-muted hover:text-accent"
        onClick={() => setExpanded(true)}
      >
        ▸ payload {(size / 1024).toFixed(1)} KB — expand
      </button>
    );
  }

  return (
    <div className="font-mono text-xs leading-5">
      <Node name={null} value={value} depth={0} />
    </div>
  );
}
