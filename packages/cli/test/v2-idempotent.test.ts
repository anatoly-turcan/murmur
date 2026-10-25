import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { murmur } from './helpers.ts';
import { check, found, v2Copy, v2Fixture } from './v2-helpers.ts';

const rest = readFileSync(join(v2Fixture, 'pieces/api/rest/piece.ts'), 'utf8');
const auth = readFileSync(join(v2Fixture, 'contracts/auth.ts'), 'utf8');

function withRoute(from: string, to: string): Record<string, string> {
  assert.ok(rest.includes(from), from);

  return { 'pieces/api/rest/piece.ts': rest.replace(from, to) };
}

function servesOf(root: string): string {
  const result = murmur(['ctx', 'api/rest', '--format', 'json', '--cwd', root]);
  assert.equal(result.status, 0, result.stderr);

  return result.json<{ sections: { id: string; text: string }[] }>().sections.find((s) => s.id === 'serves')
    ?.text as string;
}

describe('murmur check on idempotent routes', () => {
  test('idempotent on a GET route is idempotent-method, naming the allowed methods', () => {
    using app = v2Copy(
      withRoute(
        "@Serve(web.get('/todos/:id'))",
        "@Serve(web.get('/todos/:id', { idempotent: { scope: ['ip'] } }))",
      ),
    );
    const result = check(app.root);
    const [method] = found(result.json, 'idempotent-method');

    assert.equal(result.status, 1, result.stderr);
    assert.equal(method?.severity, 'error');
    assert.equal(method?.file, 'pieces/api/rest/piece.ts');
    assert.equal(
      method?.message,
      'route GET /todos/:id: `idempotent` applies to POST/PUT/PATCH/DELETE on non-raw routes; drop it or change the method',
    );
  });

  test('a scope path the kept guards do not produce is idempotent-scope, listing the available paths', () => {
    using app = v2Copy(
      withRoute('meta: { cost: 2 }', "meta: { cost: 2 }, idempotent: { scope: ['auth.usrId'] }"),
    );
    const result = check(app.root);
    const [scope] = found(result.json, 'idempotent-scope');

    assert.equal(result.status, 1, result.stderr);
    assert.equal(scope?.severity, 'error');
    assert.equal(
      scope?.message,
      "route POST /todos: scope `auth.usrId` does not resolve against this route's auth type; available: auth.userId, auth.roles, auth.remaining, ip, peer",
    );
  });

  test('scope paths reach into a nested model field; a route that skips the guard loses its paths', () => {
    using app = v2Copy({
      'contracts/auth.ts': auth.replace(
        'export class Principal extends Model({ userId: z.string(),',
        'export class Actor extends Model({ id: z.string() }) {}\n\nexport class Principal extends Model({ actor: Actor.schema, userId: z.string(),',
      ),
      ...withRoute(
        "@Serve(web.get('/stats', { skip: [Authenticate] }), GetStats)",
        "@Serve(web.post('/stats', { skip: [Authenticate], idempotent: { scope: ['auth.actor.id', 'ip'] } }), GetStats)\n@Serve(web.post('/todos/:id/again', { idempotent: { scope: ['auth.actor.id'] } }), CompleteTodo)",
      ),
    });
    const messages = found(check(app.root).json, 'idempotent-scope').map((f) => f.message);

    assert.deepEqual(messages, [
      "route POST /stats: scope `auth.actor.id` does not resolve against this route's auth type; available: auth.remaining, ip, peer",
    ]);
  });

  test('a valid idempotent route has no finding', () => {
    using app = v2Copy(
      withRoute('meta: { cost: 2 }', "meta: { cost: 2 }, idempotent: { scope: ['auth.userId', 'ip'] }"),
    );
    const result = check(app.root);

    assert.deepEqual(
      result.json.findings.filter((f) => f.rule.startsWith('idempotent')),
      [],
    );
  });
});

describe('murmur ctx on idempotent routes', () => {
  test('the route table gains an idempotent column and the protocol bullet names the token mapping', () => {
    using app = v2Copy(
      withRoute(
        'meta: { cost: 2 }',
        "meta: { cost: 2 }, idempotent: { scope: ['auth.userId', 'ip'], ttlMs: 60_000 }",
      ),
    );
    const serves = servesOf(app.root);

    assert.match(serves, /^\| key \| guards \| auth \| via \| idempotent \|$/m);
    assert.match(serves, /^\| POST \/todos \| .* \| method create \| auth\.userId, ip · ttl 1m \|$/m);
    assert.match(serves, /^\| GET \/todos\/:id \| .* \| method show \| — \|$/m);
    assert.match(serves, /`Idempotency-Key`/);
    assert.match(serves, /409 `conflict`/);
    assert.match(serves, /422 `invalid_input`/);
  });

  test('without an idempotent route the table keeps four columns, no protocol bullet, and the forms bullet shows the option', () => {
    const serves = servesOf(v2Fixture);

    assert.match(serves, /^\| key \| guards \| auth \| via \|$/m);
    assert.doesNotMatch(serves, /^- idempotent \(/m);
    assert.match(
      serves,
      /`web\.post\('\/x', \{ idempotent: \{ scope: \['auth\.userId', 'ip'\] \} \}\)` makes client retries/,
    );
  });

  test('rule 6 names the idempotent route option for client retries', () => {
    const result = murmur(['ctx', 'api/rest', '--format', 'json', '--cwd', v2Fixture]);
    const rules = result
      .json<{ sections: { id: string; text: string }[] }>()
      .sections.find((s) => s.id === 'rules');

    assert.match(rules?.text ?? '', /6\. Client retries: `idempotent: \{ scope \}` on the route\./);
  });
});
