import type { ReactNode } from 'react';
export function Tabs<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly T[];
  active: T;
  onSelect: (tab: T) => void;
}): ReactNode {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line">
      {tabs.map((tab, i) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={tab === active}
          onClick={() => onSelect(tab)}
          className={`-mb-px border-b-2 px-3 py-1.5 ${tab === active ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}
        >
          <span className="mr-1 font-mono text-[10px] text-ink-muted">{i + 1}</span>
          {tab}
        </button>
      ))}
    </div>
  );
}
