import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe as suite, test } from 'node:test';

import { analyze } from '../src/analysis/index.ts';
import { contextMd, fixtureApp, makeApp, murmur, TODO_CONTRACTS } from './helpers.ts';
import { v2Fixture } from './v2-helpers.ts';

type Report = { id: string; title: string; tokens: number; level: number; text: string };
type CtxJson = {
  kind: string;
  piece: string;
  sections: Report[];
  tokens: number;
  fullTokens: number;
  budget: number | null;
  overBudget: boolean;
  sizing: 'ok' | 'large' | 'warn' | 'fail';
  limits: { ctxWarnTokens: number; ctxFailTokens: number };
  error: string | null;
};

const PRIORITY: Readonly<Record<string, number>> = {
  header: 0,
  rules: 0,
  'context-chain': 2,
  context: 0,
  files: 0,
  piece: 0,
  private: 1,
  contracts: 1,
  catalog: 1,
  capabilities: 2,
  config: 1,
  tests: 2,
  fixtures: 4,
  neighbors: 5,
  footer: 0,
};

const HEADINGS = [
  /^# Piece: todos\/create — Create todo$/m,
  /^## Rules$/m,
  /^## Context$/m,
  /^### pieces\/todos\/context\.md \(group\)$/m,
  /^### Siblings \/ children$/m,
  /^## Files$/m,
  /^## Contracts$/m,
  /^### #contracts\/todos → TodoCreateRequested, TodoCreated$/m,
  /^## Catalog$/m,
  /^## Capabilities$/m,
  /^### db \(sqlite\)$/m,
  /^### defaults: log, clock, ids$/m,
  /^## Config$/m,
  /^## Footer$/m,
];

const OPT_IN_HEADINGS = [
  /^## Code$/m,
  /^### piece\.ts$/m,
  /^## Tests$/m,
  /^## Fixtures$/m,
  /^## Neighbors$/m,
];

function paddedLib(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `  const v${i} = '${'x'.repeat(66)}'`);

  return ['export function big(): number {', ...body, '  return 0', '}', ''].join('\n');
}

function paddedApp(libLines: number) {
  return makeApp({
    'contracts/todos.ts': TODO_CONTRACTS,
    'pieces/big/context.md': contextMd('big'),
    'pieces/big/lib.ts': paddedLib(libLines),
    'pieces/big/piece.test.ts': "import { test } from 'node:test'\n\ntest('big', () => {})\n",
    'pieces/big/piece.ts': [
      "import { sqlite } from '@murmur/node/capabilities';",
      "import { Handle, Piece } from 'murmur';",
      '',
      "import { TodoCreated } from '#contracts/todos';",
      '',
      "import { big } from './lib.ts';",
      '',
      'export class Big extends Piece({ needs: { db: sqlite } }) {',
      '  @Handle(TodoCreated)',
      '  async created(_event: TodoCreated): Promise<void> {',
      "    this.log.info('n', { n: big() });",
      '  }',
      '}',
      '',
    ].join('\n'),
    'pieces/big/fixtures/created.json': JSON.stringify({ id: 'a', kind: 'a', note: 'y'.repeat(4000) }),
  });
}

function editPiece(needs: string): string {
  return [
    "import { kv, sqlite } from '@murmur/node/capabilities';",
    "import { Piece } from 'murmur';",
    '',
    `export class Edit extends Piece({ needs: ${needs} }) {}`,
    '',
  ].join('\n');
}

function ctx(root: string, args: readonly string[]) {
  return murmur(['ctx', ...args, '--cwd', root]);
}

function privateLevel(lines: number): number | undefined {
  using app = paddedApp(lines);
  const json = ctx(app.root, [
    'big',
    '--with',
    'all',
    '--budget',
    '5000',
    '--format',
    'json',
  ]).json<CtxJson>();

  return json.sections.find((s) => s.id === 'private')?.level;
}

suite('murmur ctx', () => {
  test('--budget 8000 --format json shrinks sections strictly in priority order', () => {
    using app = paddedApp(1100);
    const result = ctx(app.root, ['big', '--with', 'all', '--budget', '8000', '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const json = result.json<CtxJson>();
    assert.equal(json.overBudget, false);
    assert.ok(json.tokens <= 8000);
    assert.equal(json.budget, 8000);
    assert.equal(json.sizing, 'large', 'JSON sizing is the tier of the full brief, like the footer');
    const shrunk = json.sections.filter((s) => s.level > 0);
    assert.ok(
      shrunk.some((s) => PRIORITY[s.id] === 1),
      'the padded private file forced priority 1 to shrink',
    );

    for (const section of json.sections) {
      const priority = PRIORITY[section.id];
      assert.notEqual(priority, undefined, section.id);

      if (priority === 0) {
        assert.equal(section.level, 0, `${section.id} never shrinks`);
      }

      if (section.level === 0) {
        continue;
      }

      for (const other of json.sections.filter((o) => (PRIORITY[o.id] ?? 0) > (priority ?? 0))) {
        assert.equal(
          other.level,
          2,
          `${other.id} (prio ${PRIORITY[other.id]}) must be fully shrunk before ${section.id}`,
        );
      }
    }

    const lib = json.sections.find((s) => s.id === 'private');
    assert.match(lib?.text ?? '', /body elided \(\d+ lines\)/);
  });

  test('a private file up to 300 lines stays whole at level 1; a longer one shrinks to signatures', () => {
    assert.equal(privateLevel(250), 2);
    assert.equal(privateLevel(350), 1);
  });

  test('--budget 0 returns every section at level 0 with the stable headings', () => {
    const result = murmur(['ctx', 'todos/create', '--budget', '0', '--format', 'json', '--cwd', fixtureApp]);
    assert.equal(result.status, 0, result.stderr);
    const json = result.json<CtxJson>();
    assert.ok(json.sections.every((s) => s.level === 0));
    assert.equal(json.budget, 0);
    assert.equal(json.overBudget, false);
    const markdown = json.sections.map((s) => s.text).join('\n\n');
    for (const heading of HEADINGS) {
      assert.match(markdown, heading);
    }

    const md = murmur(['ctx', 'todos/create', '--cwd', fixtureApp]);
    for (const heading of HEADINGS) {
      assert.match(md.stdout, heading);
    }

    const all = murmur(['ctx', 'todos/create', '--with', 'all', '--cwd', fixtureApp]);
    for (const heading of [...HEADINGS, ...OPT_IN_HEADINGS]) {
      assert.match(all.stdout, heading);
    }
  });

  test('a group with no files beyond its context.md gets no ## Files section', () => {
    const json = ctx(v2Fixture, ['api', '--format', 'json']).json<CtxJson>();
    assert.ok(!json.sections.some((s) => s.id === 'files'));
    assert.doesNotMatch(ctx(v2Fixture, ['pieces/api']).stdout, /^## Files$/m);
  });

  test('the not-printed hint names only the --with flag', () => {
    const md = ctx(fixtureApp, ['todos/create']).stdout;
    assert.match(
      md,
      /^- not printed: code, tests, fixtures, neighbors \(`--with code,tests,fixtures,neighbors`\)$/m,
    );
  });

  test('the default brief lists the folder under ## Files instead of printing code, tests and fixtures', () => {
    const json = ctx(fixtureApp, ['todos/create', '--format', 'json']).json<CtxJson>();
    const ids = json.sections.map((s) => s.id);
    assert.deepEqual(
      ids.filter((id) => ['piece', 'private', 'tests', 'fixtures', 'neighbors'].includes(id)),
      [],
    );
    assert.equal(ids[ids.indexOf('context') + 1], 'files');
    const files = json.sections.find((s) => s.id === 'files')?.text ?? '';
    assert.match(files, /^## Files$/m);

    for (const path of [
      'piece.ts',
      'ids.ts',
      'piece.test.ts',
      'context.md',
      'fixtures/create-requested.json',
    ]) {
      assert.match(
        files,
        new RegExp(
          `^- \`pieces/todos/create/${path.replaceAll('.', '\\.')}\` · \\d+ lines? · \\d+ tokens$`,
          'm',
        ),
      );
    }

    assert.match(
      files,
      /Read the files the task touches; the brief carries what the folder cannot tell you\.$/,
    );
    const md = ctx(fixtureApp, ['todos/create']).stdout;
    for (const heading of OPT_IN_HEADINGS) {
      assert.doesNotMatch(md, heading);
    }

    assert.doesNotMatch(md, /class TodoCreator/);
  });

  test('--with tests adds ## Tests, the default does not; --with all adds code, fixtures and neighbors', () => {
    const plain = ctx(fixtureApp, ['todos/create']).stdout;
    const tests = ctx(fixtureApp, ['todos/create', '--with', 'tests']);
    assert.equal(tests.status, 0, tests.stderr);
    assert.doesNotMatch(plain, /^## Tests$/m);
    assert.match(tests.stdout, /^## Tests$/m);
    assert.doesNotMatch(tests.stdout, /^## Code$/m);
    assert.match(tests.stdout, /reproduce: `pnpm exec murmur ctx pieces\/todos\/create --with tests`/);
    const all = ctx(fixtureApp, ['todos/create', '--with', 'all', '--format', 'json']).json<CtxJson>();
    const listed = ctx(fixtureApp, [
      'todos/create',
      '--with',
      'neighbors,fixtures,tests,code',
      '--format',
      'json',
    ]).json<CtxJson>();
    assert.deepEqual(
      all.sections.map((s) => s.id),
      listed.sections.map((s) => s.id),
    );

    for (const id of ['piece', 'private', 'tests', 'fixtures', 'neighbors']) {
      assert.ok(
        all.sections.some((s) => s.id === id),
        id,
      );
    }

    assert.equal(all.fullTokens, listed.fullTokens);
    const bad = ctx(fixtureApp, ['todos/create', '--with', 'docs']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /code, tests, fixtures, neighbors/);
  });

  test('a piece padded past 25k prints large for the full brief while the minimal brief stays small', () => {
    using app = paddedApp(1400);
    const result = ctx(app.root, ['big', '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const json = result.json<CtxJson>();
    assert.equal(json.sizing, 'large');
    assert.ok(json.tokens < 5_000, String(json.tokens));
    assert.ok(json.fullTokens >= 25_000 && json.fullTokens < 40_000, String(json.fullTokens));
    const footer = json.sections.find((s) => s.id === 'footer')?.text ?? '';
    assert.match(footer, new RegExp(`tokens: ${json.tokens} printed, full ${json.fullTokens} \\(large\\);`));
  });

  test('a class piece.ts that throws at import still yields its static sections: ctx never imports it', () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'pieces/half/context.md': contextMd('half'),
      'pieces/half/piece.ts': [
        "import { sqlite } from '@murmur/node/capabilities';",
        "import { Handle, Piece } from 'murmur';",
        "import { z } from 'zod';",
        '',
        "import { TodoCountRequested, TodoCreated } from '#contracts/todos';",
        '',
        "throw new Error('half-written piece');",
        '',
        'export class Half extends Piece({',
        '  needs: { db: sqlite },',
        '  config: { limit: z.number().default(5) },',
        '  emits: [TodoCreated],',
        '}) {',
        '  @Handle(TodoCountRequested)',
        '  async count(_input: TodoCountRequested): Promise<{ count: number }> {',
        '    return { count: 0 };',
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    const result = ctx(app.root, ['half', '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const json = result.json<CtxJson>();
    assert.equal(json.error, null);
    const text = (id: string) => json.sections.find((s) => s.id === id)?.text ?? '';
    assert.match(text('contracts'), /export class TodoCountRequested extends Query\(/);
    assert.match(text('contracts'), /export class TodoCreated extends Event\(/);
    assert.match(text('catalog'), /\| todos\.count\.requested \|.*\| half \|/);
    assert.match(text('catalog'), /\| todos\.created \|.*\| half \|/);
    assert.match(text('capabilities'), /### db \(sqlite\)/);
    assert.match(text('config'), /\| limit \| number \| `MURMUR__HALF__LIMIT` \|/);
  });

  test('a folder with context.md but no piece.ts still yields a brief', () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'pieces/billing/context.md': `${contextMd('billing')}\nWill listen to \`todos.created\`.\n`,
    });
    const result = ctx(app.root, ['billing']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Write it from `## Context`, `## Contracts` and `## Capabilities`\./);
    assert.doesNotMatch(result.stdout, /## Files/);
    assert.match(result.stdout, /leaf under regeneration/);
    assert.match(result.stdout, /export class TodoCreated extends Event\(/);
  });

  test('the footer, --format json and the stderr line report one token count', () => {
    using app = paddedApp(2200);
    const json = ctx(app.root, ['big', '--with', 'all', '--format', 'json']).json<CtxJson>();
    const md = ctx(app.root, ['big', '--with', 'all']);
    const footer = /tokens: (\d+) printed, full (\d+) \(warn\);/.exec(md.stdout);
    assert.ok(footer !== null, md.stdout.slice(-600));
    assert.equal(Number(footer[1]), json.tokens);
    assert.equal(Number(footer[2]), json.fullTokens);
    assert.equal(json.tokens, json.fullTokens);
    assert.equal(
      json.tokens,
      json.sections.reduce((n, s) => n + s.tokens, 0),
    );
    const line = /ctx: big is ([\d ]+) tokens/.exec(md.stderr);
    assert.equal(Number(line?.[1]?.replaceAll(' ', '')), json.fullTokens);
    const budgeted = ctx(app.root, [
      'big',
      '--with',
      'all',
      '--budget',
      '8000',
      '--format',
      'json',
    ]).json<CtxJson>();
    const budgetFooter = budgeted.sections.find((s) => s.id === 'footer')?.text ?? '';
    assert.match(
      budgetFooter,
      new RegExp(
        `budget: 8000 \\(${budgeted.tokens} tokens printed, full ${budgeted.fullTokens} \\(warn\\); caps skipped\\)`,
      ),
    );
  });

  test('past 25k tokens ctx prints large in the footer, exits 0 and stays quiet on stderr', () => {
    using app = paddedApp(1400);
    const large = ctx(app.root, ['big', '--with', 'all', '--format', 'json']);
    assert.equal(large.status, 0, large.stderr);
    const json = large.json<CtxJson>();
    assert.equal(json.sizing, 'large');
    assert.ok(json.tokens >= 25_000 && json.tokens < 40_000, String(json.tokens));
    const md = ctx(app.root, ['big']);
    assert.equal(md.status, 0);
    assert.match(
      md.stdout,
      /tokens: \d+ printed, full \d+ \(large\); tiers large ≥ 25000, warn ≥ 40000, fail ≥ 80000/,
    );
    assert.doesNotMatch(md.stderr, /split before it grows/);
  });

  test('without --budget a piece past 40k tokens warns and exits 0; --budget 8000 shrinks to ok', () => {
    using app = paddedApp(2200);
    const warn = ctx(app.root, ['big', '--format', 'json']);
    assert.equal(warn.status, 0, warn.stderr);
    const json = warn.json<CtxJson>();
    assert.equal(json.sizing, 'warn');
    assert.ok(json.fullTokens >= 40_000 && json.fullTokens < 80_000, String(json.fullTokens));
    assert.ok(json.sections.every((s) => s.level === 0));
    assert.equal(json.budget, null);
    const line =
      /ctx: big is [\d ]+ tokens in full \(warn ≥ 40 000\) — split before it grows; heuristics in (\S+)$/m.exec(
        warn.stderr,
      );
    assert.ok(line !== null, warn.stderr);
    assert.ok(existsSync(resolve(app.root, line[1] as string)), String(line[1]));
    const md = ctx(app.root, ['big', '--with', 'code']);
    assert.equal(md.status, 0);
    assert.match(md.stdout, /v2199 = 'x{66}'/);
  });

  test('past 80k tokens ctx still prints the brief but exits 1; --budget 8000 on it exits 0, JSON sizing stays fail', () => {
    using app = paddedApp(4200);
    const fail = ctx(app.root, ['big', '--format', 'json']);
    assert.equal(fail.status, 1);
    const json = fail.json<CtxJson>();
    assert.equal(json.sizing, 'fail');
    assert.ok(json.fullTokens >= 80_000);
    assert.match(fail.stderr, /\(fail ≥ 80 000\)/);
    const budgeted = ctx(app.root, ['big', '--with', 'all', '--budget', '8000', '--format', 'json']);
    assert.equal(budgeted.status, 0, budgeted.stderr);
    const shrunk = budgeted.json<CtxJson>();
    assert.equal(shrunk.sizing, 'fail');
    assert.doesNotMatch(budgeted.stderr, /split before it grows/);
    assert.equal(shrunk.overBudget, false);
    assert.ok(shrunk.sections.some((s) => s.level > 0));
  });

  test('an unknown piece exits 2 with candidates', () => {
    const result = murmur(['ctx', 'create', '--cwd', fixtureApp]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /did you mean: todos\/create/);
  });
});

suite('analyze()', () => {
  test('editing a piece between two analyze() calls yields the new metadata', async () => {
    using app = makeApp({
      'contracts/todos.ts': TODO_CONTRACTS,
      'pieces/edit/context.md': contextMd('edit'),
      'pieces/edit/piece.ts': editPiece('{ db: sqlite }'),
    });
    const first = await analyze(app.root, {});
    assert.deepEqual(first.description.pieces[0]?.needs, ['sqlite']);
    writeFileSync(join(app.root, 'pieces/edit/piece.ts'), editPiece('{ db: sqlite, kv }'));
    const second = await analyze(app.root, {});
    assert.deepEqual(second.description.pieces[0]?.needs, ['sqlite', 'kv']);
  });
});
