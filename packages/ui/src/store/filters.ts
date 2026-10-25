import type { EventRow } from './rows.ts';

export interface EventFilter {
  piece?: string;
  contract?: string;
  trace?: string;
  failed?: true;
  internal?: true;
  since?: string;
  text: string[];
}

type ValueKey = 'piece' | 'contract' | 'trace' | 'since';
type FlagKey = 'failed' | 'internal';

const ORDER = ['piece', 'contract', 'trace', 'failed', 'internal', 'since'] as const;
const VALUE_KEYS = new Set<string>(['piece', 'contract', 'trace', 'since']);
const FLAG_KEYS = new Set<string>(['failed', 'internal']);
const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION = /^(\d+)(ms|s|m|h|d)$/;

export function parseDuration(input: string): number | null {
  const match = DURATION.exec(input);
  if (!match) {
    return null;
  }

  return Number(match[1]) * (UNITS[match[2] ?? ''] ?? 0);
}

function applyToken(filter: EventFilter, token: string): void {
  const colon = token.indexOf(':');
  const key = colon > 0 ? token.slice(0, colon) : '';
  const value = token.slice(colon + 1);

  if (FLAG_KEYS.has(key) && (value === '' || value === 'true')) {
    filter[key as FlagKey] = true;
  } else if (VALUE_KEYS.has(key) && value !== '' && (key !== 'since' || parseDuration(value) !== null)) {
    filter[key as ValueKey] = value;
  } else {
    filter.text.push(token);
  }
}

export function parseFilter(input: string): EventFilter {
  const filter: EventFilter = { text: [] };
  for (const token of input.split(/\s+/).filter(Boolean)) {
    applyToken(filter, token);
  }

  return filter;
}

function formatKey(filter: EventFilter, key: (typeof ORDER)[number]): string | null {
  const value = filter[key];
  if (value === undefined) {
    return null;
  }

  return value === true ? `${key}:` : `${key}:${value}`;
}

export function formatFilter(filter: EventFilter): string {
  const keyed = ORDER.flatMap((key) => formatKey(filter, key) ?? []);

  return [...keyed, ...filter.text].join(' ');
}

export function withScope(filter: EventFilter, scope: string | null): EventFilter {
  if (!scope || filter.piece) {
    return filter;
  }

  return { piece: `${scope}/*`, ...filter };
}

function escape(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function globMatch(pattern: string, value: string): boolean {
  if (pattern.endsWith('/*') && value === pattern.slice(0, -2)) {
    return true;
  }

  return new RegExp(`^${escape(pattern).replaceAll('*', '.*')}$`).test(value);
}

function contractName(row: EventRow): string {
  const payload = row.stored.envelope.payload;
  const inner =
    typeof payload === 'object' && payload !== null ? (payload as { name?: unknown }).name : undefined;

  return row.stored.meta.internal && typeof inner === 'string' ? inner : row.stored.envelope.name;
}

function matchPiece(row: EventRow, pattern: string): boolean {
  const pieces = [row.from, ...row.to].filter((p): p is string => p !== null);

  return pieces.some((piece) => globMatch(pattern, piece));
}

function matchContract(row: EventRow, pattern: string): boolean {
  return globMatch(pattern, row.stored.envelope.name) || globMatch(pattern, contractName(row));
}

function isFailed(row: EventRow): boolean {
  return row.outcome === 'failed' || row.outcome === 'deadLettered' || row.stored.meta.failed === true;
}

function matchSince(row: EventRow, since: string, now: number): boolean {
  const window = parseDuration(since);

  return window === null || now - Date.parse(row.stored.envelope.ts) <= window;
}

function matchText(row: EventRow, text: string[]): boolean {
  const haystack = [row.stored.envelope.name, row.stored.envelope.traceId, row.from ?? '', ...row.to]
    .join(' ')
    .toLowerCase();

  return text.every((word) => haystack.includes(word.toLowerCase()));
}

export function matchFilter(row: EventRow, filter: EventFilter, now: number): boolean {
  if (row.stored.meta.internal && !filter.internal) {
    return false;
  }

  if (filter.piece && !matchPiece(row, filter.piece)) {
    return false;
  }

  if (filter.contract && !matchContract(row, filter.contract)) {
    return false;
  }

  if (filter.trace && !row.stored.envelope.traceId.startsWith(filter.trace)) {
    return false;
  }

  if (filter.failed && !isFailed(row)) {
    return false;
  }

  if (filter.since && !matchSince(row, filter.since, now)) {
    return false;
  }

  return matchText(row, filter.text);
}
