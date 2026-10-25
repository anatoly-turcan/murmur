import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cursor } from '@murmur/node/lib';
import { testPiece } from '@murmur/node/testing';
import { isRejection } from 'murmur';

import { NotifyTodo } from '#contracts/notifications';
import {
  CompleteTodo,
  CreateTodo,
  GetTodo,
  ListTodos,
  RemoveTodo,
  SearchTodos,
  TodoCompleted,
  TodoCreated,
  TodoRemoved,
} from '#contracts/todos';

import createTodo from './fixtures/create-todo.json' with { type: 'json' };
import { Todos } from './piece.ts';

test('create stores the todo, replies with it and emits TodoCreated', async () => {
  await using t = await testPiece(Todos);
  const todo = await t.deliverJson(CreateTodo, createTodo);
  const stored = await t.needs.db.get('SELECT title, done FROM todos WHERE id = ?', todo.id);

  assert.deepEqual(todo, { id: t.ids.issued[0], title: 'buy milk', done: false });
  assert.deepEqual(t.emitted(TodoCreated), [{ id: todo.id, title: 'buy milk' }]);
  assert.deepEqual(stored, { title: 'buy milk', done: 0 });
});

test('create enqueues one NotifyTodo with the insert; a redelivery enqueues nothing', async () => {
  await using t = await testPiece(Todos);
  const todo = await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1' });
  await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1', attempt: 2 });

  assert.deepEqual(t.enqueued(NotifyTodo), [
    { input: { id: todo.id, title: 'buy milk' }, options: { dedupeKey: `notify:${todo.id}` } },
  ]);
});

test('create refuses an empty title before the handler runs', async () => {
  await using t = await testPiece(Todos);
  await assert.rejects(t.deliver(CreateTodo, { title: '' }), { name: 'ContractViolationError' });
  assert.equal(t.emitted().length, 0);
});

test('a redelivered create inserts once, emits once and replies the same todo', async () => {
  await using t = await testPiece(Todos);
  const first = await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1' });
  const again = await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1', attempt: 2 });

  assert.deepEqual(again, first);
  assert.equal(t.emitted(TodoCreated).length, 1);
  assert.deepEqual(await t.needs.db.all('SELECT id FROM todos'), [{ id: first.id }]);
});

test('a create redelivered after its todo was removed replies the same id and inserts nothing', async () => {
  await using t = await testPiece(Todos);
  const first = await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1' });
  await t.deliver(RemoveTodo, { id: first.id });
  const again = await t.deliverJson(CreateTodo, createTodo, { envelopeId: 'req-1', attempt: 2 });

  assert.deepEqual(again, first);
  assert.equal(t.emitted(TodoCreated).length, 1);
  assert.deepEqual(await t.needs.db.all('SELECT id FROM todos'), []);
});

test('get and list read what create stored', async () => {
  await using t = await testPiece(Todos);
  const milk = await t.deliver(CreateTodo, { title: 'milk' });
  const bread = await t.deliver(CreateTodo, { title: 'bread' });
  assert.deepEqual(await t.deliver(GetTodo, { id: milk.id }), milk);
  assert.equal(await t.deliver(GetTodo, { id: 'nope' }), null);
  assert.deepEqual(await t.deliver(ListTodos, {}), { data: [milk, bread], next_cursor: null });
});

test('list pages by limit and next_cursor; a cursor of another filter or a garbled one is 400 invalid_cursor', async () => {
  await using t = await testPiece(Todos);
  const milk = await t.deliver(CreateTodo, { title: 'milk' });
  const bread = await t.deliver(CreateTodo, { title: 'bread' });
  const jam = await t.deliver(CreateTodo, { title: 'jam' });
  const first = await t.deliver(ListTodos, { limit: 2 });
  assert.ok(!isRejection(first));
  const second = await t.deliver(ListTodos, { limit: 2, cursor: first.next_cursor });
  const foreign = await t.deliver(ListTodos, { done: false, cursor: first.next_cursor });
  const garbled = await t.deliver(ListTodos, { cursor: 'nope' });

  assert.deepEqual(first.data, [milk, bread]);
  assert.match(first.next_cursor ?? '', /^[\w-]+$/);
  assert.deepEqual(second, { data: [jam], next_cursor: null });
  assert.equal(isRejection(foreign) && foreign.code, 'invalid_cursor');
  assert.equal(isRejection(garbled) && garbled.status, 400);
});

test('list answers 400 invalid_cursor to a cursor with a valid checksum but the wrong position shape', async () => {
  await using t = await testPiece(Todos);
  await t.deliver(CreateTodo, { title: 'milk' });

  const positions = [{ a: 1 }, 'x', [1], ['a', 'b', 'c'], ['2026-10-25', 1.5]];

  const forged = await Promise.all(
    positions.map((p) => t.deliver(ListTodos, { cursor: cursor.encode('todos.ListTodos:all', p) })),
  );

  assert.deepEqual(
    forged.map((reply) => isRejection(reply) && reply.code),
    positions.map(() => 'invalid_cursor'),
  );
});

test('search replies the todos whose title contains q, ignoring case, in creation order', async () => {
  await using t = await testPiece(Todos);
  const milk = await t.deliver(CreateTodo, { title: 'buy Milk' });
  await t.deliver(CreateTodo, { title: 'bread' });
  const oatMilk = await t.deliver(CreateTodo, { title: 'oat milk' });
  assert.deepEqual(await t.deliver(SearchTodos, { q: 'milk' }), [milk, oatMilk]);
  assert.deepEqual(await t.deliver(SearchTodos, { q: '%' }), []);
  await assert.rejects(t.deliver(SearchTodos, { q: '' }), { name: 'ContractViolationError' });
});

test('complete marks the todo done once and emits TodoCompleted once', async () => {
  await using t = await testPiece(Todos);
  const milk = await t.deliver(CreateTodo, { title: 'milk' });
  const done = await t.deliver(CompleteTodo, { id: milk.id });

  assert.deepEqual(done, { ...milk, done: true });
  assert.deepEqual(await t.deliver(CompleteTodo, { id: milk.id }), done);
  assert.deepEqual(t.emitted(TodoCompleted), [{ id: milk.id }]);
  assert.deepEqual(await t.deliver(ListTodos, { done: false }), { data: [], next_cursor: null });
});

test('complete of an unknown id replies null and emits nothing', async () => {
  await using t = await testPiece(Todos);
  assert.equal(await t.deliver(CompleteTodo, { id: 'nope' }), null);
  assert.equal(t.emitted().length, 0);
});

test('remove replies the removed todo, emits TodoRemoved, and replies null the second time', async () => {
  await using t = await testPiece(Todos);
  const milk = await t.deliver(CreateTodo, { title: 'milk' });
  assert.deepEqual(await t.deliver(RemoveTodo, { id: milk.id }), milk);
  assert.equal(await t.deliver(RemoveTodo, { id: milk.id }), null);
  assert.deepEqual(t.emitted(TodoRemoved), [{ id: milk.id }]);
  assert.equal(await t.deliver(GetTodo, { id: milk.id }), null);
});
