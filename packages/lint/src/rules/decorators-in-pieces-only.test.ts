import { inApp, runRule } from '../../test/tester.ts';
import rule from './decorators-in-pieces-only.ts';

const entry = inApp('pieces/todos/piece.ts');
const privateFile = inApp('pieces/todos/repository.ts');
const elsewhere =
  '@Handle/@Serve mark the ports of a piece: put them on the piece class in pieces/<id>/piece.ts';
const offPiece = 'decorators belong only on the piece class (`extends Piece(...)`) and its methods';
const inRepository =
  'decorators belong on the piece class and its methods in piece.ts, not in repository.ts; write a plain function or class here';

runRule('decorators-in-pieces-only', rule, {
  valid: [
    {
      code: 'export class Todos extends Piece() {\n  @Handle(CreateTodo)\n  async create() {}\n}',
      filename: entry,
    },
    {
      code: "@Serve(web.get('/todos'), ListTodos)\nexport class Rest extends Piece() {\n  @Serve(web.post('/todos'))\n  async create() {}\n}",
      filename: inApp('pieces/api/rest/piece.ts'),
    },
    { code: 'export class Todos extends Piece() {\n  @traced\n  async run() {}\n}', filename: entry },
    { code: '@logged\nexport class Mailer {}', filename: inApp('src/mailer.ts') },
    { code: 'export class TodoRepository {\n  find() {}\n}', filename: privateFile },
    {
      code: 'class FakeTodos extends Piece() {\n  @Handle(GetTodo)\n  async get() {}\n}',
      filename: inApp('pieces/todos/piece.test.ts'),
    },
  ],
  invalid: [
    {
      code: 'export class TodoRepository {\n  @memoize\n  find() {}\n}',
      filename: privateFile,
      errors: [{ message: inRepository, line: 2 }],
    },
    {
      code: 'class Helper {\n  @Handle(GetTodo)\n  get() {}\n}\nexport class Todos extends Piece() {}',
      filename: entry,
      errors: [{ message: offPiece, line: 2 }],
    },
    {
      code: 'export class Todos extends Piece() {\n  @Handle(GetTodo)\n  get() {}\n}',
      filename: inApp('src/todos.ts'),
      errors: [{ message: elsewhere }],
    },
    {
      code: "@Serve(web.get('/x'), GetX)\nexport class Rest {}",
      filename: inApp('lib/rest.ts'),
      errors: [{ message: elsewhere, line: 1 }],
    },
    {
      code: '@sealed\nexport class Helper {}',
      filename: inApp('pieces/todos/piece.test.ts'),
      errors: 1,
    },
  ],
});
