import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { murmur } from './helpers.ts';
import { v2Fixture } from './v2-helpers.ts';

type Section = { id: string; text: string };
type CtxJson = { sections: Section[] };
type Golden = Record<string, Record<string, string>>;

const GOLDEN = join(import.meta.dirname, 'fixtures', 'ctx-v2.golden.json');
const BRIEFS: Readonly<Record<string, readonly string[]>> = {
  todos: ['header', 'rules', 'capabilities', 'files'],
  'api/rest': ['header', 'serves'],
  auth: ['header'],
};

function sectionsOf(id: string, wanted: readonly string[]): Record<string, string> {
  const result = murmur(['ctx', id, '--withhold-code', '--format', 'json', '--cwd', v2Fixture]);
  assert.equal(result.status, 0, result.stderr);
  const sections = result.json<CtxJson>().sections.filter((s) => wanted.includes(s.id));

  return Object.fromEntries(sections.map((s) => [s.id, s.text]));
}

function currentBriefs(): Golden {
  return Object.fromEntries(Object.entries(BRIEFS).map(([id, wanted]) => [id, sectionsOf(id, wanted)]));
}

test('ctx --withhold-code header, rules, capability sheet, Files and Serves equal the golden briefs', () => {
  const current = currentBriefs();
  if (process.env['UPDATE_GOLDEN'] === '1') {
    writeFileSync(GOLDEN, `${JSON.stringify(current, null, 2)}\n`);
  }

  assert.deepEqual(current, JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden);
});

test('the golden briefs carry the import skeleton, rule 1 on reads, the field-initialiser rule, the tx rule, the match rule and the fix command', () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;
  const todos = golden['todos'] ?? {};
  const rest = golden['api/rest'] ?? {};

  assert.match(
    todos['header'] ?? '',
    /^import \{ type Delivery, Handle, Piece, reject, type Rejection \} from 'murmur';$/m,
  );
  assert.match(
    todos['header'] ?? '',
    /^import \{ .*CreateTodo.*, type Todo, .* \} from '#contracts\/todos';$/m,
  );
  assert.match(todos['header'] ?? '', /^- fix: `pnpm exec murmur check --fix pieces\/todos`.*\n- check: /m);
  assert.match(rest['header'] ?? '', /^import \{ Authenticate \} from '#contracts\/auth';$/m);
  assert.match(rest['serves'] ?? '', /^\| GET \/stats \| RateLimit \(skip: \[Authenticate\]\) \|/m);
  assert.match(rest['serves'] ?? '', /a `→ C` row is a shorthand above the class/);
  assert.match(todos['header'] ?? '', /^import \{ sqlite \} from '@murmur\/node\/capabilities';$/m);
  assert.match(todos['header'] ?? '', /^import type \{ Sqlite \} from '@murmur\/node\/capabilities';$/m);
  assert.match(
    todos['rules'] ?? '',
    /^1\. .*other pieces' code is off limits, even for idioms: read context\.md files and contracts only\.$/m,
  );
  assert.match(rest['header'] ?? '', /^import web, \{ type WebRequest \} from '#capabilities\/web';$/m);
  assert.match(
    golden['auth']?.['header'] ?? '',
    /^import \{ Handle, Piece, reject, type Rejection \} from 'murmur';$/m,
  );
  assert.match(
    todos['rules'] ?? '',
    /Field initialisers may use `this\.db` \/ `this\.config` \/ `this\.log`/,
  );
  assert.match(todos['rules'] ?? '', /`new X\(\)` of the piece outside the runtime throws/);
  assert.match(todos['capabilities'] ?? '', /a nested `transaction\(fn\)` joins the outer one/);
  assert.match(rest['serves'] ?? '', /a static segment beats `:param`.*then the longer path wins/);
  assert.match(rest['serves'] ?? '', /params < query < JSON body/);
  assert.match(
    rest['serves'] ?? '',
    /^- read with `const \{ params, query, headers, body \} = await req\.read\(/m,
  );
  assert.match(
    rest['serves'] ?? '',
    /^- answer with `return req\.reply\(outcome, \{ status, headers, etag \}\)`/m,
  );
  assert.match(rest['serves'] ?? '', /`undefined` \(204\) or `null` \(404 `not_found`\)/);
  assert.match(rest['serves'] ?? '', /^\| body \| 422 \| `validation_failed` \|$/m);
  assert.match(rest['serves'] ?? '', /^- issueCodes: `too_small` → `too_short`$/m);
  assert.match(rest['serves'] ?? '', /answers 422: `\{"error":\{"code":"validation_failed"/);
  assert.match(rest['header'] ?? '', /^import type \{ HttpResult \} from '@murmur\/node\/capabilities';$/m);
  assert.match(todos['files'] ?? '', /^- `pieces\/todos\/piece\.test\.ts` · \d+ lines · \d+ tokens$/m);
  assert.doesNotMatch(todos['files'] ?? '', /`pieces\/todos\/(piece|repository)\.ts`/);
  assert.match(todos['header'] ?? '', /the tests listed under `## Files`/);
});

test('the Sqlite type import comes only when a private file or a regenerated piece may type the handle', () => {
  const header = (args: readonly string[]): string => {
    const result = murmur(['ctx', ...args, '--format', 'json', '--cwd', v2Fixture]);
    assert.equal(result.status, 0, result.stderr);

    return result.json<CtxJson>().sections.find((s) => s.id === 'header')?.text ?? '';
  };
  const sqliteType = /^import type \{ Sqlite \} from '@murmur\/node\/capabilities';$/m;

  assert.match(header(['todos']), sqliteType);
  assert.doesNotMatch(header(['stats']), sqliteType);
  assert.match(header(['stats', '--withhold-code']), sqliteType);
  assert.doesNotMatch(header(['auth']), sqliteType);
});
