const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : iso(ms);
}

export function parseTimestamp(text: string): number | null {
  if (!TIMESTAMP_RE.test(text)) return null;
  try {
    return Temporal.Instant.from(text.toUpperCase()).epochMilliseconds;
  } catch {
    return null;
  }
}

export function isDateShaped(text: string): boolean {
  return DATE_RE.test(text);
}

export function isRealDate(text: string): boolean {
  const match = DATE_RE.exec(text);
  if (!match) return false;
  try {
    Temporal.PlainDate.from({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, { overflow: 'reject' });

    return true;
  } catch {
    return false;
  }
}
