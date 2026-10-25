import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailProblem } from '../src/text/email.ts';
import { codePoints, fold, nfcTrim, sliceCodePoints } from '../src/text/normalize.ts';
import { firstFreeSlug, SLUG_MAX, slugBase, slugProblem, withSuffix } from '../src/text/slug.ts';

test('nfcTrim composes and trims Unicode whitespace', () => {
  assert.equal(nfcTrim('  Café '), 'Café');
});

test('code points count astral characters once', () => {
  assert.equal(codePoints('a\u{1F600}b'), 3);
  assert.equal(sliceCodePoints('\u{1F600}\u{1F600}\u{1F600}', 2), '\u{1F600}\u{1F600}');
});

test('fold is case- and compatibility-insensitive', () => {
  assert.equal(fold('STRASSE'), fold('strasse'));
  assert.equal(fold('Ａ'), 'a');
});

test('slugBase hyphenates and falls back', () => {
  assert.equal(slugBase('  Hello, World!  ', 'project'), 'hello-world');
  assert.equal(slugBase('!!!', 'project'), 'project');
  assert.equal(slugProblem(slugBase('x'.repeat(80), 'p')), null);
});

test('slug suffixes stay within the maximum length', () => {
  const base = 'a'.repeat(SLUG_MAX);
  assert.equal(codePoints(withSuffix(base, 12)), SLUG_MAX);
  const taken = new Set(['demo', 'demo-2']);
  assert.equal(firstFreeSlug('demo', (s) => taken.has(s)), 'demo-3');
});

test('slugProblem reports length before format', () => {
  assert.equal(slugProblem('Bad Slug'), 'invalid_format');
  assert.equal(slugProblem('-'.repeat(SLUG_MAX + 1)), 'too_long');
  assert.equal(slugProblem('ok-slug-1'), null);
});

test('emailProblem checks length first', () => {
  assert.equal(emailProblem('ana@example.com'), null);
  assert.equal(emailProblem('not-an-email'), 'invalid_format');
  assert.equal(emailProblem(`${'a'.repeat(250)}@x.io`), 'too_long');
});
