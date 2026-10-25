const UNITS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

export type Since = { kind: 'seq'; seq: number } | { kind: 'age'; ms: number };

export function parseSince(text: string | null | undefined): Since | null {
  if (text === null || text === undefined || text.trim() === '') {
    return null;
  }

  if (/^\d+$/.test(text)) {
    return { kind: 'seq', seq: Number(text) };
  }

  const match = /^(\d+)(ms|s|m|h)$/.exec(text.trim());

  return match === null ? null : { kind: 'age', ms: Number(match[1]) * (UNITS[match[2] as string] ?? 1) };
}
