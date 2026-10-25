import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { describe as describeRepo, discover } from '../src/analysis/index.ts';
import { finishStatics, startStatics } from '../src/analysis/statics.ts';
import { contextMd, murmur } from './helpers.ts';
import { check, edge, found, piece, v2Copy, v2Fixture } from './v2-helpers.ts';

type CatalogJson = { pieces: { name: string; kind: string }[] };

function domain(className: string, imports: readonly string[], members: readonly string[]): string {
  return [
    "import { Handle, Piece } from 'murmur';",
    '',
    ...(imports.length === 0 ? [] : [...imports, '']),
    `export class ${className} extends Piece() {`,
    ...members,
    '}',
    '',
  ].join('\n');
}

function expectRule(
  files: Readonly<Record<string, string>>,
  rule: string,
  expected: { severity: string; status: number; file?: string; line?: number; message?: RegExp },
): void {
  using app = v2Copy(files);
  const result = check(app.root);
  const [hit] = found(result.json, rule);
  assert.equal(hit?.severity, expected.severity, JSON.stringify(result.json.findings));
  assert.equal(result.status, expected.status, JSON.stringify(result.json.findings));

  if (expected.file !== undefined) {
    assert.equal(hit?.file, expected.file);
  }

  if (expected.line !== undefined) {
    assert.equal(hit?.line, expected.line);
  }

  if (expected.message !== undefined) {
    assert.match(hit?.message ?? '', expected.message);
  }
}

const TENANT = [
  "import { Guard, Model } from 'murmur';",
  "import { z } from 'zod';",
  '',
  'export class Tenant extends Model({ tenantId: z.string() }) {}',
  '',
  'export class ResolveTenant extends Guard(Tenant) {}',
  '',
].join('\n');

const BILLING = [
  "import { Command } from 'murmur';",
  "import { z } from 'zod';",
  '',
  'export class Charge extends Command({ id: z.string() }, {}) {}',
  '',
].join('\n');

describe('murmur check: class-piece rules on the v2 fixture', () => {
  test('piece.ts without a piece class is piece-class-missing', () => {
    using app = v2Copy({ ...piece('nocls', 'export const x = 1\n') });
    const result = check(app.root);
    assert.equal(result.status, 1);
    assert.equal(found(result.json, 'piece-class-missing')[0]?.severity, 'error');
  });

  test('a second export next to the piece class is piece-exports-one-class', () => {
    const source = `${domain('Extra', [], [])}\nexport class Helper {}\n`;
    expectRule(piece('extra', source), 'piece-exports-one-class', {
      severity: 'error',
      status: 1,
      message: /exports Helper besides Extra/,
    });
  });

  test('two piece classes in one piece.ts is one-piece-per-folder', () => {
    const source = `${domain('First', [], [])}\nclass Second extends Piece() {}\n`;
    expectRule(piece('twice', source), 'one-piece-per-folder', {
      severity: 'error',
      status: 1,
      message: /declares First and Second/,
    });
  });

  test('@Handle on a Model is handler-unknown-contract', () => {
    const members = ['  @Handle(Stats)', '  async stats() {}'];
    const source = domain('Wrong', ["import { Stats } from '#contracts/stats'"], members);
    expectRule(piece('wrong', source), 'handler-unknown-contract', {
      severity: 'error',
      status: 1,
      file: 'pieces/wrong/piece.ts',
    });
  });

  test('a misspelt onStart is a lifecycle-hook-typo warning at the method line (exit 0)', () => {
    const source = domain('Hooky', [], ['  async onstart(): Promise<void> {}']).replace('Handle, ', '');
    expectRule(piece('hooky', source), 'lifecycle-hook-typo', {
      severity: 'warn',
      status: 0,
      line: 4,
      message: /Hooky\.onstart looks like the lifecycle hook onStart/,
    });
  });

  test('handling an internal contract from outside its group is internal-contract-scope', () => {
    const members = ['  @Handle(Charge)', '  async charge() {}'];
    const source = domain('Outsider', ["import { Charge } from '../billing/contracts.ts'"], members);
    expectRule(
      {
        'pieces/billing/contracts.ts': BILLING,
        'pieces/billing/context.md': contextMd('billing'),
        ...piece('outsider', source),
      },
      'internal-contract-scope',
      { severity: 'error', status: 1, message: /billing\.Charge is internal to pieces\/billing/ },
    );
  });

  test('a route guard no piece handles is guard-never-handled', () => {
    const imports = [
      "import { ResolveTenant } from '#contracts/tenants';",
      "import { GetStats } from '#contracts/stats';",
    ];
    const decorators = ["@Serve(web.get('/tenant/stats', { guards: [ResolveTenant] }), GetStats)"];
    const source = edge('Tenants', imports, [], decorators).replace(', { type WebRequest }', '');
    expectRule({ 'contracts/tenants.ts': TENANT, ...piece('api/tenants', source) }, 'guard-never-handled', {
      severity: 'error',
      status: 1,
      message: /tenants\.ResolveTenant .* has no responder/,
    });
  });

  test('a shorthand whose contract lacks :id is binding-param-not-in-input', () => {
    const imports = ["import { GetStats } from '#contracts/stats'"];
    const decorators = ["@Serve(web.get('/stats/:id'), GetStats)"];
    const source = edge('ById', imports, [], decorators).replace(', { type WebRequest }', '');
    expectRule(piece('api/by-id', source), 'binding-param-not-in-input', {
      severity: 'error',
      status: 1,
      message: /:id is not a field of GetStats input/,
    });
  });

  test('@Serve on a token whose import resolves to no file is serve-unresolved, and the piece stays an edge', () => {
    const imports = ["import { GetStats } from '#contracts/stats'"];
    const decorators = ["@Serve(web.get('/lost'), GetStats)"];
    const source = edge('Lost', imports, [], decorators).replace(
      "import web, { type WebRequest } from '#capabilities/web';",
      "import web from '#capabilities/nope';",
    );
    using app = v2Copy(piece('api/lost', source));
    const result = check(app.root);
    const [hit] = found(result.json, 'serve-unresolved');
    assert.equal(result.status, 1, JSON.stringify(result.json.findings));
    assert.equal(hit?.severity, 'error');
    assert.equal(hit?.file, 'pieces/api/lost/piece.ts');
    assert.equal(hit?.line, 6);
    assert.match(hit?.message ?? '', /web comes from '#capabilities\/nope', which resolves to no file/);
    const catalog = murmur(['catalog', '--json', '--cwd', app.root]).json<CatalogJson>();
    assert.equal(catalog.pieces.find((p) => p.name === 'api/lost')?.kind, 'edge');
  });

  test('@Serve through a local alias of the token is serve-unresolved (check cannot see the route)', () => {
    const imports = ["import { GetStats } from '#contracts/stats'", '', 'const api = web'];
    const decorators = ["@Serve(api.get('/todos/:slug'), GetStats)"];
    const source = edge('Aliased', imports, [], decorators).replace(', { type WebRequest }', '');
    expectRule(piece('api/aliased', source), 'serve-unresolved', {
      severity: 'error',
      status: 1,
      message: /api is not imported; import the http token from '#capabilities\/<name>'/,
    });
  });

  test('a contract class declared in piece.ts has no wire name: wire-name error at the handler', () => {
    const members = ['  @Handle(Ping)', '  async ping() {', '    return {}', '  }'];
    const source = domain('Pinger', [], members)
      .replace("import { Handle, Piece } from 'murmur'", "import { Handle, Piece, Query } from 'murmur'")
      .replace('export class Pinger', 'class Ping extends Query({}, {}) {}\n\nexport class Pinger');
    expectRule(piece('pinger', source), 'wire-name', {
      severity: 'error',
      status: 1,
      file: 'pieces/pinger/piece.ts',
      message: /cannot derive a wire name for Ping/,
    });
  });

  test('a runtime wire name that differs from the static one is wire-name-mismatch', async () => {
    const repo = discover(v2Fixture);
    const start = startStatics(repo);
    const described = await describeRepo(repo, { skipPieces: start.classes.ids });
    const contracts = described.contracts.map((c) =>
      c.className === 'GetStats' ? { ...c, runtimeName: 'elsewhere.GetStats' } : c,
    );
    const { statics } = finishStatics(repo, start, { ...described, contracts });
    const mismatch = statics.findings.find((f) => f.rule === 'wire-name-mismatch');
    assert.equal(mismatch?.severity, 'error');
    assert.match(
      mismatch?.message ?? '',
      /runtime names it elsewhere\.GetStats, the static analysis stats\.GetStats/,
    );
  });
});
