import assert from 'node:assert/strict';
import { describe as suite, test } from 'node:test';

import { contextLanes } from '../src/analysis/context-lanes.ts';
import { exampleRowIn, sqlStatements, sqlStringsIn, statementsFor } from '../src/analysis/storage-sql.ts';
import { tablesNamedIn } from '../src/analysis/storage-tables.ts';
import { contextMd, fixtureApp, makeApp, murmur, TODO_CONTRACTS } from './helpers.ts';

type CtxJson = { sections: { id: string; text: string }[]; sizing: string };

const PIECE = [
  "import { sqlite } from '@murmur/node/capabilities';",
  "import { Handle, Piece } from 'murmur';",
  '',
  "import { TodoCreated } from '#contracts/todos';",
  '',
  'export class Notes extends Piece({ needs: { db: sqlite } }) {',
  '  @Handle(TodoCreated)',
  '  async created(_event: TodoCreated): Promise<void> {}',
  '}',
  '',
].join('\n');

function storageOf(root: string, id: string): string {
  const result = murmur(['ctx', id, '--format', 'json', '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);

  return result.json<CtxJson>().sections.find((s) => s.id === 'storage')?.text ?? '';
}

function pieceApp(files: Readonly<Record<string, string>>, needs = 'Needs: sqlite (table notes)') {
  return makeApp({
    'contracts/todos.ts': TODO_CONTRACTS,
    'pieces/notes/context.md': `${contextMd('notes')}\n${needs}\n`,
    'pieces/notes/piece.ts': PIECE,
    ...files,
  });
}

suite('tablesNamedIn (context.md Needs grammar)', () => {
  test('reads the one-line form and the ## Needs section form', () => {
    assert.deepEqual(tablesNamedIn('# x\n\nNeeds: sqlite (table todos)\n'), ['todos']);
    assert.deepEqual(tablesNamedIn('# x\n\n## Needs\n\n`sqlite` (table `todos`).\n\n## Invariants\n'), [
      'todos',
    ]);
    assert.deepEqual(tablesNamedIn('- **Needs:** `sqlite` (reads `todos`)'), ['todos']);
  });

  test('lists several tables and verbs, deduplicated, in order', () => {
    assert.deepEqual(tablesNamedIn('Needs: sqlite (tables `a`, `b` and c), kv (writes d; reads a)'), [
      'a',
      'b',
      'c',
      'd',
    ]);
    assert.deepEqual(tablesNamedIn('Needs: sqlite (owns table orders)'), ['orders']);
  });

  test('ignores parentheses without a table verb and text outside Needs', () => {
    assert.deepEqual(tablesNamedIn('Needs: fetch (default timeout)\n\nUses the table people elsewhere.'), []);
    assert.deepEqual(tablesNamedIn('## Config\n\n`failKinds` (table `x`)\n'), []);
  });

  test('a table list ends at the first item that is not a single name', () => {
    assert.deepEqual(
      tablesNamedIn('Needs: `sqlite` (tables `todos` and `todo_requests`, both in `schema.sql`).'),
      ['todos', 'todo_requests'],
    );
  });

  test('one grammar feeds the needs lane and the table names, outside code fences', () => {
    const md =
      '## Needs\n\n- `sqlite` (table `todos`)\n\n```\nNeeds: kv (table ghost)\n```\n\nEmits: todos.created\n';
    assert.deepEqual(contextLanes(md), { needs: ['sqlite'], emits: ['todos.created'] });
    assert.deepEqual(tablesNamedIn(md), ['todos']);
  });
});

suite('storage sql helpers', () => {
  test('sqlStatements splits on top-level semicolons only', () => {
    const sql = "CREATE TABLE a (x TEXT DEFAULT ';');\n-- c; d\nCREATE TABLE b (y INTEGER) ;";
    assert.deepEqual(sqlStatements(sql), [
      "CREATE TABLE a (x TEXT DEFAULT ';')",
      '-- c; d\nCREATE TABLE b (y INTEGER)',
    ]);
  });

  test('statementsFor keeps CREATE TABLE, ALTER TABLE and CREATE INDEX of one table', () => {
    const statements = sqlStatements(
      [
        'CREATE TABLE IF NOT EXISTS "todos" (id TEXT)',
        'CREATE TABLE todos_archive (id TEXT)',
        'CREATE UNIQUE INDEX IF NOT EXISTS t_id ON todos (id)',
        'ALTER TABLE todos ADD COLUMN due TEXT',
        'INSERT INTO todos VALUES (1)',
      ].join(';\n'),
    );
    assert.deepEqual(statementsFor(statements, 'todos'), [
      'CREATE TABLE IF NOT EXISTS "todos" (id TEXT)',
      'CREATE UNIQUE INDEX IF NOT EXISTS t_id ON todos (id)',
      'ALTER TABLE todos ADD COLUMN due TEXT',
    ]);
  });

  test('sqlStringsIn reads string literals, skipping comments and interpolated templates', () => {
    const source = [
      "// don't",
      "const A = 'CREATE TABLE a (x TEXT)'",
      `await run("INSERT INTO a VALUES ('q', 1)")`,
      'const B = `CREATE TABLE ${name} (x)`',
    ].join('\n');
    assert.deepEqual(sqlStringsIn(source), ['CREATE TABLE a (x TEXT)', "INSERT INTO a VALUES ('q', 1)"]);
  });

  test('exampleRowIn wants literal values, not placeholders', () => {
    assert.equal(
      exampleRowIn(['INSERT INTO a VALUES (?, ?)', "INSERT OR IGNORE INTO a VALUES ('k', 0)"], 'a'),
      "INSERT OR IGNORE INTO a VALUES ('k', 0)",
    );
    assert.equal(exampleRowIn(["INSERT INTO ab VALUES ('k')"], 'a'), null);
  });
});

suite('murmur ctx ## Storage', () => {
  test('inlines the DDL from the sqlite migrations dir for a table named by an ancestor context.md', () => {
    const text = storageOf(fixtureApp, 'todos/create');
    assert.match(text, /^## Storage$/m);
    assert.match(text, /^### todos$/m);
    assert.match(text, /from `migrations\/001_todos\.sql` \(sqlite migrations dir `migrations`\)/);
    assert.match(text, /CREATE TABLE todos \(\n {2}id TEXT PRIMARY KEY,[\s\S]*created_at TEXT NOT NULL\n\);/);
    assert.match(text, /created_at holds Temporal\.Instant\.toString\(\)/);
    assert.match(text, /CREATE INDEX todos_done ON todos \(done\);/);
    assert.doesNotMatch(text, /audit_log/);
    const md = murmur(['ctx', 'todos/create', '--cwd', fixtureApp]).stdout;
    assert.ok(md.indexOf('## Storage') > md.indexOf('## Capabilities'));
    assert.ok(md.indexOf('## Storage') < md.indexOf('## Config'));
  });

  test('a table outside migrations/*.sql comes from the *.sql scan and shows an example row from a test', () => {
    using app = pieceApp({
      'db/schema.sql': 'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);\n',
      'pieces/notes/piece.test.ts': `const SEED = "INSERT INTO notes VALUES ('n1', 'hello')"\n`,
    });
    const text = storageOf(app.root, 'notes');
    assert.match(text, /from `db\/schema\.sql` \(\*\.sql scan\)/);
    assert.match(text, /CREATE TABLE notes \(id TEXT PRIMARY KEY, body TEXT NOT NULL\);/);
    assert.match(
      text,
      /example row \(`pieces\/notes\/piece\.test\.ts`\): `INSERT INTO notes VALUES \('n1', 'hello'\)`/,
    );
  });

  test('falls back to a CREATE TABLE string in the piece tests, and names the source', () => {
    using app = pieceApp(
      {
        'pieces/notes/piece.test.ts': "const NOTES = 'CREATE TABLE notes (id TEXT PRIMARY KEY)'\n",
      },
      '## Needs\n\n`sqlite` (table `notes`).',
    );
    const text = storageOf(app.root, 'notes');
    assert.match(text, /from `pieces\/notes\/piece\.test\.ts` \(CREATE TABLE string in a test\)/);
    assert.match(text, /CREATE TABLE notes \(id TEXT PRIMARY KEY\);/);
    const md = murmur(['ctx', 'notes', '--cwd', app.root]).stdout;
    assert.doesNotMatch(md, /^## Tests$/m, 'the DDL comes from the tests even when they are not printed');
  });

  test('a named table with no DDL anywhere says where it looked', () => {
    using app = pieceApp({});
    assert.match(
      storageOf(app.root, 'notes'),
      /### notes\n\nno DDL found \(looked in: sqlite migrations dir `migrations`, \*\.sql files, CREATE TABLE strings in the piece tests\)/,
    );
  });

  test('a piece whose context names no table gets no Storage section', () => {
    using app = pieceApp({}, '');
    const result = murmur(['ctx', 'notes', '--format', 'json', '--cwd', app.root]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.json<CtxJson>().sections.find((s) => s.id === 'storage'),
      undefined,
    );
  });
});
