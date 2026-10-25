import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { fuzzyFilter } from './fuzzy.ts';

export interface PaletteItem {
  id: string;
  group: 'piece' | 'contract' | 'capability' | 'trace' | 'screen' | 'action';
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }): ReactNode {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(
    () => fuzzyFilter(items, query, (i) => `${i.label} ${i.hint ?? ''}`),
    [items, query],
  );
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);
  const choose = (item: PaletteItem | undefined) => {
    if (!item) {
      return;
    }

    onClose();
    item.run();
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-center bg-ink/20 pt-24" onClick={onClose}>
      <div
        className="h-fit w-[560px] rounded border border-line bg-paper shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onClose();
            } else if (e.key === 'ArrowDown') {
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              choose(results[index]);
            } else {
              return;
            }

            e.preventDefault();
          }}
          placeholder="pieces, contracts, traces, screens, actions…"
          aria-label="command palette"
          className="w-full border-b border-line bg-transparent px-3 py-2 outline-none"
        />
        <ul className="max-h-80 overflow-auto py-1" role="listbox">
          {results.map((item, i) => (
            <li
              key={item.id}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(item)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1 ${i === index ? 'bg-accent/15' : ''}`}
            >
              <span className="w-20 text-[11px] text-ink-muted">{item.group}</span>
              <span className="flex-1 truncate font-mono text-xs">{item.label}</span>
              {item.hint ? <span className="truncate text-xs text-ink-muted">{item.hint}</span> : null}
            </li>
          ))}
          {results.length === 0 ? <li className="px-3 py-2 text-ink-muted">no match</li> : null}
        </ul>
      </div>
    </div>
  );
}
