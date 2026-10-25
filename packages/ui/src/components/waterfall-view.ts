import type { WaterfallRow } from './waterfall-math.ts';

export function hiddenRows(rows: WaterfallRow[], collapsed: ReadonlySet<string>): Set<number> {
  const hidden = new Set<number>();
  rows.forEach((row, i) => {
    const parent = row.parentRow;
    if (parent === null) {
      return;
    }

    const parentRow = rows[parent];
    if (hidden.has(parent) || (parentRow && collapsed.has(parentRow.nodeId))) {
      hidden.add(i);
    }
  });

  return hidden;
}

export interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function guideLines(
  rows: WaterfallRow[],
  visible: number[],
  rowHeight: number,
  step: number,
): GuideLine[] {
  const position = new Map(visible.map((rowIndex, i) => [rowIndex, i]));

  return visible.flatMap((rowIndex, i) => {
    const row = rows[rowIndex];
    const parentRow = row?.parentRow ?? null;
    const parent = parentRow === null ? undefined : rows[parentRow];
    const parentAt = parentRow === null ? undefined : position.get(parentRow);

    if (row === undefined || parent === undefined || parentAt === undefined) {
      return [];
    }

    const x = parent.causalDepth * step + step / 2;
    const y = i * rowHeight + rowHeight / 2;

    return [
      { x1: x, y1: parentAt * rowHeight + rowHeight / 2, x2: x, y2: y },
      { x1: x, y1: y, x2: row.causalDepth * step + step / 2, y2: y },
    ];
  });
}

export interface DedupeLink {
  from: number;
  to: number;
}

function nearRequest(caller: WaterfallRow, request: WaterfallRow): boolean {
  const parent = request.node.parentId;

  return caller.nodeId === parent || (caller.node.parentId === parent && caller.nodeId !== request.nodeId);
}

function isCaller(caller: WaterfallRow, request: WaterfallRow): boolean {
  const callers = request.deduped?.by ?? [];

  return caller.piece !== null && callers.includes(caller.piece) && nearRequest(caller, request);
}

export function dedupeLinks(rows: WaterfallRow[]): DedupeLink[] {
  return rows.flatMap((row, to) =>
    rows.flatMap((caller, from) => (from !== to && isCaller(caller, row) ? [{ from, to }] : [])),
  );
}

export function dedupeLines(
  rows: WaterfallRow[],
  visible: number[],
  rowHeight: number,
  x: number,
): GuideLine[] {
  const position = new Map(visible.map((rowIndex, i) => [rowIndex, i]));

  return dedupeLinks(rows).flatMap(({ from, to }) => {
    const a = position.get(from);
    const b = position.get(to);

    if (a === undefined || b === undefined) {
      return [];
    }

    return [{ x1: x, y1: a * rowHeight + rowHeight / 2, x2: x, y2: b * rowHeight + rowHeight / 2 }];
  });
}
