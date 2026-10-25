import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  Command,
  contractKind,
  Event,
  Guard,
  isContract,
  isModel,
  isRequestClass,
  Model,
  MurmurError,
  Query,
  reject,
  Rejection,
} from 'murmur';
import { z } from 'zod';

import { Authenticate, Principal, RateLimit, ResolveTarget } from './fixtures/v2/contracts/auth.ts';
import {
  CountTodos,
  CreateTodo,
  GetTodo,
  ListTodos,
  Todo,
  TodoCreated,
} from './fixtures/v2/contracts/todos.ts';

test('contract classes carry their kind, schemas and file as statics', () => {
  assert.equal(CreateTodo.kind, 'command');
  assert.equal(GetTodo.kind, 'query');
  assert.equal(TodoCreated.kind, 'event');
  assert.equal(Authenticate.kind, 'guard');
  assert.equal(TodoCreated.output, undefined);
  assert.equal(CreateTodo.input.parse({ title: 'milk' }).title, 'milk');
  assert.deepEqual(CreateTodo.output.parse({ id: '1', title: 'milk', done: false, extra: 1 }), {
    id: '1',
    title: 'milk',
    done: false,
  });
  assert.equal(CreateTodo.description, undefined);
});

test('an instance built from parsed input is the contract and carries its fields', () => {
  const input = new CreateTodo(CreateTodo.input.parse({ title: 'milk' }));

  assert.equal(input instanceof CreateTodo, true);
  assert.equal(input.title, 'milk');
});

test('a raw shape and a z.object input are equivalent, defaults included', () => {
  assert.deepEqual(CountTodos.input.parse({}), { done: false });
  assert.deepEqual(ListTodos.input.parse({}), {});
  assert.equal(CreateTodo.input.safeParse({ title: '' }).success, false);
});

test('Todo.nullable() and Todo.array() export anyOf and items in JSON Schema', () => {
  const nullable = GetTodo.jsonSchema();
  const list = ListTodos.jsonSchema();

  assert.equal(nullable.name, 'todos.GetTodo');
  const branches = nullable.output?.['anyOf'] as object[];
  const items = list.output?.['items'] as Record<string, unknown>;

  assert.equal(branches.length, 2);
  assert.deepEqual(branches[1], { type: 'null' });
  assert.equal(list.output?.['type'], 'array');
  assert.equal(items['type'], 'object');
  assert.equal(Todo.nullable().parse(null), null);
  assert.deepEqual(Todo.array().parse([]), []);
});

test('an event JSON Schema has no output', () => {
  const schema = TodoCreated.jsonSchema();

  assert.equal(schema.name, 'todos.TodoCreated');
  assert.equal('output' in schema, false);
  assert.equal(schema.input['type'], 'object');
});

test('Guard(Principal) answers the model or a Rejection, and Rejection.schema parses reject()', () => {
  const rejection = reject(401, 'x');

  assert.deepEqual(Rejection.schema.parse(rejection), { status: 401, code: 'unauthorized', message: 'x' });
  assert.deepEqual(Authenticate.output.parse(rejection), rejection);
  assert.deepEqual(Authenticate.output.parse({ userId: 'ada', roles: [] }), { userId: 'ada', roles: [] });
  assert.equal(Authenticate.output.safeParse({ nope: true }).success, false);
  assert.equal(Authenticate.model, Principal);
  assert.deepEqual(
    Authenticate.input.parse({
      transport: 'http',
      operation: 'GET /x',
      headers: {},
      params: {},
      peer: '10.0.0.1',
      ip: '10.0.0.1',
    }),
    {
      transport: 'http',
      operation: 'GET /x',
      headers: {},
      params: {},
      peer: '10.0.0.1',
      ip: '10.0.0.1',
      meta: {},
      prior: {},
    },
  );
});

test('Guard(Output, { after, optional, meta }) keeps the lists and parses meta with defaults, dropping keys it does not read', () => {
  const input = ResolveTarget.input.parse({
    transport: 'http',
    operation: 'GET /items/:id',
    headers: {},
    params: { id: '7' },
    peer: '10.0.0.1',
    ip: '10.0.0.1',
    meta: { target: 'item', allowDeleted: true },
    prior: { userId: 'ada', roles: [] },
  });

  assert.deepEqual(ResolveTarget.after, [Authenticate]);
  assert.deepEqual(ResolveTarget.optional, [RateLimit]);
  assert.deepEqual(Object.keys(ResolveTarget.meta.shape), ['target', 'role']);
  assert.deepEqual(input.meta, { target: 'item', role: 'viewer' });
  assert.deepEqual(input.prior, { userId: 'ada', roles: [] });
  assert.deepEqual(Authenticate.after, []);
  assert.throws(() => Guard(Principal, { after: [Principal as never] }), {
    message: 'Guard() after lists Guard classes, got Principal',
  });
});

test('reject() carries headers for the edge to apply', () => {
  assert.deepEqual(reject(429, 'slow', { headers: { 'retry-after': '30' } }), {
    status: 429,
    code: 'rate_limited',
    message: 'slow',
    headers: { 'retry-after': '30' },
  });
});

test('reject() defaults the code from the status and keeps details', () => {
  assert.equal(reject(403, 'no').code, 'forbidden');
  assert.equal(reject(429, 'slow down').code, 'rate_limited');
  assert.equal(reject(418, 'teapot').code, 'http_418');
  assert.deepEqual(reject(429, 'slow', { code: 'quota', details: { perMinute: 60 } }), {
    status: 429,
    code: 'quota',
    message: 'slow',
    details: { perMinute: 60 },
  });
  assert.throws(() => reject(200, 'fine'), MurmurError);
});

test('isContract, isModel and contractKind recognise contract and model classes', () => {
  assert.equal(isContract(CreateTodo), true);
  assert.equal(isContract(Todo), false);
  assert.equal(isContract({ kind: 'query', input: z.object({}) }), false);
  assert.equal(isModel(Todo), true);
  assert.equal(isModel(Principal), true);
  assert.equal(isModel(CreateTodo), false);
  assert.equal(contractKind(Authenticate), 'guard');
  assert.equal(contractKind({ kind: 'query' }), undefined);
  assert.equal(isRequestClass(TodoCreated), false);
  assert.equal(isRequestClass(GetTodo), true);
});

test('schemas that are neither zod objects nor shapes are refused at definition', () => {
  assert.throws(() => Query(z.string() as never, Todo), MurmurError);
  assert.throws(() => Command({ title: 'string' } as never, Todo), MurmurError);
  assert.throws(() => Model({ id: 1 } as never), MurmurError);
  assert.throws(() => Command({ title: z.string() }, 'Todo' as never), {
    message: 'Command() output: expected a Model class, a zod schema or a shape of zod schemas',
  });
  assert.throws(() => Guard(undefined as never), {
    message: 'Guard(): the output must be a Model class, got undefined (check the import of the model)',
  });
});

test('a contract input exposes the zod object shape', () => {
  assert.deepEqual(Object.keys(CreateTodo.input.shape), ['title']);
});

async function secondZodCopy(): Promise<{ z: typeof z; cleanup: () => Promise<void> }> {
  const original = dirname(fileURLToPath(import.meta.resolve('zod')));
  const root = await mkdtemp(join(tmpdir(), 'murmur-zod-'));
  await cp(original, join(root, 'zod'), { recursive: true, dereference: true });
  const copy = (await import(pathToFileURL(join(root, 'zod', 'index.js')).href)) as { z: typeof z };

  return { z: copy.z, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('a zod schema from a second zod copy is accepted', async () => {
  const other = await secondZodCopy();

  try {
    const zz = other.z;
    assert.notEqual(zz, z);

    class Book extends Model(zz.object({ isbn: zz.string() })) {}
    class FindBook extends Query({ isbn: zz.string().min(1) }, Book.nullable(), { name: 'books.FindBook' }) {}
    class ShelveBook extends Command(zz.object({ isbn: zz.string() }), zz.object({ shelf: zz.number() })) {}
    class BookShelved extends Event({ isbn: zz.string() }) {}

    assert.deepEqual(FindBook.input.parse({ isbn: 'x' }), { isbn: 'x' });
    assert.equal(FindBook.input.safeParse({ isbn: '' }).success, false);
    assert.equal(FindBook.output.parse(null), null);
    assert.deepEqual(ShelveBook.output.parse({ shelf: 2 }), { shelf: 2 });
    assert.equal(BookShelved.kind, 'event');
    assert.ok(Array.isArray(FindBook.jsonSchema().output?.['anyOf']));
    assert.equal(isModel(Book), true);
  } finally {
    await other.cleanup();
  }
});
