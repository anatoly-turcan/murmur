export function markdownTable(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const divider = line(headers.map(() => '---'))

  return [line(headers), divider, ...rows.map(line)].join('\n')
}
