import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, test } from 'node:test';

import {
  contextMd,
  copyApp,
  fixtureApp,
  makeApp,
  murmur,
  packageRoot,
  repoRoot,
  TODO_CONTRACTS,
} from './helpers.ts';
import { v2Copy, v2Fixture } from './v2-helpers.ts';

type Lane = { values: string[]; source: string };
type Report = { id: string; text: string };
type CtxJson = {
  piece: string;
  sections: Report[];
  tokens: number;
  regeneration: {
    reason: 'withheld' | 'absent';
    lanes: Record<'needs' | 'listens' | 'emits' | 'requests', Lane>;
  } | null;
};

const todoApi = join(repoRoot, 'examples', 'todo-api');
const CREATE = 'pieces/todos/create';
const TODOS = 'pieces/todos';

function ctxJson(root: string, args: readonly string[]): CtxJson {
  const result = murmur(['ctx', ...args, '--format', 'json', '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);

  return result.json<CtxJson>();
}

function text(json: CtxJson, id: string): string {
  return json.sections.find((s) => s.id === id)?.text ?? '';
}

function markdown(json: CtxJson): string {
  return json.sections.map((s) => s.text).join('\n\n');
}

function lanes(json: CtxJson) {
  assert.ok(json.regeneration !== null, 'regeneration mode engaged');

  return json.regeneration.lanes;
}

function fixtureCopy() {
  return copyApp(fixtureApp, join(packageRoot, 'node_modules'));
}

function moveAside(root: string, file: string): string {
  const aside = mkdtempSync(join(tmpdir(), 'murmur-aside-'));
  renameSync(join(root, file), join(aside, 'piece.ts'));

  return aside;
}

function assertLeafHeader(json: CtxJson): void {
  const header = text(json, 'header');
  assert.match(header, /leaf under regeneration/);
  assert.doesNotMatch(header, /group/i);
  assert.equal(json.regeneration?.reason, 'absent');
}

function assertTodoBrief(json: CtxJson): void {
  assert.match(text(json, 'capabilities'), /^### db \(sqlite\)$/m);
  assert.match(text(json, 'catalog'), /\| todos\.create\.requested \| command \| [^|]+ \| todos\/create \|/);
  assert.match(text(json, 'catalog'), /\| todos\.created \| event \| todos\/create \|/);
  assert.match(text(json, 'files'), /^- `pieces\/todos\/create\/fixtures\/create-requested\.json` · /m);
}

suite('murmur ctx --withhold-code', () => {
  test('leaves out piece.ts and private files, keeps capability docs, catalog rows and fixtures', () => {
    const json = ctxJson(fixtureApp, ['todos/create', '--withhold-code', '--with', 'all']);
    const md = markdown(json);
    assert.doesNotMatch(md, /todoId\(|class TodoCreator|### ids\.ts/);
    assert.equal(text(json, 'private'), '');
    assert.match(text(json, 'piece'), /piece\.ts withheld/);
    assert.match(text(json, 'header'), /piece\.ts withheld \(--withhold-code\)/);
    assert.equal(json.regeneration?.reason, 'withheld');
    assert.deepEqual(lanes(json).needs, { values: ['db=sqlite'], source: 'catalog' });
    assert.deepEqual(lanes(json).listens.values, ['todos.create.requested']);
    assert.match(text(json, 'header'), /^- needs: `db=sqlite` ← catalog$/m);
    assertTodoBrief(json);
    assert.match(text(json, 'tests'), /piece\.test\.ts/);
    assert.match(text(json, 'fixtures'), /^### fixtures\/create-requested\.json$/m);
    assert.doesNotMatch(text(json, 'files'), /`pieces\/todos\/create\/(piece|ids)\.ts`/);
  });

  test('the code hint and the header name headings the brief really has', () => {
    for (const extra of [['--with', 'code'], ['--with', 'code,tests'], []]) {
      const json = ctxJson(fixtureApp, ['todos/create', '--withhold-code', ...extra]);
      const hint = `${text(json, 'piece')}\n${text(json, 'header')}`;
      const named = [...hint.matchAll(/`(##+ [^`]+)`/g)].map((m) => m[1] as string);
      assert.ok(named.length >= 3, hint);
      const md = markdown(json);
      for (const heading of named) {
        assert.ok(md.split('\n').includes(heading), `${heading} is a heading (${extra.join(' ')})`);
      }
    }
  });

  test('a piece without tests: the header names no tests and no `## Files` the brief omits', () => {
    using app = v2Copy();
    const withSql = ctxJson(app.root, ['stats', '--withhold-code']);
    rmSync(join(app.root, 'pieces/stats/schema.sql'));
    const contextOnly = ctxJson(app.root, ['stats', '--withhold-code']);
    for (const json of [withSql, contextOnly]) {
      const header = text(json, 'header');
      assert.doesNotMatch(header, /tests/, header);
      const named = [...header.matchAll(/`(##+ [^`]+)`/g)].map((m) => m[1] as string);
      const md = markdown(json).split('\n');

      for (const heading of named) {
        assert.ok(md.includes(heading), `${heading} is a heading of the brief`);
      }
    }

    assert.equal(text(contextOnly, 'files'), '');
  });

  test('the plugin writer refers only to headings a brief has (domain piece, v2 edge, v2 domain with storage)', () => {
    const briefs = [
      ctxJson(fixtureApp, ['todos/create', '--withhold-code']),
      ctxJson(v2Fixture, ['api/rest', '--withhold-code']),
      ctxJson(v2Fixture, ['todos', '--withhold-code']),
    ];
    const md = new Set(briefs.flatMap((json) => markdown(json).split('\n')));
    const writer = readFileSync(join(repoRoot, 'plugins/murmur/agents/piece-writer.md'), 'utf8');
    const named = [...writer.matchAll(/`(##+ [A-Z][^`]*)`/g)].map((m) => m[1] as string);
    assert.ok(named.length > 0, 'piece-writer names brief headings');

    for (const heading of named) {
      assert.ok(md.has(heading), `${heading} is a brief heading`);
    }

    assert.doesNotMatch(writer, /sections? \d/);
  });
});

suite('murmur ctx on a leaf under regeneration (no piece.ts)', () => {
  test('without a snapshot the lanes come from the tests and the folder stays a leaf', () => {
    using app = fixtureCopy();
    rmSync(join(app.root, CREATE, 'piece.ts'));
    const json = ctxJson(app.root, ['todos/create']);
    assertLeafHeader(json);
    assert.deepEqual(lanes(json), {
      needs: { values: ['db=sqlite'], source: 'tests' },
      listens: { values: ['todos.create.requested'], source: 'tests' },
      emits: { values: ['todos.created'], source: 'tests' },
      requests: { values: [], source: 'tests' },
      serves: { values: [], source: 'tests' },
    });
    assert.match(text(json, 'header'), /^- requests: \(none\) ← tests$/m);
    assertTodoBrief(json);
    assert.doesNotMatch(markdown(json), /### ids\.ts|todos\.cache\.invalidate/);
  });

  test('the last catalog snapshot wins and survives a catalog run after piece.ts is gone', () => {
    using app = fixtureCopy();
    assert.equal(murmur(['catalog', '--cwd', app.root]).status, 0);
    assert.ok(existsSync(join(app.root, '.murmur', 'catalog-snapshot.json')));
    rmSync(join(app.root, CREATE, 'piece.ts'));
    assert.equal(murmur(['catalog', '--cwd', app.root]).status, 0);
    const json = ctxJson(app.root, ['todos/create']);
    assertLeafHeader(json);

    for (const lane of Object.values(lanes(json))) {
      assert.equal(lane.source, 'catalog-snapshot');
    }

    assert.deepEqual(lanes(json).emits.values, ['todos.created', 'todos.cache.invalidate']);
    assert.match(
      text(json, 'header'),
      /^- emits: `todos\.created`, `todos\.cache\.invalidate` ← catalog snapshot/m,
    );
    assert.match(text(json, 'config'), /\| prefix \| string \|/);
    assertTodoBrief(json);
  });

  test('context.md structured lines beat the tests lane by lane', () => {
    using app = fixtureCopy();
    rmSync(join(app.root, CREATE, 'piece.ts'));
    appendFileSync(
      join(app.root, CREATE, 'context.md'),
      '\nNeeds: `sqlite` (table todos), kv\nRequests: none\n',
    );
    const json = ctxJson(app.root, ['todos/create']);
    assert.deepEqual(lanes(json).needs, { values: ['db=sqlite', 'kv'], source: 'context.md' });
    assert.deepEqual(lanes(json).requests, { values: [], source: 'context.md' });
    assert.equal(lanes(json).listens.source, 'tests');
    assert.match(text(json, 'capabilities'), /^### kv$/m);
  });

  test('a scaffolded context.md carries the lanes as structured lines', () => {
    using app = makeApp({ 'contracts/todos.ts': TODO_CONTRACTS, 'pieces/context.md': contextMd('pieces') });
    const args = ['--handles', 'TodoCreated', '--emits', 'TodoAudited,TodoCountRequested', '--needs', 'kv'];
    assert.equal(murmur(['new', 'piece', 'audit/log', ...args, '--cwd', app.root]).status, 0);
    rmSync(join(app.root, 'pieces/audit/log/piece.ts'));
    rmSync(join(app.root, 'pieces/audit/log/piece.test.ts'));
    assert.deepEqual(lanes(ctxJson(app.root, ['audit/log'])), {
      needs: { values: ['kv'], source: 'context.md' },
      listens: { values: ['todos.created'], source: 'context.md' },
      emits: { values: ['todos.audited'], source: 'context.md' },
      requests: { values: ['todos.count.requested'], source: 'context.md' },
      serves: { values: [], source: 'context.md' },
    });
  });

  test('the header commands work from the app root for the leaf', () => {
    using app = fixtureCopy();
    rmSync(join(app.root, CREATE, 'piece.ts'));
    const header = text(ctxJson(app.root, ['todos/create']), 'header');
    assert.match(header, /^- test: `pnpm exec murmur test pieces\/todos\/create`$/m);
    assert.match(header, /^- check: `pnpm exec murmur check pieces\/todos\/create`$/m);
    const run = murmur(['test', CREATE, '--json', '--cwd', app.root]);
    assert.equal(run.status, 1, 'the leaf tests run (and fail without piece.ts)');
    assert.ok(run.json<{ failed: number }>().failed > 0);
  });
});

suite('examples/todo-api todos with piece.ts moved aside (copy outside the workspace)', () => {
  const TODOS_HANDLES = [
    'todos.CreateTodo',
    'todos.GetTodo',
    'todos.ListTodos',
    'todos.SearchTodos',
    'todos.CompleteTodo',
    'todos.RemoveTodo',
  ];

  function assertTodosBrief(json: CtxJson): void {
    assert.match(text(json, 'storage'), /CREATE TABLE IF NOT EXISTS todo_requests/);
    assert.match(text(json, 'capabilities'), /^### db \(sqlite\)$/m);
    assert.match(text(json, 'catalog'), /\| todos\.CreateTodo \| command \| api\/rest \| todos \|/);
    assert.match(text(json, 'catalog'), /\| todos\.TodoCreated \| event \| todos \| api\/feed, stats \|/);
    assert.match(text(json, 'files'), /^- `pieces\/todos\/fixtures\/create-todo\.json` · /m);
    assert.doesNotMatch(markdown(json), /INSERT INTO todos \(id, title, done, created_at\) VALUES/);
  }

  test('keeps the storage, sqlite section, catalog rows and fixtures; the lanes come from context.md', () => {
    using app = copyApp(todoApi);
    const aside = moveAside(app.root, `${TODOS}/piece.ts`);

    try {
      const json = ctxJson(app.root, ['todos']);
      assertLeafHeader(json);
      assertTodosBrief(json);
      assert.deepEqual(lanes(json).listens, { values: TODOS_HANDLES, source: 'context.md' });
    } finally {
      rmSync(aside, { recursive: true, force: true });
    }
  });

  test('with a snapshot from murmur catalog the lanes come from it', () => {
    using app = copyApp(todoApi);
    assert.equal(murmur(['catalog', '--cwd', app.root]).status, 0);
    const aside = moveAside(app.root, `${TODOS}/piece.ts`);

    try {
      const json = ctxJson(app.root, ['todos']);
      assertLeafHeader(json);
      assertTodosBrief(json);
      assert.deepEqual(lanes(json).listens, { values: TODOS_HANDLES, source: 'catalog-snapshot' });
    } finally {
      rmSync(aside, { recursive: true, force: true });
    }
  });
});
