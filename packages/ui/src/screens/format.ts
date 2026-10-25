export function clock(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return ts;
  }

  return `${date.toTimeString().slice(0, 8)}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }

  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`;
}

export function age(fromMs: number, now: number): string {
  const s = Math.max(0, Math.round((now - fromMs) / 1000));
  if (s < 60) {
    return `${s}s`;
  }

  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }

  return `${Math.floor(s / 3600)}h`;
}

export function bytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
