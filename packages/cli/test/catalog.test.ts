import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { contextMd, fixtureApp, makeApp, murmur, TODO_CONTRACTS } from './helpers.ts';

type Catalog = {
  kind: string;
  warnings: { code: string; subject: string }[];
  errors: { code: string }[];
};

const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'catalog.golden.json'), 'utf8'),
) as unknown;

describe('murmur catalog', () => {
  test('--json on the fixture app equals the golden file (tree, visibility, summaries)', () => {
    const result = murmur(['catalog', '--json', '--cwd', fixtureApp]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json(), golden);
  });

  test('--strict exits 0 on the clean fixture app', () => {
    assert.equal(murmur(['catalog', '--strict', '--cwd', fixtureApp]).status, 0);
  });

  test('--strict exits 1 on a subscribed-never-emitted contract', () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'pieces/audit/context.md': contextMd('audit'),
      'pieces/audit/piece.test.ts': '',
      'pieces/audit/piece.ts': [
        "import { Handle, Piece } from 'murmur'",
        '',
        "import { TodoCreated } from '#contracts/todos'",
        '',
        'export class Audit extends Piece() {',
        '  @Handle(TodoCreated)',
        '  async seen(event: TodoCreated): Promise<void> {',
        "    this.log.info('seen', { id: event.id })",
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    const result = murmur(['catalog', '--strict', '--json', '--cwd', app.root]);
    assert.equal(result.status, 1);
    const catalog = result.json<Catalog>();
    assert.deepEqual(
      catalog.warnings.filter((w) => w.code !== 'orphan-contract').map((w) => [w.code, w.subject]),
      [['subscribed-never-emitted', 'todos.created']],
    );
    assert.equal(murmur(['catalog', '--cwd', app.root]).status, 0);
  });

  test('--strict warns on orphan contracts: declared, never emitted or handled, not an ingress route', () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'capabilities/door/capability.ts': [
        "import { defineCapability } from 'murmur'",
        '',
        "import { TodoCountRequested } from '#contracts/todos'",
        '',
        "export default defineCapability({ name: 'door', ingress: true, requests: [TodoCountRequested], start: () => ({}) })",
        '',
      ].join('\n'),
      'pieces/audit/context.md': contextMd('audit'),
      'pieces/audit/piece.test.ts': '',
      'pieces/audit/piece.ts': [
        "import { Handle, Piece } from 'murmur'",
        '',
        "import { TodoCountRequested, TodoCreated } from '#contracts/todos'",
        '',
        'export class Audit extends Piece({ emits: [TodoCreated] }) {',
        '  @Handle(TodoCountRequested)',
        '  async count(): Promise<{ count: number }> {',
        '    return { count: 0 }',
        '  }',
        '',
        '  @Handle(TodoCreated)',
        '  async seen(event: TodoCreated): Promise<void> {',
        "    this.log.info('seen', { id: event.id })",
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    const plain = murmur(['catalog', '--json', '--cwd', app.root]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.deepEqual(plain.json<Catalog>().warnings, []);
    const strict = murmur(['catalog', '--strict', '--json', '--cwd', app.root]);
    assert.equal(strict.status, 1);
    assert.deepEqual(
      strict.json<Catalog>().warnings.map((w) => [w.code, w.subject]),
      [['orphan-contract', 'todos.audited']],
    );
    const table = murmur(['catalog', '--strict', '--cwd', app.root]);
    assert.match(table.stdout, /todos\.audited .*⚠ orphan-contract/);
    assert.match(table.stdout, /door\s+ingress\s+\(routes: 1\)/);
  });

  test('--format mermaid prints a flowchart with group subgraphs; --group filters to a subtree', () => {
    const mermaid = murmur(['catalog', '--format', 'mermaid', '--cwd', fixtureApp]);
    assert.equal(mermaid.status, 0);
    assert.match(mermaid.stdout, /^flowchart LR/);
    assert.match(mermaid.stdout, /subgraph n_g_todos\["todos\/"\]/);
    assert.match(mermaid.stdout, /-->\|todos.created\| n_audit/);
    const group = murmur(['catalog', '--json', '--group', 'audit', '--cwd', fixtureApp]).json<{
      pieces: { name: string }[];
    }>();
    assert.deepEqual(
      group.pieces.map((p) => p.name),
      ['audit', 'audit/archive'],
    );
  });
});
