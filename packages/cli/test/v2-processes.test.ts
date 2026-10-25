import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { murmur } from './helpers.ts';
import { check, found, v2Copy } from './v2-helpers.ts';

function config(processes: string, transport = '() => createMemoryTransport()'): string {
  return [
    "import { defineApp } from '@murmur/node';",
    "import { sqlite } from '@murmur/node/capabilities';",
    "import { createMemoryTransport } from '@murmur/transport-memory';",
    '',
    'export default defineApp({',
    "  name: 'todo-api',",
    `  transport: ${transport},`,
    '  capabilities: [sqlite],',
    `  processes: ${processes},`,
    '});',
    '',
  ].join('\n');
}

const SPLIT = "{ api: { pieces: ['api/**', 'auth'] }, worker: { pieces: ['todos', 'stats'] } }";
const TOGETHER = "{ api: { pieces: ['api/**', 'auth', 'todos', 'stats'] }, worker: { pieces: ['stats'] } }";
const AMQP = "() => { throw new Error('amqp in production'); }";
const BY_ENV = '() => (process.env.AMQP_URL ? createAmqpTransport() : createMemoryTransport())';

function messages(root: string, rule: string): string[] {
  return found(check(root).json, rule).map((f) => `${f.severity} ${f.file}: ${f.message}`);
}

describe('processes in check and ctx', () => {
  test('a split map fires request-crosses-process and event-crosses-process naming the allowed forms', () => {
    using app = v2Copy({ 'murmur.config.ts': config(SPLIT) });
    const requests = messages(app.root, 'request-crosses-process');

    assert.ok(
      requests.includes(
        'error pieces/api/rest/piece.ts: api/rest requests todos.GetTodo, handled only in process `worker`; host the handler in `api` too, or make the work a job (`this.jobs.enqueue`)',
      ),
      requests.join('\n'),
    );
    assert.ok(
      requests.some((line) => line.includes('requests stats.GetStats, handled only in process `worker`')),
    );
    assert.ok(
      requests.every((line) => !line.includes('auth.Authenticate')),
      requests.join('\n'),
    );

    assert.deepEqual(messages(app.root, 'event-crosses-process'), [
      'warn pieces/api/feed/piece.ts: api/feed subscribes todos.TodoCompleted, emitted only in `worker`; on the memory transport events stay in one process; use `this.jobs.enqueue` for cross-process work',
      'warn pieces/api/feed/piece.ts: api/feed subscribes todos.TodoCreated, emitted only in `worker`; on the memory transport events stay in one process; use `this.jobs.enqueue` for cross-process work',
      'warn pieces/api/feed/piece.ts: api/feed subscribes todos.TodoRemoved, emitted only in `worker`; on the memory transport events stay in one process; use `this.jobs.enqueue` for cross-process work',
    ]);
  });

  test('a guard handled in another process is a crossing for the edge that serves the route', () => {
    using app = v2Copy({
      'murmur.config.ts': config(
        "{ api: { pieces: ['api/**', 'todos', 'stats'] }, auth: { pieces: ['auth'] } }",
      ),
    });

    assert.ok(
      messages(app.root, 'request-crosses-process').some((line) =>
        line.includes(
          'api/rest requests auth.Authenticate, handled only in process `auth`; host the handler in `api` too',
        ),
      ),
    );
  });

  test('both checks stay silent on a transport that crosses processes', () => {
    using app = v2Copy({ 'murmur.config.ts': config(SPLIT, AMQP) });
    const result = check(app.root).json;

    assert.deepEqual(found(result, 'request-crosses-process'), []);
    assert.deepEqual(found(result, 'event-crosses-process'), []);
  });

  test('a config that picks the transport by env is not treated as memory', () => {
    using app = v2Copy({ 'murmur.config.ts': config(SPLIT, BY_ENV) });

    assert.deepEqual(found(check(app.root).json, 'request-crosses-process'), []);
  });

  test('a process whose globs match no piece id is a process-invalid error naming the id form', () => {
    using app = v2Copy({
      'murmur.config.ts': config(
        "{ api: { pieces: ['api/**', 'auth', 'todos', 'stats'] }, worker: { pieces: ['pieces/notifier/**'] } }",
      ),
    });

    assert.deepEqual(messages(app.root, 'process-invalid'), [
      "error murmur.config.ts: processes.worker.pieces ['pieces/notifier/**'] matches no piece; globs are piece ids (pieces/<id>/piece.ts → '<id>'), e.g. pieces: ['api/feed', 'api/feed/**']",
    ]);
  });

  test('ctx prints the Process line: hosts, reachability and the start command', () => {
    using split = v2Copy({ 'murmur.config.ts': config(SPLIT) });
    const rest = murmur(['ctx', 'api/rest', '--cwd', split.root]).stdout;

    assert.match(
      rest,
      /^- process: `api` \(requests not handled here: `todos\.CreateTodo`, .*`stats\.GetStats`\) · run: `pnpm exec murmur start api`$/m,
    );

    using together = v2Copy({ 'murmur.config.ts': config(TOGETHER) });

    assert.match(
      murmur(['ctx', 'api/rest', '--cwd', together.root]).stdout,
      /^- process: `api` \(requests: all 8 handled here\) · run: `pnpm exec murmur start api`$/m,
    );
    assert.match(
      murmur(['ctx', 'stats', '--cwd', together.root]).stdout,
      /^- process: `api`, `worker` · run: `pnpm exec murmur start <process>`$/m,
    );

    using lonely = v2Copy({ 'murmur.config.ts': config("{ api: { pieces: ['api/**', 'auth', 'todos'] } }") });

    assert.match(
      murmur(['ctx', 'stats', '--cwd', lonely.root]).stdout,
      /^- process: none \(no defineApp\(\{ processes \}\) entry lists `stats`; only `pnpm exec murmur start` without a name loads it\)$/m,
    );
  });

  test('an app without processes has no Process line and no crossing findings', () => {
    using app = v2Copy();

    assert.doesNotMatch(murmur(['ctx', 'api/rest', '--cwd', app.root]).stdout, /^- process:/m);
    assert.deepEqual(found(check(app.root).json, 'request-crosses-process'), []);
  });
});
