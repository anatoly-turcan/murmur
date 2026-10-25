import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { contextMd, murmur, repoRoot } from './helpers.ts';
import { check, edge, found, piece, v2Copy, v2Fixture } from './v2-helpers.ts';

const SHOW_METHOD = [
  "  @Serve(web.get('/things/:id'))",
  '  async show(req: WebRequest): Promise<Response> {',
  '    const { params } = await req.read({ params: GetStats.input });',
  '',
  '    return Response.json(await this.request(GetStats, params));',
  '  }',
];

const IMPERSONATE = [
  '',
  'export class Session extends Model({ userId: z.string() }) {}',
  '',
  'export class Impersonate extends Guard(Session) {}',
  '',
].join('\n');

const PROBE_MEMBERS = [
  "  @Serve(web.get('/probe'))",
  '  async probe(_req: WebRequest): Promise<Response> {',
  "    console.log('probe');",
  '',
  "    return Response.json({ label: this.#label('a'), size: this.size() });",
  '  }',
  '',
  "  #label(kind: 'a' | 'b' | 'c'): string {",
  '    switch (kind) {',
  "      case 'a':",
  "        return 'A';",
  "      case 'b':",
  "        return 'B';",
  '    }',
  '',
  "    return '?';",
  '  }',
  '',
  '  private size() {',
  '    return 1;',
  '  }',
];

const PROBE_OVERRIDES = {
  '.oxlintrc.json': JSON.stringify({
    extends: ['./node_modules/@murmur/lint/preset.json'],
    rules: {
      'murmur/erasable-syntax-only': 'off',
      'murmur/declared-deps-only': 'off',
    },
    overrides: [
      { files: ['pieces/api/probe/**'], rules: { 'no-console': 'error' } },
      { files: ['pieces/api/probe/**'], rules: { 'murmur/method-return-type': 'off' } },
    ],
  }),
};

type OxlintJson = { diagnostics: { code: string; severity: string; labels: { span: { line: number } }[] }[] };

function oxlintErrors(root: string, path: string): string[] {
  const result = spawnSync(join(repoRoot, 'node_modules/.bin/oxlint'), ['-f', 'json', path], {
    cwd: root,
    encoding: 'utf8',
  });
  const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as OxlintJson;

  return report.diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => `${d.code.replace(/^([\w-]+)\((.+)\)$/, '$1/$2')}:${d.labels[0]?.span.line}`);
}

describe('murmur check on the v2 fixture', () => {
  test('the v2 fixture checks clean with exit 0', () => {
    const result = check(v2Fixture);
    assert.equal(result.status, 0, JSON.stringify(result.json.findings));
    assert.deepEqual(result.json.findings, []);
  });

  test('a second piece serving GET /todos is a binding-conflict error (exit 1)', () => {
    using app = v2Copy(
      piece(
        'api/dup',
        edge(
          'Dup',
          ["import { ListTodos } from '#contracts/todos'"],
          [],
          ["@Serve(web.get('/todos'), ListTodos)"],
        ).replace(', { type WebRequest }', ''),
      ),
    );
    const result = check(app.root);
    assert.equal(result.status, 1, result.stderr);
    const [conflict] = found(result.json, 'binding-conflict');
    assert.equal(conflict?.severity, 'error');
    assert.match(conflict?.message ?? '', /GET \/todos/);
    assert.match(conflict?.message ?? '', /api\/rest/);
    const scoped = check(app.root, ['pieces/api/dup']);
    assert.equal(scoped.status, 1, JSON.stringify(scoped.json.findings));
    assert.equal(found(scoped.json, 'binding-conflict').length, 1);
  });

  test('GET /todos/archived in another piece is route-shadowed by GET /todos/:id and splits the family', () => {
    const members = [
      "  @Serve(web.get('/todos/archived'))",
      '  async archived(req: WebRequest): Promise<Response> {',
      '    return Response.json({ path: req.path });',
      '  }',
    ];
    using app = v2Copy(piece('api/archive', edge('Archive', [], members)));
    const result = check(app.root);
    assert.equal(result.status, 1, result.stderr);
    const [shadow] = found(result.json, 'route-shadowed');
    assert.equal(shadow?.severity, 'error');
    assert.match(
      shadow?.message ?? '',
      /GET \/todos\/archived \(api\/archive\) sits under GET \/todos\/:id \(api\/rest\)/,
    );
    assert.equal(found(result.json, 'route-family-split')[0]?.severity, 'warn');
  });

  test('a family split alone is a route-family-split warning and check exits 0', () => {
    const members = [
      "  @Serve(web.get('/todos/:id/history/all'))",
      '  async history(req: WebRequest): Promise<Response> {',
      '    return Response.json({ path: req.path });',
      '  }',
    ];
    using app = v2Copy(piece('api/history', edge('History', [], members)));
    const result = check(app.root);
    assert.equal(result.status, 0, JSON.stringify(result.json.findings));
    const [split] = found(result.json, 'route-family-split');
    assert.equal(split?.severity, 'warn');
    assert.equal(split?.file, 'pieces/api/history/piece.ts');
    assert.equal(
      split?.message,
      'the /todos family is served by api/rest and api/history; one edge piece per family (move GET /todos/:id/history/all from api/history into api/rest)',
    );
    assert.ok(result.json.findings.every((f) => f.severity !== 'error'));
    assert.equal(found(check(app.root, ['pieces/api/history']).json, 'route-family-split').length, 1);
  });

  test('check runs the full lint preset and oxfmt: a missing type qualifier and an over-long line are findings', () => {
    const note = 'x'.repeat(100);
    const members = [
      "  @Serve(web.get('/loose'))",
      '  async loose(_req: WebRequest): Promise<Stats | null> {',
      `    return note('${note}');`,
      '  }',
    ];
    const helper = ['', 'function note(_text: string): null {', '  return null;', '}', ''];
    const source = `${edge('Loose', ["import { Stats } from '#contracts/stats';"], members)}${helper.join('\n')}`;
    using app = v2Copy(piece('api/loose', source));
    const result = check(app.root, ['pieces/api/loose']);
    const rules = result.json.findings.map((f) => [f.rule, f.file, f.line]);

    assert.equal(result.status, 1, JSON.stringify(result.json.findings));
    assert.deepEqual(rules, [
      ['typescript/consistent-type-imports', 'pieces/api/loose/piece.ts', 4],
      ['oxfmt/format', 'pieces/api/loose/piece.ts', 1],
    ]);

    const fixed = murmur(['check', '--fix', '--json', '--cwd', app.root, 'pieces/api/loose']);
    const source2 = readFileSync(join(app.root, 'pieces/api/loose/piece.ts'), 'utf8');

    assert.equal(fixed.status, 0, fixed.stdout);
    assert.match(
      source2,
      /import type \{ Stats \} from '#contracts\/stats';|import \{ type Stats \} from '#contracts\/stats';/,
    );
    assert.match(source2, /return note\(\n\s+'x+',?\n\s+\);/);
  });

  test("check applies the app's own overrides the way oxlint does, and runs the type-aware switch check", () => {
    using app = v2Copy({ ...PROBE_OVERRIDES, ...piece('api/probe', edge('Probe', [], PROBE_MEMBERS)) });
    const result = check(app.root, ['pieces/api/probe']);
    const reported = result.json.findings.map((f) => `${f.rule}:${f.line}`);

    assert.equal(result.status, 1, JSON.stringify(result.json.findings));
    assert.deepEqual(reported, ['eslint/no-console:8', 'typescript/switch-exhaustiveness-check:14']);
    assert.deepEqual(oxlintErrors(app.root, 'pieces/api/probe'), ['eslint/no-console:8']);
  });

  test('an oxfmt that cannot run is an oxfmt/run finding, never a silent pass', () => {
    using app = v2Copy({ '.oxfmtrc.json': '{ broken' });
    const result = check(app.root, ['pieces/stats']);

    assert.equal(result.status, 1);
    assert.match(
      found(result.json, 'oxfmt/run')[0]?.message ?? '',
      /oxfmt failed: Failed to load configuration/,
    );
  });

  test('a method whose req.read({ params: C.input }) contract lacks :id is binding-param-not-in-input', () => {
    using app = v2Copy(
      piece('api/things', edge('Things', ["import { GetStats } from '#contracts/stats'"], SHOW_METHOD)),
    );
    const result = check(app.root);
    assert.equal(result.status, 1, result.stderr);
    const [param] = found(result.json, 'binding-param-not-in-input');
    assert.equal(param?.severity, 'error');
    assert.equal(param?.file, 'pieces/api/things/piece.ts');
    assert.match(param?.message ?? '', /:id is not a field of GetStats input/);
  });

  test('a method whose inline req.read params key is not a path param is binding-param-not-in-input', () => {
    const method = [
      "  @Serve(web.get('/things/:thingId'))",
      '  async show(req: WebRequest): Promise<Response> {',
      '    const { params } = await req.read({ params: { id: z.string() } });',
      '',
      '    return Response.json(await this.request(GetStats, { id: params.id }));',
      '  }',
    ];
    const imports = ["import { GetStats } from '#contracts/stats'", "import { z } from 'zod'"];
    using app = v2Copy(piece('api/things', edge('Things', imports, method)));
    const result = check(app.root);
    assert.equal(result.status, 1, result.stderr);
    const messages = found(result.json, 'binding-param-not-in-input').map((f) => f.message);
    assert.deepEqual(messages, [
      'route GET /things/:thingId: req.read params key `id` is not a path param; use one of :thingId',
    ]);
  });

  test('a route guard whose output shares userId with Authenticate is guard-output-overlap', () => {
    const auth = readFileSync(join(v2Fixture, 'contracts/auth.ts'), 'utf8');
    const decorators = ["@Serve(web.get('/admin/stats', { guards: [Impersonate] }), GetStats)"];
    const imports = [
      "import { Impersonate } from '#contracts/auth';",
      "import { GetStats } from '#contracts/stats';",
    ];
    using app = v2Copy({
      'contracts/auth.ts': `${auth.trimEnd()}\n${IMPERSONATE}`,
      ...piece('api/admin', edge('Admin', imports, [], decorators).replace(', { type WebRequest }', '')),
    });
    const result = check(app.root);
    assert.equal(result.status, 1, result.stderr);
    const [overlap] = found(result.json, 'guard-output-overlap');
    assert.equal(overlap?.severity, 'error');
    assert.match(overlap?.message ?? '', /userId/);
  });

  test('a guard that runs before a guard it lists in after is guard-order, naming the reorder', () => {
    const auth = readFileSync(join(v2Fixture, 'contracts/auth.ts'), 'utf8');
    using app = v2Copy({
      'contracts/auth.ts': auth.replace('optional: [Authenticate]', 'after: [Authenticate]'),
      'capabilities/web/capability.ts': readFileSync(
        join(v2Fixture, 'capabilities/web/capability.ts'),
        'utf8',
      ).replace('guards: [Authenticate, RateLimit]', 'guards: [RateLimit, Authenticate]'),
    });
    const result = check(app.root);
    const order = found(result.json, 'guard-order');

    assert.equal(result.status, 1, result.stderr);
    assert.equal(order[0]?.severity, 'error');
    assert.ok(
      order.some(
        (f) =>
          f.message ===
          "route GET /todos: RateLimit runs before Authenticate, which RateLimit lists in `after`; reorder the token's guards, or make Authenticate `optional` on RateLimit",
      ),
      JSON.stringify(order),
    );
  });

  test('a route that skips a guard a kept guard lists in after is guard-order, naming both ways out', () => {
    const auth = readFileSync(join(v2Fixture, 'contracts/auth.ts'), 'utf8');
    using app = v2Copy({
      'contracts/auth.ts': auth.replace('optional: [Authenticate]', 'after: [Authenticate]'),
    });
    const result = check(app.root);
    const [order] = found(result.json, 'guard-order');

    assert.equal(result.status, 1, result.stderr);
    assert.equal(order?.file, 'pieces/api/rest/piece.ts');
    assert.equal(
      order?.message,
      "route GET /stats skips Authenticate but keeps RateLimit, whose `after` names Authenticate; skip RateLimit too, or declare Authenticate in RateLimit's `optional`",
    );
  });

  test('a route meta key no kept guard reads is guard-meta-unknown, listing the accepted keys', () => {
    const rest = readFileSync(join(v2Fixture, 'pieces/api/rest/piece.ts'), 'utf8');
    using app = v2Copy({
      'pieces/api/rest/piece.ts': rest.replace('meta: { cost: 2 }', 'meta: { cots: 2 }'),
    });
    const result = check(app.root);
    const [unknown] = found(result.json, 'guard-meta-unknown');

    assert.equal(result.status, 1, result.stderr);
    assert.equal(unknown?.severity, 'error');
    assert.equal(
      unknown?.message,
      'route POST /todos: meta key `cots` is read by no kept guard; the kept guards accept cost',
    );
  });

  test('a guard whose meta is not an inline object literal skips guard-meta-unknown', () => {
    const auth = readFileSync(join(v2Fixture, 'contracts/auth.ts'), 'utf8');
    const rest = readFileSync(join(v2Fixture, 'pieces/api/rest/piece.ts'), 'utf8');
    using app = v2Copy({
      'contracts/auth.ts': auth.replace('meta: { cost:', 'meta: { ...{}, cost:'),
      'pieces/api/rest/piece.ts': rest.replace('meta: { cost: 2 }', 'meta: { cost: 2, weight: 1 }'),
    });
    const result = check(app.root);

    assert.deepEqual(found(result.json, 'guard-meta-unknown'), []);
  });

  test('a serve method that requests a guard is guard-requested-directly, pointing at the route guards', () => {
    const members = [
      "  @Serve(web.get('/whoami'))",
      '  async whoami(req: WebRequest): Promise<Response> {',
      "    const peer = { transport: 'http', operation: 'x', headers: {}, params: {}, peer: req.peer, ip: req.ip };",
      '',
      '    return Response.json(await this.request(Authenticate, peer));',
      '  }',
    ];
    using app = v2Copy(
      piece('api/me', edge('Me', ["import { Authenticate } from '#contracts/auth';"], members)),
    );
    const result = check(app.root);
    const [direct] = found(result.json, 'guard-requested-directly');

    assert.equal(direct?.severity, 'warn');
    assert.equal(
      direct?.message,
      "`this.request(Authenticate)` in a serve method; admission belongs on the route: `web.get('/whoami', { guards: [Authenticate] })`",
    );
  });

  test("reading a neighbour's file is a folder-local-files warning", () => {
    const source = [
      "import { readFileSync } from 'node:fs';",
      '',
      "import { Piece } from 'murmur';",
      '',
      "const SCHEMA = readFileSync(new URL('../todos/schema.sql', import.meta.url), 'utf8')",
      '',
      'export class Peek extends Piece() {}',
      '',
    ].join('\n');
    using app = v2Copy({ 'pieces/peek/piece.ts': source, 'pieces/peek/context.md': contextMd('peek') });
    const result = check(app.root);
    const [local] = found(result.json, 'folder-local-files');
    assert.equal(local?.severity, 'warn');
    assert.equal(local?.file, 'pieces/peek/piece.ts');
    assert.match(local?.message ?? '', /pieces\/todos\/schema\.sql/);
  });

  test("a write to a table another piece's schema.sql created is table-foreign-write; reads and own writes are not", () => {
    const stats = readFileSync(join(v2Fixture, 'pieces/stats/piece.ts'), 'utf8')
      .replace('INSERT OR IGNORE INTO stats_todos (id, done)', 'INSERT OR IGNORE INTO todos (id, done)')
      .replace('AS done FROM stats_todos', 'AS done FROM todos')
      .replace(
        "await this.db.run('DELETE FROM stats_todos WHERE id = ?', event.id);",
        "await this.db.insert('todo_requests', { envelope_id: event.id, todo_id: event.id });",
      );
    using app = v2Copy({ 'pieces/stats/piece.ts': stats });
    const result = check(app.root);
    const writes = found(result.json, 'table-foreign-write');

    assert.deepEqual(
      writes.map((w) => [w.severity, w.file, w.message]),
      [
        [
          'warn',
          'pieces/stats/piece.ts',
          'pieces/stats writes `todos`, created by pieces/todos/schema.sql; move the write to its owner or make it a job that owner handles',
        ],
        [
          'warn',
          'pieces/stats/piece.ts',
          'pieces/stats writes `todo_requests`, created by pieces/todos/schema.sql; move the write to its owner or make it a job that owner handles',
        ],
      ],
    );
    assert.equal(writes[0]?.line, 15);
  });

  test('a table two schema.sql files create is written freely by either; a third writer hears both', () => {
    const stats = readFileSync(join(v2Fixture, 'pieces/stats/piece.ts'), 'utf8').replace(
      'INSERT OR IGNORE INTO stats_todos (id, done)',
      'INSERT OR IGNORE INTO todos (id, done)',
    );
    const shared = 'CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, done INTEGER NOT NULL);\n';
    const writer = [
      "import { Handle, Piece } from 'murmur';",
      "import { sqlite } from '@murmur/node/capabilities';",
      '',
      "import { TodoCreated } from '#contracts/todos';",
      '',
      'export class Mirror extends Piece({ needs: { db: sqlite } }) {',
      '  @Handle(TodoCreated)',
      '  async mirror(event: TodoCreated): Promise<void> {',
      "    await this.db.run('UPDATE todos SET done = 0 WHERE id = ?', event.id);",
      '  }',
      '}',
      '',
    ].join('\n');
    using app = v2Copy({
      'pieces/stats/piece.ts': stats,
      'pieces/stats/schema.sql': `${readFileSync(join(v2Fixture, 'pieces/stats/schema.sql'), 'utf8')}${shared}`,
      'pieces/mirror/piece.ts': writer,
      'pieces/mirror/context.md': contextMd('mirror'),
    });
    const writes = found(check(app.root).json, 'table-foreign-write');

    assert.deepEqual(
      writes.map((w) => [w.file, w.message]),
      [
        [
          'pieces/mirror/piece.ts',
          'pieces/mirror writes `todos`, created by pieces/stats/schema.sql and pieces/todos/schema.sql; move the write to its owner or make it a job that owner handles',
        ],
      ],
    );
  });

  test('the v2 fixture writes only its own tables: no table-foreign-write', () => {
    assert.deepEqual(found(check(v2Fixture).json, 'table-foreign-write'), []);
  });

  test('two contracts with one wire name: check reports contract-identity (exit 1), catalog cannot describe (exit 4)', () => {
    const todos = readFileSync(join(v2Fixture, 'contracts/todos.ts'), 'utf8');
    const twin =
      "\nexport class FetchTodo extends Query({ id: z.string() }, Todo.nullable(), { name: 'todos.GetTodo' }) {}\n";
    using app = v2Copy({ 'contracts/todos.ts': `${todos.trimEnd()}\n${twin}` });
    const result = check(app.root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(found(result.json, 'contract-identity')[0]?.message ?? '', /todos\.GetTodo/);
    assert.equal(murmur(['catalog', '--json', '--cwd', app.root]).status, 4);
  });

  test('an app whose contracts kill the describe worker cannot be described: exit 4', () => {
    using app = v2Copy({ 'contracts/boom.ts': 'process.exit(7)\n' });
    const result = murmur(['check', '--cwd', app.root]);
    assert.equal(result.status, 4, result.stdout + result.stderr);
    assert.match(result.stderr, /cannot be described/);
  });
});
