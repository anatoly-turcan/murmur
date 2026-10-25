const REPO_ONLY = new Set(['Releasing', 'Repository']);

interface Line {
  readonly text: string;
  readonly heading: string | undefined;
}

function classify(lines: readonly string[]): Line[] {
  let fenced = false;

  return lines.map((text) => {
    if (text.startsWith('```')) {
      fenced = !fenced;
    }

    const heading = !fenced && text.startsWith('## ') ? text.slice(3).trim() : undefined;

    return { text, heading };
  });
}

function keptLines(lines: readonly Line[]): string[] {
  let dropping = false;

  return lines.flatMap((line) => {
    if (line.heading !== undefined) {
      dropping = REPO_ONLY.has(line.heading);
    }

    return dropping ? [] : [line.text];
  });
}

export function userReadme(text: string): string {
  const kept = keptLines(classify(text.split('\n')));

  return `${kept.join('\n').trimEnd()}\n`;
}
