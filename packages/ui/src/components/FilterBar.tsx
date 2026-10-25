import { useState, type ReactNode } from 'react';

import { readJsonLocal, writeJsonLocal } from '../store/local.ts';

const RECENT_KEY = 'murmur.filters';
const MAX_RECENT = 6;

export function rememberFilter(recent: string[], value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return recent;
  }

  return [trimmed, ...recent.filter((r) => r !== trimmed)].slice(0, MAX_RECENT);
}

export function FilterBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  const [recent, setRecent] = useState<string[]>(() => readJsonLocal<string[]>(RECENT_KEY, []));
  const commit = () => {
    const next = rememberFilter(recent, value);
    setRecent(next);
    writeJsonLocal(RECENT_KEY, next);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        onBlur={commit}
        placeholder="piece:billing/* contract:*.created failed: trace:7f3a internal: since:5m"
        className="min-w-80 flex-1 rounded border border-line bg-paper px-2 py-1 font-mono text-xs outline-none focus:border-accent"
        aria-label="filter"
      />
      {recent.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-muted hover:border-accent"
        >
          {r}
        </button>
      ))}
    </div>
  );
}
