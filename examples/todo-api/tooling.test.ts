import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import type { Trace, TraceNode } from '@murmur/dev-protocol';

const root = import.meta.dirname;
const CLI = cliBin();
const PIECES = ['api/feed', 'api/rest', 'auth', 'notifier', 'stats', 'todos'];
const V03_RULES = [
  'On the memory transport events stay in one process; cross-process durable work is `this.jobs.enqueue(Command, input)` inside the transaction.',
  'A business refusal is a returned `reject(status, message, { code, details })`: in a guard, or in any handler whose contract output is `rejectable(...)`. The edge renders it unchanged. `null` is not found. Throw only when the operation did not happen: it is retried, then dead-lettered; `NonRetryableError` when a retry cannot help.',
  'Client retries: `idempotent: { scope }` on the route.',
  '`this.kv.once(delivery.envelope.id, effect)`',
  "Durable or delayed work: `this.jobs.enqueue(C, input, { runAt, dedupeKey, groupKey })`, never a timer; periodic work: `@Handle(C, { every: '1m' })`.",
  "Edges read with `const { params, query, headers, body } = await req.read({...})`, call one contract, and answer with `req.reply(outcome, { status, headers, etag })` or return the outcome. Admission is the route's guards and `meta`; never request a guard from a serve method. Domain pieces know no transport.",
  '`await this.db.transaction(async (tx) => …)`; a nested call joins.',
  'one writer of each table; readers declare the table in context.md',
  '12. Shared pure code lives in `lib/` and is imported as `#lib/x`; a capability is I/O or state, never a helper bag.',
];
const ADA = { authorization: 'Bearer ada' };
const JSON_BODY = { 'content-type': 'application/json' };
const POST_TODOS_INGRESS = { method: 'POST', path: '/todos', binding: 'POST /todos' };

function cliBin(): string {
  const dir = join(root, 'node_modules', '@murmur', 'cli');
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    bin: Record<string, string>;
  };

  return join(dir, manifest.bin['murmur'] ?? 'bin/murmur.ts');
}

async function waitUntil<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await probe();

  while (value === undefined) {
    if (Date.now() > deadline) {
      throw new Error(`${what} (waited ${ms} ms)`);
    }

    await sleep(25);
    value = await probe();
  }

  return value;
}

function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...ADA, ...JSON_BODY },
    body: JSON.stringify(body),
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));

  return port;
}

function copyApp(port: number): { dir: string; [Symbol.dispose](): void } {
  const dir = mkdtempSync(join(tmpdir(), 'todo-api-'));
  cpSync(root, dir, {
    recursive: true,
    filter: (source) => !/[/\\](node_modules|\.murmur)$|todo\.db/.test(source),
  });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, '.env'), [`PORT=${port}`, 'DATABASE_PATH=:memory:', ''].join('\n'));

  return { dir, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

function run(
  args: readonly string[],
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args, '--cwd', cwd], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve) => child.once('exit', (status) => resolve({ status, stdout, stderr })));
}

function devBase(dir: string): string | undefined {
  const file = join(dir, '.murmur', 'dev.json');
  if (!existsSync(file)) {
    return undefined;
  }

  try {
    const lock = JSON.parse(readFileSync(file, 'utf8')) as { host: string; port: number };

    return `http://${lock.host}:${lock.port}`;
  } catch {
    return undefined;
  }
}

interface Dev extends AsyncDisposable {
  readonly child: ChildProcess;
  readonly base: string;
}

async function stopDev(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise((resolve) => child.once('exit', resolve));
  const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  child.kill('SIGTERM');
  await exited;
  clearTimeout(killer);
}

async function startDev(dir: string): Promise<Dev> {
  const child = spawn(process.execPath, [CLI, 'dev', '--no-ui', '--port', '0', '--cwd', dir], {
    cwd: dir,
    stdio: 'ignore',
  });
  const dispose = () => stopDev(child);

  const base = await waitUntil('murmur dev wrote .murmur/dev.json', () => devBase(dir), 30_000).catch(
    async (error: unknown) => {
      await dispose();
      throw error;
    },
  );

  return { child, base, [Symbol.asyncDispose]: dispose };
}

function settled(trace: Trace, deliveries: number): boolean {
  const all = trace.nodes.flatMap((node) => node.deliveries);

  return all.length >= deliveries && all.every((delivery) => delivery.outcome === 'acked');
}

async function settledTrace(devApi: string, traceId: string, deliveries: number): Promise<Trace> {
  return waitUntil(`trace ${traceId} settled with ${deliveries} acked deliveries`, async () => {
    const response = await fetch(`${devApi}/api/traces/${traceId}`);
    if (!response.ok) {
      return undefined;
    }

    const trace = (await response.json()) as Trace;

    return settled(trace, deliveries) ? trace : undefined;
  });
}

function nodeNamed(trace: Trace, name: string): TraceNode {
  const node = trace.nodes.find((candidate) => candidate.envelope.name === name);
  assert.ok(node !== undefined, `trace has ${name}`);

  return node;
}

function outcomes(node: TraceNode): string[][] {
  return node.deliveries.map((delivery) => [delivery.piece, delivery.outcome]).toSorted();
}

async function traceJson(dir: string, traceId: string): Promise<Trace> {
  const result = await run(['trace', traceId, '--json'], dir);
  assert.equal(result.status, 0, result.stderr);

  return JSON.parse(result.stdout) as Trace;
}

function epochMs(ts: string): number {
  return Temporal.Instant.from(ts).epochMilliseconds;
}

function assertPostTrace(trace: Trace): void {
  const ingress = trace.root.envelope;
  const authenticate = nodeNamed(trace, 'auth.Authenticate');
  const rateLimit = nodeNamed(trace, 'auth.RateLimit');
  const create = nodeNamed(trace, 'todos.CreateTodo');
  const created = nodeNamed(trace, 'todos.TodoCreated');

  assert.equal(ingress.name, '$ingress.http');
  assert.deepEqual(ingress.payload, POST_TODOS_INGRESS);
  assert.deepEqual(
    [authenticate, rateLimit, create].map((node) => node.parentId),
    [ingress.id, ingress.id, ingress.id],
  );
  assert.ok(
    epochMs(rateLimit.envelope.ts) >= epochMs(authenticate.envelope.ts),
    'RateLimit was asked after Authenticate',
  );
  assert.deepEqual(outcomes(authenticate), [['auth', 'acked']]);
  assert.deepEqual(outcomes(rateLimit), [['auth', 'acked']]);
  assert.equal(authenticate.reply?.rejected, undefined);
  assert.deepEqual(outcomes(create), [['todos', 'acked']]);
  assert.ok(create.reply !== undefined, 'the responder replied');
  assert.equal(created.parentId, create.id);
  assert.deepEqual(outcomes(created), [
    ['api/feed', 'acked'],
    ['stats', 'acked'],
  ]);
}

function assertAnonymousTrace(trace: Trace): void {
  const authenticate = nodeNamed(trace, 'auth.Authenticate');

  assert.deepEqual(
    trace.nodes.map((node) => node.envelope.name),
    ['$ingress.http', 'auth.Authenticate'],
  );
  assert.equal(authenticate.reply?.rejected, 401);
  assert.deepEqual(
    trace.nodes.flatMap((node) => outcomes(node)),
    [['auth', 'acked']],
  );
}

test(
  'murmur dev and murmur trace show the guards, the responder and the event fan-out',
  { timeout: 120_000 },
  async (t) => {
    const port = await freePort();
    using app = copyApp(port);
    await using dev = await startDev(app.dir);
    const api = `http://127.0.0.1:${port}`;

    await waitUntil(
      `the app under murmur dev answered GET ${api}/healthz`,
      async () => {
        const reply = await fetch(`${api}/healthz`).catch(() => undefined);

        return reply?.ok === true ? true : undefined;
      },
      30_000,
    );

    await t.test(
      'POST /todos: two acked guards in order, the todos responder, TodoCreated acked by stats and api/feed',
      async () => {
        const response = await postJson(api, '/todos', { title: 'trace me' });
        const traceId = response.headers.get('x-murmur-trace') ?? '';
        await settledTrace(dev.base, traceId, 5);
        const human = await run(['trace', traceId], app.dir);

        assert.equal(response.status, 201);
        assertPostTrace(await traceJson(app.dir, traceId));
        assert.equal(human.status, 0, human.stderr);
        assert.match(human.stdout, /^\$ingress\.http {2}\(http\)/m);
        assert.match(human.stdout, /todos\s+attempt 1\s+acked/);
        assert.doesNotMatch(human.stdout, /rejected/);
      },
    );

    await t.test('an anonymous GET: the Authenticate guard rejected 401 and nothing else ran', async () => {
      const response = await fetch(`${api}/todos/t1`);
      const traceId = response.headers.get('x-murmur-trace') ?? '';
      await settledTrace(dev.base, traceId, 1);
      const human = await run(['trace', traceId], app.dir);

      assert.equal(response.status, 401);
      assertAnonymousTrace(await traceJson(app.dir, traceId));
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /reply → \S+\s+rejected 401/);
    });

    await t.test(
      "murmur tail --contract '$ingress.*' lists the HTTP entries and the job deliveries",
      async () => {
        const listed = async () => {
          const tail = await run(['tail', '--contract', '$ingress.*', '--no-follow', '--json'], app.dir);
          assert.equal(tail.status, 0, tail.stderr);

          return tail.stdout
            .trim()
            .split('\n')
            .map((line) => (JSON.parse(line) as { envelope: { name: string; payload: unknown } }).envelope);
        };

        const entries = await waitUntil('murmur tail lists a NotifyTodo job delivery', async () => {
          const found = await listed();

          return found.some((entry) => entry.name === '$ingress.job') ? found : undefined;
        });

        const human = await run(['tail', '--contract', '$ingress.job', '--no-follow'], app.dir);

        assert.ok(entries.every((entry) => ['$ingress.http', '$ingress.job'].includes(entry.name)));
        assert.ok(
          entries.some((entry) => isDeepStrictEqual(entry.payload, POST_TODOS_INGRESS)),
          'the POST /todos entry is listed',
        );
        assert.match(human.stdout, /job notifications\.NotifyTodo\s.*from job\s+→ notifier/);
      },
    );
  },
);

interface Started extends AsyncDisposable {
  output(): string;
}

async function startProcess(dir: string, name: string): Promise<Started> {
  const child = spawn(process.execPath, [CLI, 'start', name, '--cwd', dir], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const dispose = () => stopDev(child);
  const banner = new RegExp(`murmur start {2}pieces=\\d+ {2}pid=\\d+ {2}process=${name}`);

  await waitUntil(
    `murmur start ${name} printed its banner`,
    () => (banner.test(output) ? true : undefined),
    30_000,
  ).catch(async (error: unknown) => {
    await dispose();
    throw new Error(`${(error as Error).message}\n${output}`);
  });

  return { output: () => output, [Symbol.asyncDispose]: dispose };
}

function notified(file: string, id: string): { title: string } | undefined {
  try {
    using db = new DatabaseSync(file, { readOnly: true });

    return db.prepare('SELECT title FROM notifications WHERE todo_id = ?').get(id) as
      | { title: string }
      | undefined;
  } catch {
    return undefined;
  }
}

test(
  'murmur start api and murmur start worker on one file deliver the NotifyTodo job end to end',
  { timeout: 120_000 },
  async () => {
    const port = await freePort();
    using app = copyApp(port);
    const file = join(app.dir, 'shared.db');
    writeFileSync(join(app.dir, '.env'), [`PORT=${port}`, `DATABASE_PATH=${file}`, ''].join('\n'));
    await using api = await startProcess(app.dir, 'api');
    await using worker = await startProcess(app.dir, 'worker');
    const response = await postJson(`http://127.0.0.1:${port}`, '/todos', { title: 'across processes' });
    const todo = (await response.json()) as { id: string };

    const row = await waitUntil('the worker process recorded the notification', () =>
      notified(file, todo.id),
    );

    assert.equal(response.status, 201);
    assert.deepEqual({ ...row }, { title: 'across processes' });
    assert.match(api.output(), /pieces=5 .*process=api/);
    assert.match(worker.output(), /web not started: no loaded piece serves through it/);
    assert.match(worker.output(), /pieces=1 .*process=worker/);
  },
);

function appBin(name: string): string {
  return join(root, 'node_modules', '.bin', name);
}

test(
  'tooling: catalog, check, ctx, coverage, lint and typecheck are clean',
  { timeout: 180_000 },
  async (t) => {
    await t.test('murmur catalog --strict exits 0 and todos is one piece with 6 handlers', async () => {
      const strict = await run(['catalog', '--strict'], root);
      const json = await run(['catalog', '--json'], root);
      const pieces = (JSON.parse(json.stdout) as { pieces: { name: string; handles: string[] }[] }).pieces;
      const todos = pieces.filter((piece) => piece.name.startsWith('todos'));

      assert.equal(strict.status, 0, strict.stdout + strict.stderr);
      assert.deepEqual(
        todos.map((piece) => [piece.name, piece.handles.length]),
        [['todos', 6]],
      );
    });

    await t.test('murmur check exits 0 with no findings, so no sizing warning', async () => {
      const result = await run(['check', '--json'], root);

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual((JSON.parse(result.stdout) as { findings: unknown[] }).findings, []);
    });

    for (const id of PIECES) {
      await t.test(
        `murmur ctx ${id} is in the ok tier, carries every v0.3 rule and names no ctx.* handle`,
        async () => {
          const result = await run(['ctx', id, '--format', 'json'], root);
          const brief = JSON.parse(result.stdout) as {
            sizing: string;
            sections: { id: string; text: string }[];
          };
          const rules = brief.sections.find((section) => section.id === 'rules')?.text ?? '';

          assert.equal(result.status, 0, result.stderr);
          assert.equal(brief.sizing, 'ok');
          assert.doesNotMatch(result.stdout, /\bctx\.\w/);

          for (const rule of V03_RULES) {
            assert.ok(rules.includes(rule), `${id} rules lack: ${rule}`);
          }
        },
      );
    }

    await t.test('murmur test todos --coverage passes and reports the todos piece', async () => {
      const result = await run(['test', 'todos', '--coverage', '--json'], root);
      const summary = JSON.parse(result.stdout) as {
        passed: number;
        failed: number;
        coverage: { file: string; linePercent: number }[];
      };

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(summary.failed, 0);
      assert.ok(summary.passed > 0);
      assert.ok(summary.coverage.some((entry) => entry.file === 'pieces/todos/piece.ts'));
    });

    await t.test('murmur doctor exits 0', async () => {
      const result = await run(['doctor'], root);

      assert.equal(result.status, 0, result.stdout + result.stderr);
    });

    await t.test('oxlint, oxfmt --check and tsc exit 0 in the app', () => {
      for (const [bin, args] of [
        ['oxlint', []],
        ['oxfmt', ['--check']],
        ['tsc', ['-p', 'tsconfig.json']],
      ] as const) {
        const result = spawnSync(appBin(bin), args, { cwd: root, encoding: 'utf8' });

        assert.equal(result.status, 0, `${bin}: ${result.stdout}${result.stderr}`);
      }
    });
  },
);
