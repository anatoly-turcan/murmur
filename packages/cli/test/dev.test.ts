import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type {
  ContextResponse,
  EmitResponse,
  Frame,
  HealthResponse,
  Trace,
  TreeNode,
} from '@murmur/dev-protocol';

import { cli, copyFixtureApp, getJson, openEvents, postJson, startDev, waitUntil } from './dev-helpers.ts';

type FrameOf<K extends Frame['frame']> = Extract<Frame, { frame: K }>;

const is =
  <K extends Frame['frame']>(kind: K, extra: (frame: FrameOf<K>) => boolean = () => true) =>
  (frame: Frame): frame is FrameOf<K> =>
    frame.frame === kind && extra(frame as FrameOf<K>);

const sysEnv = (name: string, piece: string) =>
  is('env', (f) => f.envelope.name === `$sys.${name}` && f.meta.piece === piece);

function settled(trace: Trace): boolean {
  const deliveries = trace.nodes.flatMap((node) => node.deliveries);

  return trace.nodes.length >= 4 && deliveries.length >= 4 && deliveries.every((d) => d.outcome === 'acked');
}

function treeIds(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...treeIds(node.children)]);
}

test('murmur dev serves the fixture app end to end', { timeout: 120_000 }, async (t) => {
  using app = copyFixtureApp();
  const dev = await startDev(app.root);
  t.after(() => dev.child.kill('SIGKILL'));
  const events = await openEvents(`${dev.base}/api/events`);
  t.after(() => events.close());
  let traceId = '';

  await t.test('/api/health answers', async () => {
    const { status, body } = await getJson<HealthResponse>(`${dev.base}/api/health`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.protocol, 1);
    assert.equal(body.pid, dev.child.pid);
  });

  await t.test('SSE opens with hello', async () => {
    assert.equal((await events.next(is('hello'))).protocol, 1);
    await events.next(is('dev.boot'));
  });

  await t.test('a second murmur dev on the same root exits 5', async () => {
    const second = await cli(['dev', '--no-ui', '--port', '0', '--cwd', app.root], app.root);
    assert.equal(second.status, 5, second.stderr);
  });

  await t.test('POST /api/emit in request mode returns the reply', async () => {
    const { status, body } = await postJson<EmitResponse>(`${dev.base}/api/emit`, {
      contract: 'todos.create.requested',
      payload: { title: 'write M7' },
      mode: 'request',
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(Object.keys(body.reply as object).toSorted(), ['id', 'title']);
    assert.equal((body.reply as { title: string }).title, 'write M7');
    assert.match(body.envelopeId, /^[0-9a-f-]{36}$/);
    traceId = body.traceId;
  });

  await t.test('SSE delivers env frames with meta.piece filled', async () => {
    const created = await events.next(is('env', (f) => f.envelope.name === 'todos.created'));
    assert.equal(created.meta.piece, 'todos/create');
    assert.equal(created.meta.internal, false);
    const acked = await events.next(sysEnv('delivery.acked', 'audit'));
    assert.equal(acked.meta.internal, true);
    assert.equal(acked.meta.attempt, 1);
  });

  await t.test('GET /api/traces/:id has the root and acked child nodes', async () => {
    const trace = await waitUntil(async () => {
      const { status, body } = await getJson<Trace>(`${dev.base}/api/traces/${traceId}`);

      return status === 200 && settled(body) ? body : undefined;
    });

    assert.equal(trace.root.envelope.name, 'todos.create.requested');
    const names = trace.nodes.map((node) => node.envelope.name);
    assert.ok(names.includes('todos.created') && names.includes('audit.recorded'), names.join());
    const created = trace.nodes.find((node) => node.envelope.name === 'todos.created');
    assert.equal(created?.parentId, trace.root.envelope.id);
    assert.ok(trace.nodes.find((node) => node.id === trace.root.envelope.id)?.reply);
  });

  await t.test('GET /api/tree returns the folder tree', async () => {
    const { body } = await getJson<TreeNode[]>(`${dev.base}/api/tree`);
    const ids = treeIds(body);

    for (const id of ['todos', 'todos/create', 'todos/query', 'audit', 'audit/archive', 'slow']) {
      assert.ok(ids.includes(id), `${id} missing from ${ids.join()}`);
    }

    const todos = body.find((node) => node.id === 'todos');
    assert.equal(todos?.kind, 'group');
  });

  await t.test('?since= replays from the buffer', async () => {
    const replay = await openEvents(`${dev.base}/api/events?since=0`);

    try {
      const hello = await replay.next(is('hello'));
      assert.equal(hello.frame, 'hello');

      await replay.next(
        is('env', (f) => f.envelope.name === 'todos.created' && f.envelope.traceId === traceId),
      );
    } finally {
      replay.close();
    }
  });

  await t.test('murmur tail --no-follow --json prints NDJSON frames', async () => {
    const tail = await cli(['tail', '--no-follow', '--json', '--cwd', app.root], app.root);
    assert.equal(tail.status, 0, tail.stderr);
    const frames = tail.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Frame);
    assert.ok(frames.length > 0);
    assert.ok(frames.every((frame) => frame.frame === 'env'));
    assert.ok(frames.some((frame) => frame.frame === 'env' && frame.envelope.name === 'todos.created'));
  });

  await t.test('murmur trace <prefix> renders the waterfall', async () => {
    const trace = await cli(['trace', traceId.slice(0, 8), '--cwd', app.root], app.root);
    assert.equal(trace.status, 0, trace.stderr);
    assert.match(trace.stdout, new RegExp(`^trace ${traceId.slice(0, 8)}`));
    assert.match(trace.stdout, /todos\.create\.requested/);
    assert.match(trace.stdout, /todos\/create\s+attempt 1\s+acked/);
    assert.match(trace.stdout, /├█*┤/);
    assert.match(trace.stdout, /reply → /);
  });

  await t.test('murmur emit exits 1 on a schema-invalid payload and 2 on an unknown contract', async () => {
    const invalid = await cli(
      ['emit', 'todos.create.requested', '--payload', '{"title":1}', '--request', '--cwd', app.root],
      app.root,
    );

    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /ContractViolationError/);
    const unknown = await cli(['emit', 'nope.never', '--cwd', app.root], app.root);
    assert.equal(unknown.status, 2, unknown.stderr);
  });

  await t.test('touching a piece restarts after the in-flight delivery drained', async () => {
    const emitted = await postJson(`${dev.base}/api/emit`, {
      contract: 'slow.requested',
      payload: { ms: 2_500 },
      mode: 'emit',
    });

    assert.equal(emitted.status, 200, JSON.stringify(emitted.body));
    await events.next(sysEnv('delivery.received', 'slow'));
    // §12 asks for a 2.5 s in-flight delivery but devStopPolicy.graceMs is 2000: touch 0.7 s in so the rest fits the grace.
    await sleep(700);
    const file = join(app.root, 'pieces', 'audit', 'piece.ts');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);
    const restart = await events.next(is('dev.restart'));
    assert.ok(
      restart.reason.some((path) => path.endsWith('pieces/audit/piece.ts')),
      restart.reason.join(),
    );
    await events.next(sysEnv('delivery.acked', 'slow'), 10_000);
    const exit = await events.next(is('dev.child_exit'), 10_000);
    assert.equal(exit.drained, true);
    const boot = await events.next(is('dev.boot'), 20_000);
    assert.ok(boot.snapshot.pieces.some((piece) => piece.name === 'slow' && piece.status === 'running'));
  });

  await t.test('a broken piece.ts reports boot_failed while static routes answer', async () => {
    writeFileSync(
      join(app.root, 'pieces', 'audit', 'archive', 'piece.ts'),
      'export class Broken extends Piece(\n',
    );
    const failed = await events.next(is('dev.boot_failed'), 20_000);
    assert.equal(failed.report.ok, false);
    assert.ok(failed.report.errors.length > 0);
    const health = await getJson<HealthResponse>(`${dev.base}/api/health`);
    assert.equal(health.body.ok, true);

    const context = await getJson<ContextResponse>(
      `${dev.base}/api/pieces/${encodeURIComponent('audit/archive')}/context`,
    );

    assert.equal(context.status, 200);
    assert.match(context.body.markdown, /audit\/archive/);
  });

  await t.test('SIGINT exits 0 and removes the lock', async () => {
    dev.child.kill('SIGINT');
    assert.equal(await dev.exited, 0, dev.output());
    assert.equal(existsSync(join(app.root, '.murmur', 'dev.json')), false);
  });
});
