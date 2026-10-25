import { codePoints, fold, sliceCodePoints } from './normalize.ts';

export const SLUG_MAX = 50;
const SLUG_RE = /^[\p{Ll}\p{Lm}\p{Lo}\p{Nd}]+(?:-[\p{Ll}\p{Lm}\p{Lo}\p{Nd}]+)*$/u;
const NON_ALNUM_RUN = /[^\p{L}\p{N}]+/gu;
const EDGE_HYPHENS = /^-+|-+$/g;

export type SlugProblem = 'too_long' | 'invalid_format';

export function slugProblem(slug: string): SlugProblem | null {
  if (codePoints(slug) > SLUG_MAX) return 'too_long';

  return SLUG_RE.test(slug) ? null : 'invalid_format';
}

export function slugKey(slug: string): string {
  return fold(slug);
}

function trimHyphens(text: string): string {
  return text.replace(EDGE_HYPHENS, '');
}

export function slugBase(name: string, fallback: string): string {
  const hyphenated = trimHyphens(fold(name).replace(NON_ALNUM_RUN, '-'));
  const cut = trimHyphens(sliceCodePoints(hyphenated, SLUG_MAX));

  return cut === '' ? fallback : cut;
}

export function withSuffix(base: string, n: number): string {
  const suffix = `-${n}`;

  return `${trimHyphens(sliceCodePoints(base, SLUG_MAX - suffix.length))}${suffix}`;
}

export function firstFreeSlug(base: string, isTaken: (slug: string) => boolean): string {
  if (!isTaken(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = withSuffix(base, n);
    if (!isTaken(candidate)) return candidate;
  }
}
