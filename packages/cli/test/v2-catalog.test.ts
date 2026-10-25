import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { murmur } from './helpers.ts';
import { v2Copy, v2Fixture } from './v2-helpers.ts';

type Section = { id: string; text: string };
type CtxJson = { sections: Section[] };

const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'catalog-v2.golden.json'), 'utf8'),
) as unknown;

function section(root: string, id: string, sectionId: string, flags: readonly string[] = []): string {
  const result = murmur(['ctx', id, ...flags, '--format', 'json', '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);

  return result.json<CtxJson>().sections.find((s) => s.id === sectionId)?.text ?? '';
}

describe('murmur catalog on the v2 fixture', () => {
  test('--json equals the golden file, routes included', () => {
    const result = murmur(['catalog', '--json', '--cwd', v2Fixture]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json(), golden);
  });

  test('the golden does not depend on where the app lives', () => {
    using app = v2Copy();
    assert.deepEqual(murmur(['catalog', '--json', '--cwd', app.root]).json(), golden);
  });

  test('the text catalog prints contract kinds and a ROUTES table with effective guards', () => {
    const result = murmur(['catalog', '--cwd', v2Fixture]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ROUTES \(web\)/);
    assert.match(result.stdout, /GET \/stats\s+api\/rest\s+RateLimit\s/);
    assert.match(result.stdout, /todos\.GetTodo\s+query/);
  });

  test('--format mermaid puts edge pieces in a subgraph per http token and draws guard edges dashed', () => {
    const result = murmur(['catalog', '--format', 'mermaid', '--cwd', v2Fixture]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /subgraph n_t_web__http_\["web \(http\)"\]\n {4}n_api_feed\["api\/feed"\]\n {4}n_api_rest/,
    );
    assert.match(result.stdout, /n__web_defaults_ -\.->\|auth\.Authenticate\| n_auth/);
    assert.match(result.stdout, /n_api_rest -->\|todos\.ListTodos\| n_todos/);
    assert.doesNotMatch(result.stdout, /subgraph n_g_api/);
  });

  test("the fixture's own piece and lib tests pass under murmur test", () => {
    using app = v2Copy();
    const result = murmur(['test', '--json', '--cwd', app.root]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const summary = result.json<{ passed: number; failed: number }>();
    assert.deepEqual([summary.passed, summary.failed], [12, 0]);
  });
});

describe('murmur ctx on v2 class pieces', () => {
  test('ctx api/rest has a Serves section naming effective guards and the auth type', () => {
    const serves = section(v2Fixture, 'api/rest', 'serves');
    assert.match(serves, /^## Serves$/m);
    assert.match(
      serves,
      /\| GET \/stats \| RateLimit \(skip: \[Authenticate\]\) \| `Quota` \| → stats\.GetStats \|/,
    );
    assert.match(
      serves,
      /\| GET \/todos\/:id \| Authenticate, RateLimit \| `Principal & Quota` \| method show \|/,
    );
    assert.match(serves, /`req: WebRequest` is `HttpRequest<Principal & Quota>`/);
  });

  test('the Serves sheet opens with an Admission block: ordered guards, after/optional, meta keys with defaults, token callbacks', () => {
    const serves = section(v2Fixture, 'api/rest', 'serves');
    const admission = serves.slice(serves.indexOf('### Admission'), serves.indexOf('| key |'));

    assert.ok(serves.indexOf('### Admission') < serves.indexOf('| key |'));
    assert.match(admission, /^1\. `Authenticate` → `Principal` \{ userId, roles \}$/m);
    assert.match(
      admission,
      /^2\. `RateLimit` → `Quota` \{ remaining \} · optional: Authenticate · meta: cost = 1$/m,
    );
    assert.match(admission, /responseHeaders\(auth\): not set · log\(auth\): set/);
    assert.match(serves, /\| POST \/todos \| Authenticate, RateLimit \(meta: \{ cost: 2 \}\) \|/);
  });

  test('a guard piece brief carries the Guard input note after its contracts', () => {
    const contracts = section(v2Fixture, 'auth', 'contracts');

    assert.match(contracts, /export class RateLimit extends Guard\(Quota, \{/);
    assert.match(contracts, /^Guard input: `headers, params, peer, ip, meta, prior`/m);
    assert.match(contracts, /return reject\(status, message, \{ code, details, headers \}\)/);
    assert.doesNotMatch(section(v2Fixture, 'todos', 'contracts'), /Guard input/);
  });

  test('the web defaults block names req.headers, req.peer and req.ip', () => {
    const serves = section(v2Fixture, 'api/rest', 'serves');
    assert.match(serves, /`req\.headers` is a `Headers`/);
    assert.match(serves, /`req\.peer` is the socket's remote address/);
    assert.match(
      serves,
      /`req\.ip` is the first `X-Forwarded-For` entry when `capabilities\.web\.trustProxy: true` is set in murmur\.yaml \(or `MURMUR__CAP_WEB__TRUST_PROXY=true`\)/,
    );
  });

  test('ctx of a sqlite piece documents busyTimeoutMs and the WAL guarantee', () => {
    const capabilities = section(v2Fixture, 'todos', 'capabilities');
    assert.match(capabilities, /`busyTimeoutMs` \(default 5000\)/);
    assert.match(capabilities, /WAL mode/);
    assert.match(capabilities, /import type \{ Sqlite \} from '@murmur\/node\/capabilities'/);
  });

  test('ctx todos has a Storage section from its own schema.sql', () => {
    const storage = section(v2Fixture, 'todos', 'storage');
    assert.match(storage, /^## Storage$/m);
    assert.match(storage, /### pieces\/todos\/schema\.sql/);
    assert.match(storage, /CREATE TABLE IF NOT EXISTS todo_requests/);
  });

  test('the header lists class lanes: handles, emits, needs as field=capability', () => {
    const header = section(v2Fixture, 'todos', 'header');
    assert.match(header, /todos\.CreateTodo/);
    assert.match(header, /^- needs: `db=sqlite`$/m);
  });

  test('--withhold-code keeps the Serves section: routes with guards, token defaults, error table', () => {
    const serves = section(v2Fixture, 'api/rest', 'serves', ['--withhold-code']);
    assert.match(
      serves,
      /\| GET \/stats \| RateLimit \(skip: \[Authenticate\]\) \| `Quota` \| → stats\.GetStats \|/,
    );
    assert.match(serves, /`req: WebRequest` is `HttpRequest<Principal & Quota>`/);
    assert.match(serves, /HandlerTimeoutError → 504 `timeout`/);
  });

  test('the Tests hint names testPiece auto-fakes, t.enqueued, fakeSqlite({ schema }) and createTestApp', () => {
    const capabilities = section(v2Fixture, 'todos', 'capabilities');

    assert.match(capabilities, /^### tests: testPiece, createTestApp$/m);
    assert.match(capabilities, /`await using t = await testPiece\(P\)` fakes every need left out of `needs`/);
    assert.match(capabilities, /`t\.enqueued\(C\)`/);
    assert.match(capabilities, /fakeSqlite\(\{ schema: 'own' \}\)/);
    assert.match(capabilities, /`t\.fetch\(request, \{ auth \}\)` skips the route's guards/);
    assert.match(capabilities, /createTestApp\(\)`.*`await app\.reset\(\)`.*`await app\.jobs\.drain\(\)`/);
  });

  test('an absent leaf keeps field needs from its tests and routes from its serves lane', () => {
    using app = v2Copy();
    rmSync(join(app.root, '.murmur'), { recursive: true, force: true });
    rmSync(join(app.root, 'pieces/todos/piece.ts'));
    rmSync(join(app.root, 'pieces/api/rest/piece.ts'));
    assert.match(section(app.root, 'todos', 'header'), /^- needs: `db=sqlite` ← context\.md$/m);
    const serves = section(app.root, 'api/rest', 'serves');
    assert.match(serves, /\| GET \/stats \| \? \| `\?` \| \? \|/);
    assert.match(serves, /### web defaults/);
  });

  test('the Contracts sheet prints rejectable(Todo) in full and collapsed, the catalog titles the reply', () => {
    const full = section(v2Fixture, 'todos', 'contracts');
    const collapsed = murmur(['ctx', 'todos', '--budget', '2500', '--cwd', v2Fixture]).stdout;
    const catalog = murmur([
      'catalog',
      '--contract',
      'todos.CompleteTodo',
      '--format',
      'json',
      '--cwd',
      v2Fixture,
    ]);

    assert.match(full, /extends Command\(\{ id: z\.string\(\) \}, rejectable\(Todo\)\)/);
    assert.match(
      collapsed,
      /^export class CompleteTodo extends Command\(\{…1 keys\}, rejectable\(Todo\)\) \{\}$/m,
    );
    assert.match(catalog.stdout, /"title":"rejectable\(Todo\)"/);
  });

  test('the collapsed Contracts line keeps the Page(Todo) title of a list reply', () => {
    using app = v2Copy();
    const contracts = join(app.root, 'contracts/todos.ts');
    const source = readFileSync(contracts, 'utf8')
      .replace(
        "import { Command, Event, Model, Query, rejectable } from 'murmur';",
        "import { Command, Event, Model, Page, Paging, Query, rejectable } from 'murmur';",
      )
      .replace(
        '{ done: z.boolean().optional() }, Todo.array()',
        '{ done: z.boolean().optional(), ...Paging() }, Page(Todo)',
      );
    writeFileSync(contracts, source);
    const collapsed = murmur(['ctx', 'todos', '--budget', '2500', '--cwd', app.root]).stdout;

    assert.match(collapsed, /^export class ListTodos extends Query\(\{…3 keys\}, Page\(Todo\)\) \{\}$/m);
  });
});
