import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe as suite, test } from 'node:test';

import { contextMd, fixtureApp, makeApp, murmur, repoRoot, TODO_CONTRACTS } from './helpers.ts';

type CtxJson = { sections: { id: string; text: string }[] };

function sectionsOf(root: string, id: string): (sectionId: string) => string {
  const result = murmur(['ctx', id, '--format', 'json', '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);
  const { sections } = result.json<CtxJson>();

  return (sectionId) => sections.find((s) => s.id === sectionId)?.text ?? '';
}

function rule(rules: string, n: number): string {
  const lines = rules.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  const end = lines.findIndex((l, i) => i > start && /^\d+\. /.test(l));

  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function docHeuristics(): string[] {
  const page = readFileSync(join(repoRoot, 'docs', 'piece-authoring.md'), 'utf8');

  return [...page.matchAll(/^\d\. (.+)$/gm)].map((m) => m[1] as string).slice(0, 5);
}

suite('ctx rules carry their answers', () => {
  const section = sectionsOf(fixtureApp, 'todos/create');
  const rules = section('rules');

  test('the rules block stays under 25 lines', () => {
    assert.ok(rules.split('\n').length < 25, `${rules.split('\n').length} lines`);
  });

  test('rule 6 gives the idempotency recipes keyed on delivery.envelope.id', () => {
    const six = rule(rules, 6);
    assert.match(six, /delivery\.envelope\.id/);
    assert.match(six, /this\.kv\.once\(delivery\.envelope\.id, effect\)/);
    assert.match(six, /INSERT OR IGNORE/);
  });

  test('rule 5 says what retries', () => {
    const five = rule(rules, 5);
    assert.match(five, /retried/);
    assert.match(five, /NonRetryableError/);
  });

  test('rule 11 inlines the five sizing heuristics from docs/piece-authoring.md and keeps the link', () => {
    const eleven = rule(rules, 11);
    assert.match(eleven, /^11\. .*heuristics in `[^`]+`/m);
    const heuristics = docHeuristics();
    assert.equal(heuristics.length, 5);

    for (const heuristic of heuristics) {
      assert.ok(eleven.includes(heuristic.replace(/;$|\.$/, '')), heuristic);
    }
  });

  test('rule 11 heuristic 2 names one writer per table and readers declaring it', () => {
    assert.match(rule(rules, 11), /2\. one writer of each table; readers declare the table in context\.md/);
    assert.doesNotMatch(rules, /one owner of each table/);
  });

  test('a piece that needs kv gets its full sheet', () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'pieces/dedupe/context.md': contextMd('dedupe'),
      'pieces/dedupe/piece.ts': [
        "import { Handle, Piece } from 'murmur';",
        "import { kv, sqlite } from '@murmur/node/capabilities';",
        '',
        "import { TodoCreated } from '#contracts/todos';",
        '',
        'export class Dedupe extends Piece({ needs: { db: sqlite, kv } }) {',
        '  @Handle(TodoCreated)',
        '  async created(_event: TodoCreated): Promise<void> {}',
        '}',
        '',
      ].join('\n'),
    });
    const capabilities = sectionsOf(app.root, 'dedupe')('capabilities');
    assert.match(capabilities, /^### kv \(kv\)$/m);
    assert.match(capabilities, /^### db \(sqlite\)$/m);
    assert.match(capabilities, /kv\.incr\('rate:ada', \{ windowMs: 60_000 \}\)/);
    assert.match(capabilities, /incr\(key: string, options: \{ windowMs: number \}\)/);
    assert.match(capabilities, /transaction<T>\(work: \(tx: Sqlite\) => Promise<T>\): Promise<T>;/);
    assert.match(sectionsOf(app.root, 'dedupe')('header'), /^- migrate: `pnpm exec murmur migrate` /m);
  });

  test('rule 8 names the callback transaction and that a nested call joins', () => {
    assert.match(rule(rules, 8), /`await this\.db\.transaction\(async \(tx\) => …\)`; a nested call joins/);
  });

  test('the defaults sheet says all framework time is the clock and how tests move it', () => {
    const capabilities = section('capabilities');
    assert.match(capabilities, /All framework time is this clock/);
    assert.match(capabilities, /`await this\.clock\.freeze\(instant\)`, `advance\(ms\)`, `clear\(\)`/);
    assert.match(capabilities, /`capabilities\.clock\.overridable: true`/);
  });

  test('a piece without sqlite gets no migrate line in its header', () => {
    assert.doesNotMatch(sectionsOf(fixtureApp, 'audit')('header'), /- migrate:/);
    assert.match(section('header'), /^- migrate: `pnpm exec murmur migrate` /m);
  });
});

test('without a package.json imports alias the brief still imports via #contracts and says which aliases to add', () => {
  using app = makeApp({
    'package.json': `${JSON.stringify({ name: 'plain-app', private: true, type: 'module' })}\n`,
    'contracts/todos.ts': TODO_CONTRACTS,
    'pieces/todos/audit/context.md': contextMd('todos/audit'),
    'pieces/todos/audit/piece.ts': [
      "import { Handle, Piece } from 'murmur';",
      '',
      "import { TodoCreated } from '#contracts/todos';",
      '',
      'export class Audit extends Piece() {',
      '  @Handle(TodoCreated)',
      '  async created(_event: TodoCreated): Promise<void> {}',
      '}',
      '',
    ].join('\n'),
  });
  const header = sectionsOf(app.root, 'todos/audit')('header');
  assert.match(header, /import \{ TodoCreated \} from '#contracts\/todos';/);
  assert.doesNotMatch(header, /from '\.\.?\//);
  assert.match(
    header,
    /package\.json lacks these aliases; add them: `"imports": \{ "#contracts\/\*": "\.\/contracts\/\*\.ts" \}`/,
  );
});

test('with the aliases in package.json the brief adds no alias note', () => {
  const header = sectionsOf(fixtureApp, 'todos/create')('header');
  assert.match(header, /from '#contracts\//);
  assert.doesNotMatch(header, /lacks these aliases/);
});
