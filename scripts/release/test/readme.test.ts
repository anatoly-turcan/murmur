import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { userReadme } from '../src/readme.ts';

const README = [
  '# murmur',
  '',
  '## Install',
  '',
  '```sh',
  '## not a heading',
  'pnpm install',
  '```',
  '',
  '## Releasing',
  '',
  'pnpm release:publish',
  '',
  '## Repository',
  '',
  '`packages/` holds the packages.',
  '',
  '## License',
  '',
  'MIT.',
  '',
].join('\n');

test('userReadme drops the Releasing and Repository sections and keeps every other section', () => {
  assert.equal(
    userReadme(README),
    [
      '# murmur',
      '',
      '## Install',
      '',
      '```sh',
      '## not a heading',
      'pnpm install',
      '```',
      '',
      '## License',
      '',
      'MIT.',
      '',
    ].join('\n'),
  );
});

test('a dropped section at the end leaves one trailing newline', () => {
  assert.equal(userReadme('# a\n\ntext\n\n## Repository\n\ninternal\n'), '# a\n\ntext\n');
});

test('the repo README, stripped, keeps install and license and carries no release or repository instructions', () => {
  const text = userReadme(readFileSync(join(import.meta.dirname, '../../../README.md'), 'utf8'));
  assert.match(text, /^## Install$/m);
  assert.match(text, /^## License$/m);
  assert.doesNotMatch(text, /^## (Releasing|Repository)$/m);
  assert.doesNotMatch(text, /release:(publish|snapshot|verify)|scripts\/release|pnpm example|pnpm build:ui/);
});
