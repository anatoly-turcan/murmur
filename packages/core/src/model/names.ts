import { MurmurError } from './errors.ts';

const SEGMENT = '[a-z][a-z0-9-]*';
const CLASS_SEGMENT = '[A-Z][A-Za-z0-9]*';
const WIRE_NAME = new RegExp(`^${SEGMENT}(\\.${SEGMENT})*\\.(${SEGMENT}|${CLASS_SEGMENT})$`);
const INTERNAL_NAME = new RegExp(`^\\$sys(\\.${SEGMENT})+$`);
const REPLY_NAME = /^\$reply\.[a-z0-9]{8}$/;
const PIECE_ID = new RegExp(`^${SEGMENT}(/${SEGMENT})*$`);
const MAX_NAME_BYTES = 255;

const encoder = new TextEncoder();
export const PATTERN_CACHE_LIMIT = 256;
const patterns = new Map<string, RegExp>();

function fitsWire(name: string): boolean {
  return encoder.encode(name).byteLength <= MAX_NAME_BYTES;
}

function invalid(message: string): MurmurError {
  return new MurmurError(message, { code: 'invalid-name', retryable: false });
}

export function isWireName(name: string): boolean {
  return WIRE_NAME.test(name) && fitsWire(name);
}

export function validateName(name: string): void {
  const wellFormed = WIRE_NAME.test(name) || INTERNAL_NAME.test(name) || REPLY_NAME.test(name);
  if (!wellFormed || !fitsWire(name)) {
    throw invalid(
      `invalid event name "${name}": use two or more dot-separated lowercase segments, optionally ending in a ClassName like todos.CreateTodo (max ${MAX_NAME_BYTES} bytes), $sys.<segment>… or $reply.<8 chars>`,
    );
  }
}

export function validatePieceId(id: string): void {
  if (!PIECE_ID.test(id)) {
    throw invalid(`invalid piece id "${id}": use a folder path of lowercase segments like billing/invoice`);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePattern(pattern: string): RegExp {
  const words = pattern.split('.').map((word) => {
    if (word === '#') {
      return '(?:\\.[^.]+)*';
    }

    if (word === '*') {
      return '\\.[^.]+';
    }

    return `\\.${escapeRegExp(word)}`;
  });

  return new RegExp(`^${words.join('')}$`);
}

function cachedPattern(pattern: string): RegExp {
  const compiled = patterns.get(pattern) ?? compilePattern(pattern);
  patterns.delete(pattern);
  patterns.set(pattern, compiled);

  if (patterns.size > PATTERN_CACHE_LIMIT) {
    patterns.delete(patterns.keys().next().value as string);
  }

  return compiled;
}

export function patternCacheSize(): number {
  return patterns.size;
}

export function matchPattern(pattern: string, name: string): boolean {
  return cachedPattern(pattern).test(`.${name}`);
}

export function isInternal(name: string): boolean {
  return name.startsWith('$sys.');
}

export function isReply(name: string): boolean {
  return name.startsWith('$reply.');
}
