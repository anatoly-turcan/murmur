import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { murmur } from './helpers.ts';
import { check, found, piece, v2Copy, v2Fixture } from './v2-helpers.ts';

type Section = { id: string; text: string };
type CtxJson = { kind: string; sections: Section[]; tokens: number };

function sections(root: string, id: string): (sectionId: string) => string {
  const result = murmur(['ctx', id, '--format', 'json', '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);
  const all = result.json<CtxJson>().sections;

  return (sectionId) => all.find((s) => s.id === sectionId)?.text ?? '';
}

const ITEMS = [
  "import { Model, Page, Paging, Query } from 'murmur';",
  "import { z } from 'zod';",
  '',
  'export class Item extends Model({ id: z.string() }) {}',
  '',
  'export class ListItems extends Query(',
  '  { tag: z.string().optional(), ...Paging({ max: 50 }) },',
  "  Page(Item, { cursorField: 'nextCursor' }),",
  ') {}',
  '',
].join('\n');

const ITEMS_PIECE = [
  "import { Handle, Piece } from 'murmur';",
  '',
  "import { type Item, ListItems } from '#contracts/items';",
  '',
  'export class Items extends Piece() {',
  '  @Handle(ListItems)',
  '  async list(input: ListItems): Promise<{ data: Item[]; nextCursor: string | null }> {',
  '    return { data: [], nextCursor: input.cursor };',
  '  }',
  '}',
  '',
].join('\n');

describe('lib lane: ctx, Lib section, Paging/Page in the Contracts sheet, lib-pure, new lib', () => {
  test('murmur ctx lib/etag prints the exported signatures and the tests', () => {
    const result = murmur(['ctx', 'lib/etag', '--cwd', v2Fixture]);
    assert.equal(result.status, 0, result.stderr);

    assert.match(result.stdout, /^# Lib: lib\/etag$/m);
    assert.match(result.stdout, /^- import: `import \{ etagOf \} from '#lib\/etag';`$/m);
    assert.match(result.stdout, /^export function etagOf\(todo: Todo\): string \{ \/\* …body elided/m);
    assert.doesNotMatch(result.stdout, /createHash\('sha1'\)/);
    assert.match(result.stdout, /^### lib\/etag\.test\.ts$/m);
    assert.match(result.stdout, /^test\('etagOf is a quoted 16-hex digest/m);
    assert.match(result.stdout, /^- imported by: `api\/rest`$/m);
  });

  test('murmur ctx lib/<module> --format json is one ctx object; an unknown module names the known ones', () => {
    const json = murmur(['ctx', 'lib/etag', '--format', 'json', '--cwd', v2Fixture]).json<CtxJson>();
    const missing = murmur(['ctx', 'lib/nope', '--cwd', v2Fixture]);

    assert.equal(json.kind, 'ctx');
    assert.deepEqual(
      json.sections.map((s) => s.id),
      ['header', 'signatures', 'tests'],
    );
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no lib module "lib\/nope"/);
    assert.match(missing.stderr, /lib modules: lib\/etag/);
  });

  test('a piece brief lists the signatures of the lib modules it imports, and only then', () => {
    const rest = sections(v2Fixture, 'api/rest');
    const todos = sections(v2Fixture, 'todos');

    assert.match(rest('lib'), /^## Lib$/m);
    assert.match(rest('lib'), /^### lib\/etag\.ts → `#lib\/etag`$/m);
    assert.match(rest('lib'), /^export function etagOf\(todo: Todo\): string \{ \/\* …body elided/m);
    assert.match(rest('header'), /^import \{ etagOf \} from '#lib\/etag';$/m);
    assert.equal(todos('lib'), '');
    assert.doesNotMatch(todos('header'), /#lib\//);
  });

  test('Paging({ max: 50 }) and Page(Item, { cursorField }) appear in the Contracts sheet', () => {
    using app = v2Copy({ 'contracts/items.ts': ITEMS, ...piece('items', ITEMS_PIECE) });
    const contracts = sections(app.root, 'items')('contracts');

    assert.match(contracts, /\.\.\.Paging\(\{ max: 50 \}\)/);
    assert.match(contracts, /Page\(Item, \{ cursorField: 'nextCursor' \}\)/);
  });

  test('murmur check reports lib-pure on a lib module that does I/O, naming the capability lane', () => {
    using app = v2Copy({
      'lib/mail.ts':
        "import { readFileSync } from 'node:fs';\n\nexport const template = readFileSync('x', 'utf8');\n",
    });
    const result = check(app.root);
    const [hit] = found(result.json, 'murmur/lib-pure');

    assert.equal(result.status, 1, JSON.stringify(result.json.findings));
    assert.equal(hit?.file, 'lib/mail.ts');
    assert.match(
      hit?.message ?? '',
      /^lib\/mail\.ts imports `node:fs`; lib modules are pure\. Move the I\/O to a capability/,
    );
  });

  test('murmur new lib text writes a module and its test that check and test green', () => {
    using app = v2Copy();
    const created = murmur(['new', 'lib', 'text', '--cwd', app.root]);
    const again = murmur(['new', 'lib', 'text', '--cwd', app.root]);
    const bad = murmur(['new', 'lib', 'Text', '--cwd', app.root]);

    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /^created lib\/text\.ts$/m);
    assert.match(created.stdout, /^created lib\/text\.test\.ts$/m);
    assert.match(created.stdout, /^next: pnpm exec murmur ctx lib\/text$/m);
    assert.match(readFileSync(join(app.root, 'lib/text.test.ts'), 'utf8'), /from '#lib\/text';/);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /lib\/text\.ts exists/);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /lower-case words separated by - or \/, like money\/round/);
    assert.equal(check(app.root).status, 0, JSON.stringify(check(app.root).json.findings));
    assert.equal(
      murmur(['test', 'lib/text.test.ts', '--json', '--cwd', app.root]).json<{ passed: number }>().passed,
      1,
    );
  });

  test('rule 12 and the defaults pointer to the lib helpers are in every brief', () => {
    const todos = sections(v2Fixture, 'todos');

    assert.match(
      todos('rules'),
      /^12\. Shared pure code lives in `lib\/` and is imported as `#lib\/x`; a capability is I\/O or state, never a helper bag\.$/m,
    );
    assert.match(
      todos('capabilities'),
      /`cursor\.encode\(binding, position\)`.*`bearer`.*`canonicalJson`.*`sha256`/,
    );
  });

  test('new app writes the #lib/* alias and type-checks lib/', () => {
    using app = v2Copy();
    const target = join(app.root, 'fresh');
    const result = murmur(['new', 'app', target]);
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as {
      imports: Record<string, string>;
    };
    const tsconfig = JSON.parse(readFileSync(join(target, 'tsconfig.json'), 'utf8')) as { include: string[] };

    assert.equal(result.status, 0, result.stderr);
    assert.equal(pkg.imports['#lib/*'], './lib/*.ts');
    assert.ok(tsconfig.include.includes('lib'));
    assert.equal(existsSync(join(target, 'lib')), false);
  });
});
