export function fence(lang: string, text: string): string {
  const ticks = text.includes('```') ? '````' : '```';

  return `${ticks}${lang}\n${text.trimEnd()}\n${ticks}`;
}

export function firstH1Section(markdown: string): string {
  const lines = markdown.trim().split('\n');
  const start = lines.findIndex((line) => line.startsWith('# '));

  if (start === -1) {
    return lines.slice(0, 1).join('\n');
  }

  const next = lines.findIndex((line, i) => i > start && /^#{1,6} /.test(line));

  return lines
    .slice(start, next === -1 ? undefined : next)
    .join('\n')
    .trim();
}

export function firstParagraph(markdown: string): string {
  const paragraph = markdown
    .trim()
    .split(/\n\s*\n/)
    .find((p) => !p.startsWith('#'));

  return (paragraph ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.map((c) => c.replaceAll('|', '\\|')).join(' | ')} |`;
}

export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [tableRow(header), tableRow(header.map(() => '---')), ...rows.map(tableRow)].join('\n');
}

export function joinBlocks(blocks: readonly string[]): string {
  return blocks.filter((b) => b.trim() !== '').join('\n\n');
}
