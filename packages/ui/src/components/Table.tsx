import { useState, type ReactNode } from 'react';

export const ROW_HEIGHT = 28;
const OVERSCAN = 10;

export function visibleWindow(
  scrollTop: number,
  viewport: number,
  count: number,
  rowHeight = ROW_HEIGHT,
): { first: number; last: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);

  return { first, last };
}

export interface Column<T> {
  key: string;
  title: string;
  width: string;
  render: (row: T) => ReactNode;
}

export function Table<T>({
  rows,
  columns,
  rowKey,
  selected,
  onSelect,
  expanded,
  renderExpanded,
  height = 600,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  selected?: string | null;
  onSelect?: (row: T) => void;
  expanded?: string | null;
  renderExpanded?: (row: T) => ReactNode;
  height?: number;
}): ReactNode {
  const [scrollTop, setScrollTop] = useState(0);
  const template = columns.map((c) => c.width).join(' ');
  const expandedRow = expanded ? rows.find((r) => rowKey(r) === expanded) : undefined;
  const { first, last } = visibleWindow(scrollTop, height, rows.length);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded border border-line">
      <div
        className="grid border-b border-line bg-panel px-2 py-1 text-xs text-ink-muted"
        style={{ gridTemplateColumns: template }}
      >
        {columns.map((c) => (
          <div key={c.key}>{c.title}</div>
        ))}
      </div>
      <div
        className="relative overflow-auto"
        style={{ height }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        role="grid"
      >
        <div style={{ height: rows.length * ROW_HEIGHT }} />
        {rows.slice(first, last).map((row, i) => {
          const index = first + i;
          const key = rowKey(row);
          const top = index * ROW_HEIGHT;

          return (
            <div
              key={key}
              role="row"
              aria-selected={selected === key}
              onClick={() => onSelect?.(row)}
              className={`absolute inset-x-0 grid cursor-pointer items-center px-2 font-mono text-xs ${selected === key ? 'bg-accent/10' : 'hover:bg-panel'}`}
              style={{ top, height: ROW_HEIGHT, gridTemplateColumns: template }}
            >
              {columns.map((c) => (
                <div key={c.key} className="truncate pr-2">
                  {c.render(row)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {expandedRow !== undefined && renderExpanded ? (
        <div className="max-h-72 overflow-auto border-t border-line p-3">{renderExpanded(expandedRow)}</div>
      ) : null}
    </div>
  );
}
