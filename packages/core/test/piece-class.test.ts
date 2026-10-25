import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classPieceRuntime,
  Command,
  constructPiece,
  defineCapability,
  describePiece,
  EmitNotDeclaredError,
  Handle,
  isPieceClass,
  metadataKey,
  MurmurError,
  NotRequestableError,
  Piece,
  PieceDefinitionError,
  pieceFileOf,
  Serve,
  type Binding,
  type Delivery,
} from 'murmur';
import { z } from 'zod';

import { decorate, recordingPort } from './decorate.ts';
import { Authenticate } from './fixtures/v2/contracts/auth.ts';
import { CreateTodo, GetTodo, ListTodos, TodoCreated, TodoRemoved } from './fixtures/v2/contracts/todos.ts';

const store = defineCapability({ name: 'store', start: () => ({ rows: [] as string[] }) });

function route(key: string): Binding {
  return { transport: 'http', key };
}

class Repository {
  readonly rows: string[];

  constructor(handle: { rows: string[] }) {
    this.rows = handle.rows;
  }
}

class Todos extends Piece({
  needs: { db: store },
  config: { limit: z.number().default(10) },
  emits: [TodoCreated],
}) {
  readonly repository = new Repository(this.db);

  async create(input: CreateTodo): Promise<{ id: string; title: string; done: boolean }> {
    await this.emit(TodoCreated, { id: '1', title: input.title });

    return { id: '1', title: input.title, done: false };
  }
}

test('new on a piece class outside the runtime throws', () => {
  assert.throws(() => new (Todos as unknown as new () => object)(), {
    name: 'MurmurError',
    message: 'pieces are constructed by the runtime, not with new',
  });
});

test('constructPiece hands the port to the base: needs, config, log, clock and ids come from it', () => {
  const rows = ['seed'];
  const port = recordingPort({ db: { rows } }, { limit: 3 });
  const todos = constructPiece(Todos, port);

  assert.equal(todos.db.rows, rows);
  assert.equal(todos.repository.rows, rows);
  assert.equal(todos.config.limit, 3);
  assert.equal(todos.log, port.log);
  assert.equal(todos.clock, port.clock);
  assert.equal(todos.ids, port.ids);
  assert.deepEqual(port.resolved, [{ token: store, field: 'db' }]);
  assert.equal(Object.keys(todos).includes('db'), false);
});

test('construction scope ends with the constructor: a nested new still throws', () => {
  class Nested extends Piece() {}
  class Outer extends Piece() {
    readonly attempt = (() => {
      try {
        return new (Nested as unknown as new () => object)();
      } catch (error) {
        return error;
      }
    })();
  }

  const outer = constructPiece(Outer, recordingPort());

  assert.ok(outer.attempt instanceof MurmurError);
});

test('this.emit goes through the port for a declared event and refuses an undeclared one by wire name', async () => {
  const port = recordingPort({ db: { rows: [] } });
  const todos = constructPiece(Todos, port);
  await todos.create(new CreateTodo({ title: 'milk' }));

  assert.deepEqual(port.emitted, [{ contract: TodoCreated, payload: { id: '1', title: 'milk' } }]);

  await assert.rejects(
    todos.emit(TodoRemoved as never, { id: '1' } as never),
    (error: unknown) =>
      error instanceof EmitNotDeclaredError &&
      error.message ===
        "piece test emits todos.TodoRemoved but does not declare it: add it to this piece's emits",
  );
});

test('this.request takes any request contract and refuses an event', async () => {
  const port = recordingPort({ db: { rows: [] } });
  const todos = constructPiece(Todos, port);

  assert.deepEqual(await todos.request(GetTodo, { id: '1' }), { answeredBy: 'port' });
  assert.deepEqual(port.requested, [{ contract: GetTodo, input: { id: '1' } }]);
  await assert.rejects(todos.request(TodoCreated as never, {} as never), NotRequestableError);
});

test('Piece() rejects bad declarations at import time', () => {
  assert.throws(() => Piece({ emits: [TodoCreated, TodoCreated] }), PieceDefinitionError);
  assert.throws(() => Piece({ emits: [GetTodo as never] }), {
    message: 'Piece({ emits }): GetTodo is a query; emits lists events only',
  });
  assert.throws(() => Piece({ needs: { db: 'sqlite' as never } }), {
    message: 'Piece({ needs }): db is not a capability token',
  });
  assert.throws(() => Piece({ needs: { log: store } }), PieceDefinitionError);
  assert.throws(() => Piece({ config: { limit: 10 as never } }), PieceDefinitionError);
});

test('isPieceClass recognises subclasses of Piece() only', () => {
  class Child extends Todos {}

  assert.equal(isPieceClass(Todos), true);
  assert.equal(isPieceClass(Child), true);
  assert.equal(isPieceClass(Piece()), false);
  assert.equal(isPieceClass(Repository), false);
  assert.equal(isPieceClass({ declaration: {} }), false);
  assert.deepEqual(Todos.declaration.emits, [TodoCreated]);
});

test('describePiece lists a #private handler and calls it through context.access', async () => {
  class Private extends Piece() {
    static readonly createAccess = (instance: Private) => instance.#create;

    #create(input: CreateTodo, delivery: Delivery): { id: string; title: string; done: boolean } {
      return { id: delivery.envelope.id, title: input.title, done: false };
    }
  }

  decorate(Private, [
    { name: '#create', decorators: [Handle(CreateTodo)], get: Private.createAccess as never },
  ]);
  const [entry] = describePiece(Private).handlers;
  const instance = constructPiece(Private, recordingPort());
  const delivery = { envelope: { id: 'env-1' }, attempt: 1, piece: 'p' } as unknown as Delivery;

  assert.equal(entry?.method, '#create');
  assert.equal(entry?.contract, CreateTodo);
  assert.equal(entry?.every, undefined);
  assert.deepEqual(entry?.get(instance).call(instance, { title: 'milk' }, delivery), {
    id: 'env-1',
    title: 'milk',
    done: false,
  });
});

test('two stacked class-level @Serve both appear in metadata, in source order, before method routes', () => {
  class Rest extends Piece() {
    show(): { ok: boolean } {
      return { ok: true };
    }
  }

  decorate(
    Rest,
    [{ name: 'show', decorators: [Serve(route('GET /todos/:id'))] }],
    [Serve(route('GET /todos'), ListTodos), Serve(route('POST /todos'), CreateTodo)],
  );
  const { serves } = describePiece(Rest);

  assert.deepEqual(
    serves.map((entry) => [entry.binding.key, entry.contract, entry.method]),
    [
      ['GET /todos', ListTodos, undefined],
      ['POST /todos', CreateTodo, undefined],
      ['GET /todos/:id', undefined, 'show'],
    ],
  );
  assert.ok(Object.hasOwn(Rest, metadataKey));
});

test('one class may not handle one contract twice or serve overlapping bindings', () => {
  class Twice extends Piece() {
    a(): void {}
    b(): void {}
  }

  assert.throws(
    () =>
      decorate(Twice, [
        { name: 'a', decorators: [Handle(CreateTodo)] },
        { name: 'b', decorators: [Handle(CreateTodo)] },
      ]),
    { name: 'PieceDefinitionError', message: '@Handle(CreateTodo) is declared twice in one piece: a and b' },
  );

  class Overlap extends Piece() {
    a(): void {}
    b(): void {}
  }

  assert.throws(
    () =>
      decorate(Overlap, [
        { name: 'a', decorators: [Serve(route('GET /todos/:id'))] },
        { name: 'b', decorators: [Serve(route('GET /todos/:slug'))] },
      ]),
    { message: '@Serve(GET /todos/:slug) conflicts with @Serve(GET /todos/:id) in the same piece' },
  );
});

test('decorators refuse what is not a contract, a binding or the right placement', () => {
  class Wrong extends Piece() {
    static helper(): void {}
    method(): void {}
  }

  assert.throws(() => Handle({} as never), PieceDefinitionError);
  assert.throws(() => Handle(undefined as never), {
    message:
      '@Handle() expects a contract class (Query, Command, Event or Guard), got undefined (check the import of the contract)',
  });
  assert.throws(() => Serve(route('GET /'), undefined as never), {
    message:
      '@Serve(GET /, …) forwards to a Query, Command or Guard class, got undefined (check the import of the contract)',
  });
  assert.throws(() => Serve({ key: 'GET /' } as never), PieceDefinitionError);
  assert.throws(() => Serve(route('GET /'), TodoCreated as never), PieceDefinitionError);
  assert.throws(
    () => decorate(Wrong, [{ name: 'helper', isStatic: true, decorators: [Handle(CreateTodo)] }]),
    PieceDefinitionError,
  );
  assert.throws(() => decorate(Wrong, [{ name: 'method', decorators: [Serve(route('GET /'), GetTodo)] }]), {
    message: '@Serve(GET /, Contract) is the class-level shorthand: put it above the class',
  });
  assert.throws(() => decorate(Wrong, [], [Serve(route('GET /'))]), PieceDefinitionError);
});

for (const [shape, linkParentMetadata] of [
  ['TC39 (metadata linked to the parent, esbuild)', true],
  ['swc (metadata not linked to the parent)', false],
] as const) {
  test(`a subclass inherits handlers and overrides one per contract under ${shape}`, () => {
    class Base extends Piece() {
      create(): void {}
      get(): void {}
    }

    decorate(Base, [
      { name: 'create', decorators: [Handle(CreateTodo)] },
      { name: 'get', decorators: [Handle(GetTodo)] },
    ]);

    class Child extends Base {
      replace(): void {}
    }

    decorate(Child, [{ name: 'replace', decorators: [Handle(CreateTodo)] }], [], { linkParentMetadata });

    class Grandchild extends Child {}

    assert.deepEqual(
      describePiece(Grandchild).handlers.map((entry) => [entry.contract, entry.method]),
      [
        [CreateTodo, 'replace'],
        [GetTodo, 'get'],
      ],
    );
    assert.equal(describePiece(Base).handlers.length, 2);
  });
}

test('a subclass route with the same normalised key replaces the parent route', () => {
  class Base extends Piece() {
    byId(): void {}
  }

  decorate(Base, [{ name: 'byId', decorators: [Serve(route('GET /todos/:id'))] }]);

  class Child extends Base {
    bySlug(): void {}
  }

  decorate(Child, [{ name: 'bySlug', decorators: [Serve(route('GET /todos/:slug'))] }]);

  assert.deepEqual(
    describePiece(Child).serves.map((entry) => [entry.binding.key, entry.method]),
    [['GET /todos/:slug', 'bySlug']],
  );
});

test('a subclass route that overlaps a parent route without replacing it is refused', () => {
  class Base extends Piece() {
    byId(): void {}
  }

  decorate(Base, [{ name: 'byId', decorators: [Serve(route('GET /todos/:id'))] }]);

  class Child extends Base {
    any(): void {}
  }

  decorate(Child, [{ name: 'any', decorators: [Serve(route('* /todos/:id'))] }]);

  assert.throws(() => describePiece(Child), {
    name: 'PieceDefinitionError',
    message: '@Serve(GET /todos/:id) on byId overlaps @Serve(* /todos/:id) on any in Child',
  });
});

class SweepDue extends Command({ limit: z.number().default(10) }, {}, { name: 'jobs.SweepDue' }) {}

class Deliver extends Command({ url: z.string() }, {}, { name: 'jobs.Deliver' }) {}

test('a guard handler and job handlers with every and retry are recorded like any other', () => {
  class Guarded extends Piece() {
    authenticate(): void {}
    sweep(): void {}
    deliver(): void {}
  }

  decorate(Guarded, [
    { name: 'authenticate', decorators: [Handle(Authenticate)] },
    { name: 'sweep', decorators: [Handle(SweepDue, { every: '1m' })] },
    { name: 'deliver', decorators: [Handle(Deliver, { retry: { attempts: 3, after: ['30s', '2m'] } })] },
  ]);

  assert.deepEqual(
    describePiece(Guarded).handlers.map((entry) => [entry.contract, entry.every, entry.retry]),
    [
      [Authenticate, undefined, undefined],
      [SweepDue, '1m', undefined],
      [Deliver, undefined, { attempts: 3, after: ['30s', '2m'] }],
    ],
  );
});

test('Handle options that cannot run fail at the decorator with the allowed form', () => {
  assert.throws(() => Handle(SweepDue, { every: '90' as never }), {
    name: 'PieceDefinitionError',
    message: "`every: '90'` is not a duration; use `<n>s`, `<n>m`, `<n>h` or `<n>d`",
  });
  assert.throws(() => Handle(Deliver, { every: '1m' }), {
    message:
      '`@Handle(Deliver, { every })`: Deliver has required input fields; a scheduled command takes none',
  });
  assert.throws(() => Handle(GetTodo, { every: '1m' }), {
    message:
      '`@Handle(GetTodo, { every })`: GetTodo is a query; a schedule enqueues a Command with no required input fields',
  });
  assert.throws(() => Handle(Deliver, { retry: { attempts: 3, after: ['30'] as never } }), {
    message: `\`retry.after\` entries must be durations like '30s'; got "30"`,
  });
  assert.throws(() => Handle(Deliver, { retry: { attempts: 0 } }), {
    message:
      "`retry.attempts` must be a positive integer like `{ attempts: 5, after: ['30s', '5m'] }`; got 0",
  });
  assert.throws(() => Handle(TodoCreated, { retry: { attempts: 2 } }), {
    message:
      '`@Handle(TodoCreated, { retry })`: TodoCreated is an event; a retry ladder applies to job Commands (policy.retry covers bus redelivery)',
  });
});

test('a command handler whose output accepts {} may return nothing and replies {}', async () => {
  class Sweeper extends Piece() {
    async sweep(): Promise<void> {}
  }

  decorate(Sweeper, [{ name: 'sweep', decorators: [Handle(SweepDue, { every: '1m' })] }]);
  const runtime = classPieceRuntime({
    name: 'sweeper',
    piece: Sweeper,
    instance: () => ({ sweep: async () => {} }),
  });
  const delivery = { envelope: { id: 'env-1' }, attempt: 1, piece: 'p' } as unknown as Delivery;

  assert.deepEqual(await runtime.handlers[0]?.handle({}, delivery), {});
});

test('describePiece refuses a class that does not extend Piece()', () => {
  assert.throws(() => describePiece(Repository as never), PieceDefinitionError);
});

test('pieceFileOf names the file that called Piece(), through subclasses too', () => {
  class Base extends Piece() {}
  class Child extends Base {}

  assert.equal(pieceFileOf(Base), import.meta.filename);
  assert.equal(pieceFileOf(Child), import.meta.filename);
});
