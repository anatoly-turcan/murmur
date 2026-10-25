const EDGE_WHITESPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

export function nfcTrim(text: string): string {
  return text.normalize('NFC').replace(EDGE_WHITESPACE, '');
}

export function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;

  return count;
}

export function sliceCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

function caseFold(text: string): string {
  let out = '';
  for (const ch of text) out += ch.toUpperCase().toLowerCase();

  return out;
}

export function fold(text: string): string {
  return caseFold(text.normalize('NFKC')).normalize('NFKC');
}
