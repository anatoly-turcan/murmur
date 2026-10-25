export function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((row) => (row[i] ?? '').length)));
  const line = (row: readonly string[]) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();

  return all.map(line).join('\n');
}

export function renderTree<T extends { readonly children: readonly T[] }>(
  nodes: readonly T[],
  label: (node: T) => string,
  indent = '',
): string[] {
  return nodes.flatMap((node, i) => {
    const last = i === nodes.length - 1;
    const line = `${indent}${last ? '└─ ' : '├─ '}${label(node)}`;

    return [line, ...renderTree(node.children, label, `${indent}${last ? '   ' : '│  '}`)];
  });
}
