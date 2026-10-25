import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { murmur, repoRoot } from './helpers.ts';
import { v2Copy } from './v2-helpers.ts';

type Lane = { values: string[]; source: string };
type CtxJson = { regeneration: { reason: string; lanes: Record<string, Lane> } | null };
type CatalogJson = { contracts: { name: string; kind?: string }[]; errors: unknown[] };

const NOTES = [
  "import { Model, Query } from 'murmur';",
  "import { z } from 'zod';",
  '',
  'export class Note extends Model({ id: z.string(), text: z.string() }) {}',
  '',
  'export class GetNote extends Query({ id: z.string() }, Note.nullable()) {}',
  '',
].join('\n');

const NOTE_WRITES = [
  "import { Command, Event, Model, Query } from 'murmur';",
  "import { z } from 'zod';",
  '',
  'export class Note extends Model({ id: z.string(), text: z.string() }) {}',
  '',
  'export class GetNote extends Query({ id: z.string() }, Note.nullable()) {}',
  '',
  'export class SaveNote extends Command({ id: z.string(), text: z.string() }, Note) {}',
  '',
  'export class NoteSaved extends Event({ id: z.string() }) {}',
  '',
].join('\n');

function methodBody(source: string, method: string): string {
  const start = source.indexOf(`async ${method}(`);

  return source.slice(start, source.indexOf('\n  }', start));
}

const X_MODEL = [
  "import { Model } from 'murmur';",
  "import { z } from 'zod';",
  '',
  'export class X extends Model({ id: z.string(), label: z.string() }) {}',
  '',
].join('\n');

function tool(root: string, bin: string, args: readonly string[]): void {
  const result = spawnSync(join(repoRoot, 'node_modules/.bin', bin), args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${bin}: ${result.stdout}${result.stderr}`);
}

function lint(root: string): void {
  tool(root, 'oxlint', []);
  tool(root, 'oxfmt', ['--check']);
}

function create(root: string, args: readonly string[]): void {
  const result = murmur(['new', ...args, '--cwd', root]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

describe('murmur new (v2 templates)', () => {
  test('new piece a/b --handles X --needs db=sqlite passes check, test and lint; the stub has no delivery', () => {
    using app = v2Copy({ 'contracts/notes.ts': NOTES });
    create(app.root, ['piece', 'a/b', '--handles', 'GetNote', '--needs', 'db=sqlite']);
    const source = readFileSync(join(app.root, 'pieces/a/b/piece.ts'), 'utf8');
    assert.match(source, /export class B extends Piece\(\{\n {2}needs: \{ db: sqlite \},\n\}\)/);
    assert.match(source, /@Handle\(GetNote\)\n {2}async getNote\(input: GetNote\): Promise<Note \| null> \{/);
    assert.doesNotMatch(source, /delivery|Delivery|log\./);
    assert.equal(readFileSync(join(app.root, 'pieces/a/b/schema.sql'), 'utf8'), '');
    assert.match(
      readFileSync(join(app.root, 'pieces/a/b/piece.test.ts'), 'utf8'),
      /await using t = await testPiece\(B\);/,
    );
    const checked = murmur(['check', '--json', '--cwd', app.root]);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.equal(checked.json<{ ok: boolean }>().ok, true);
    const tested = murmur(['test', 'a/b', '--json', '--cwd', app.root]);
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    const summary = tested.json<{ passed: number; failed: number }>();
    assert.deepEqual([summary.passed, summary.failed], [1, 0]);
    lint(app.root);
    tool(app.root, 'tsc', ['-p', 'tsconfig.json']);
  });

  test("new piece api/x --edge --serve 'get /x/:id' scaffolds a compiling edge with req: WebRequest", () => {
    using app = v2Copy();
    create(app.root, ['piece', 'api/x', '--edge', '--serve', 'get /x/:id']);
    const source = readFileSync(join(app.root, 'pieces/api/x/piece.ts'), 'utf8');
    assert.match(source, /import web, \{ type WebRequest \} from '#capabilities\/web'/);
    assert.match(
      source,
      /@Serve\(web\.get\('\/x\/:id'\)\)\n {2}async getX\(req: WebRequest\): Promise<HttpResult> \{/,
    );
    assert.match(
      readFileSync(join(app.root, 'pieces/api/x/piece.test.ts'), 'utf8'),
      /t\.fetch\(new Request\('http:\/\/app\/x\/1'\)\)/,
    );
    tool(app.root, 'tsc', ['-p', 'tsconfig.json']);
    lint(app.root);
    const tested = murmur(['test', 'api/x', '--cwd', app.root]);
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    assert.equal(murmur(['check', '--cwd', app.root]).status, 0);
  });

  test("--serve 'get /x/:id=GetNote' writes the class-level shorthand and its test answers through t.respond", () => {
    using app = v2Copy({ 'contracts/notes.ts': NOTES });
    create(app.root, ['piece', 'api/notes', '--serve', 'get /notes/:id=GetNote']);
    const source = readFileSync(join(app.root, 'pieces/api/notes/piece.ts'), 'utf8');
    assert.match(
      source,
      /@Serve\(web\.get\('\/notes\/:id'\), GetNote\)\nexport class Notes extends Piece\(\) \{/,
    );
    assert.doesNotMatch(source, /WebRequest/);
    assert.match(
      readFileSync(join(app.root, 'pieces/api/notes/piece.test.ts'), 'utf8'),
      /t\.respond\(GetNote,/,
    );
    const tested = murmur(['test', 'api/notes', '--cwd', app.root]);
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    tool(app.root, 'tsc', ['-p', 'tsconfig.json']);
    lint(app.root);
  });

  test('--idempotent claims the delivery in commands and events only; queries stay plain', () => {
    using app = v2Copy({ 'contracts/notes.ts': NOTE_WRITES });
    const idempotent = ['--needs', 'db=sqlite', '--idempotent'];
    create(app.root, [
      'piece',
      'notes',
      '--handles',
      'SaveNote,GetNote',
      '--emits',
      'NoteSaved',
      ...idempotent,
    ]);
    create(app.root, ['piece', 'archive', '--handles', 'NoteSaved', ...idempotent]);
    const notes = readFileSync(join(app.root, 'pieces/notes/piece.ts'), 'utf8');
    const getNote = methodBody(notes, 'getNote');
    assert.match(getNote, /^async getNote\(_?input: GetNote\): Promise<Note \| null> \{/);
    assert.doesNotMatch(getNote, /delivery|INSERT/);
    assert.match(methodBody(notes, 'saveNote'), /delivery: Delivery[\s\S]*INSERT OR IGNORE INTO handled/);
    const archive = readFileSync(join(app.root, 'pieces/archive/piece.ts'), 'utf8');
    assert.match(methodBody(archive, 'onNoteSaved'), /if \(claim\.changes === 0\) \{\n {6}return;\n {4}\}$/);
    lint(app.root);
    tool(app.root, 'tsc', ['-p', 'tsconfig.json']);
    const tested = murmur(['test', '--json', '--cwd', app.root]);
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    assert.equal(murmur(['check', '--cwd', app.root]).status, 0);
  });

  test('new contract GetX --domain x --kind query --output X? appends a nullable-output class the catalog sees', () => {
    using app = v2Copy({ 'contracts/x.ts': X_MODEL });
    create(app.root, [
      'contract',
      'GetX',
      '--domain',
      'x',
      '--kind',
      'query',
      '--input',
      'id:string',
      '--output',
      'X?',
    ]);
    const source = readFileSync(join(app.root, 'contracts/x.ts'), 'utf8');
    assert.match(source, /^import \{ Model, Query \} from 'murmur';$/m);
    assert.match(
      source,
      /\n\nexport class GetX extends Query\(\{ id: z\.string\(\) \}, X\.nullable\(\)\) \{\}\n$/,
    );
    const catalog = murmur(['catalog', '--json', '--cwd', app.root]);
    assert.equal(catalog.status, 0, catalog.stderr);
    const contract = catalog.json<CatalogJson>().contracts.find((c) => c.name === 'x.GetX');
    assert.equal(contract?.kind, 'query');
    lint(app.root);
  });

  test('a long contract declaration and a long handler head are written the way oxfmt formats them', () => {
    using app = v2Copy({ 'contracts/x.ts': X_MODEL });
    const fields =
      'customerReference:string,shippingAddressLine:string,billingAddressLine:string,quantity:number';
    create(app.root, [
      'contract',
      'RegisterLongShipment',
      '--domain',
      'x',
      '--kind',
      'command',
      '--input',
      fields,
    ]);
    create(app.root, [
      'piece',
      'x/register',
      '--handles',
      'RegisterLongShipment',
      '--idempotent',
      '--needs',
      'db=sqlite',
    ]);
    const contracts = readFileSync(join(app.root, 'contracts/x.ts'), 'utf8');
    assert.match(contracts, /extends Command\(\n {2}\{\n {4}customerReference: z\.string\(\),\n/);
    lint(app.root);
  });

  test('new contract refuses an --output model the file does not declare', () => {
    using app = v2Copy();
    const result = murmur([
      'new',
      'contract',
      'GetY',
      '--domain',
      'y',
      '--kind',
      'query',
      '--output',
      'Y?',
      '--cwd',
      app.root,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no Model class Y/);
  });

  test('new contract refuses an inline --output that is not key:type (exit 2)', () => {
    using app = v2Copy();
    const args = ['new', 'contract', 'GetY', '--domain', 'y', '--kind', 'query', '--output', 'nope'];
    const result = murmur([...args, '--cwd', app.root]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--output nope: give a Model/);
  });

  test('--withhold-code on an edge leaf lists serves from its tests', () => {
    using app = v2Copy();
    create(app.root, ['piece', 'api/x', '--edge', '--serve', 'get /x/:id']);
    rmSync(join(app.root, 'pieces/api/x/piece.ts'));
    writeFileSync(join(app.root, 'pieces/api/x/context.md'), '---\nsummary: Serves x.\n---\n\n# api/x\n');
    const result = murmur(['ctx', 'api/x', '--withhold-code', '--format', 'json', '--cwd', app.root]);
    assert.equal(result.status, 0, result.stderr);
    const lanes = result.json<CtxJson>().regeneration?.lanes;
    assert.deepEqual(lanes?.['serves'], { values: ['GET /x/1'], source: 'tests' });
  });
});
