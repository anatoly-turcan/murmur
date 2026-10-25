import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EmitNotDeclaredError, NoHandlerError } from '@murmur/node';
import { createTestRuntime, fakeSqlite, loadSubtree, testPiece } from '@murmur/node/testing';
import { Piece } from 'murmur';

import { AuditReport } from '../fixtures/v2/app/contracts/audit.ts';
import {
  ArchiveTodo,
  CountTodos,
  CreateTodo,
  GetTodo,
  ProbeNesting,
  TodoCreated,
  WriteRequested,
} from '../fixtures/v2/app/contracts/todos.ts';
import { Audit } from '../fixtures/v2/app/pieces/audit/piece.ts';
import { Invoices } from '../fixtures/v2/app/pieces/billing/invoice/piece.ts';
import { Todos } from '../fixtures/v2/app/pieces/todos/piece.ts';
import { Poller } from '../fixtures/v2/poller/pieces/poller/piece.ts';
import { eventually } from '../helpers.ts';

const SCHEMA = readFileSync(new URL('../fixtures/v2/app/pieces/todos/schema.sql', import.meta.url), 'utf8');

async function storage() {
  const db = await fakeSqlite();
  await db.exec(SCHEMA);

  return db;
}

test('a handler that awaits the database and then emits works under testPiece', async () => {
  const db = await storage();
  await using t = await testPiece(Todos, { needs: { db } });
  const todo = await t.deliver(CreateTodo, { title: 'milk' });

  assert.deepEqual(todo, { id: t.ids.issued[0], title: 'milk' });
  assert.deepEqual(t.emitted(TodoCreated), [todo]);
  assert.deepEqual(await db.get('SELECT title FROM todos WHERE id = ?', todo.id), { title: 'milk' });
});

test('two concurrent t.deliver calls do not cross-wire emits', async () => {
  await using t = await testPiece(Todos, { needs: { db: await storage() } });

  await Promise.all([
    t.deliver(CreateTodo, { title: 'first' }, { envelopeId: 'req-1' }),
    t.deliver(CreateTodo, { title: 'second' }, { envelopeId: 'req-2' }),
  ]);

  const byCause = t.emitted().map((e) => [e.causationId, (e.payload as { title: string }).title]);

  assert.deepEqual(byCause.toSorted(), [
    ['req-1', 'first'],
    ['req-2', 'second'],
  ]);
});

test('fakeSqlite joins the delivery transaction and a nested transaction(fn) joins it too', async () => {
  await using t = await testPiece(Todos, { needs: { db: await storage() } });
  assert.deepEqual(await t.deliver(ProbeNesting, {}), { joined: 2, kept: 0 });
});

test('concurrent deliveries each hold their own transaction on one fakeSqlite', async () => {
  const db = await storage();
  await using t = await testPiece(Todos, { needs: { db } });
  await Promise.all(Array.from({ length: 8 }, (_, n) => t.deliver(WriteRequested, { n })));
  assert.deepEqual(await db.get('SELECT count(*) AS rows FROM writes'), { rows: 16 });
});

test('timers opened in onStart under testPiece do not share a transaction after the hook returned', async () => {
  const db = await fakeSqlite();

  await db.exec(
    readFileSync(new URL('../fixtures/v2/poller/pieces/poller/schema.sql', import.meta.url), 'utf8'),
  );

  await using t = await testPiece(Poller, { needs: { db } });
  await t.start();
  await eventually(async () => (await db.all('SELECT tick FROM outcomes')).length === 3);

  assert.deepEqual(await db.all('SELECT tick, outcome FROM outcomes ORDER BY tick'), [
    { tick: 'committed', outcome: 'ok' },
    { tick: 'plain', outcome: 'ok' },
    { tick: 'rolled-back', outcome: 'Error: rolled back' },
  ]);

  assert.deepEqual(await db.all('SELECT v FROM ticks ORDER BY v'), [{ v: 'committed' }, { v: 'plain' }]);
});

test('deliver refuses an invalid input before the handler runs and an unhandled contract with NoHandlerError', async () => {
  await using t = await testPiece(Todos, { needs: { db: await storage() } });
  await assert.rejects(t.deliver(CreateTodo, { title: '' }), { name: 'ContractViolationError' });
  await assert.rejects(t.deliver(AuditReport, {}), NoHandlerError);
  assert.equal(t.emitted().length, 0);
});

test('emit of an undeclared same-shape event throws with the piece and the wire name', async () => {
  await using t = await testPiece(Todos, { needs: { db: await storage() }, id: 'todos' });

  await assert.rejects(
    t.deliver(ArchiveTodo, { id: '1' }),
    (error: unknown) =>
      error instanceof EmitNotDeclaredError &&
      error.message.startsWith('piece todos emits todos.TodoArchived but does not declare it'),
  );
});

test('config, onStart requests, respond and requested work together', async () => {
  await using t = await testPiece(Audit, { config: { label: 'ops' } });
  t.respond(CountTodos, () => ({ total: 3 }));
  await t.start();
  assert.deepEqual(await t.deliver(AuditReport, {}), { label: 'ops', todosAtStart: 3, seen: 0 });
  assert.deepEqual(t.requested(CountTodos), [{}]);
  assert.equal(t.log.records[0]?.message, 'audit started');
});

test('per-process state lives on t.piece across deliveries; an internal event is emitted and handled', async () => {
  await using t = await testPiece(Invoices);
  await t.deliver(TodoCreated, { id: 't1', title: 'milk' });

  assert.equal(t.emitted().length, 1);
  assert.equal(t.piece instanceof Invoices, true);
});

test('options are required exactly when the declaration has config; needs are faked when left out', async () => {
  await using todos = await testPiece(Todos);
  // @ts-expect-error a missing config object when Audit declares config
  const audit = await testPiece(Audit);

  assert.deepEqual(await todos.deliver(CreateTodo, { title: 'milk' }), {
    id: todos.ids.issued[0],
    title: 'milk',
  });

  assert.equal(audit.piece instanceof Audit, true);
});

class Lifecycle extends Piece({}) {
  readonly calls: string[] = [];

  onStart(): void {
    this.calls.push('start');
  }

  onStop(): void {
    this.calls.push('stop');
  }
}

test('dispose runs onStop only after start ran', async () => {
  const idle = await testPiece(Lifecycle);
  await idle[Symbol.asyncDispose]();
  const used = await testPiece(Lifecycle);
  await used.start();
  await used[Symbol.asyncDispose]();

  assert.deepEqual([idle.piece.calls, used.piece.calls], [[], ['start', 'stop']]);
});

test('loadSubtree returns class pieces and createTestRuntime runs them on the bus', async () => {
  const todosFolder = fileURLToPath(new URL('../fixtures/v2/app/pieces/todos', import.meta.url));
  const pieces = await loadSubtree(todosFolder);
  await using rt = await createTestRuntime({ pieces, capabilities: { sqlite: await storage() } });
  const created = await rt.request(CreateTodo, { title: 'milk' });
  await rt.idle();

  assert.equal(pieces['todos'], Todos);
  assert.equal(await rt.request(GetTodo, { id: created.id }).then((todo) => todo?.title), 'milk');
  assert.deepEqual(rt.emitted(TodoCreated), [created]);
});

test('createTestRuntime names a class piece whose capability is missing', async () => {
  await assert.rejects(createTestRuntime({ pieces: [Todos] }), /todos needs sqlite \(needs\.db\)/);
});
