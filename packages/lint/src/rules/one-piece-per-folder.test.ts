import { inApp, runRule } from '../../test/tester.ts';
import rule from './one-piece-per-folder.ts';

const entry = inApp('pieces/todos/piece.ts');
const privateFile = inApp('pieces/todos/repository.ts');

runRule('one-piece-per-folder', rule, {
  valid: [
    { code: 'export class Todos extends Piece() {}', filename: entry },
    { code: 'class Helper {}\nexport class Todos extends Piece() {}', filename: entry },
    { code: 'export class TodoRepository {}\nexport class Mapper extends Base {}', filename: privateFile },
    {
      code: 'class Fake extends Piece() {}\nexport const fake = Fake',
      filename: inApp('pieces/todos/piece.test.ts'),
    },
    {
      code: 'export class A extends Piece() {}\nexport class B extends Piece() {}',
      filename: inApp('src/x.ts'),
    },
  ],
  invalid: [
    {
      code: 'export class Todos extends Piece() {}\nexport class Stats extends Piece() {}',
      filename: entry,
      errors: [
        {
          message:
            'pieces/todos already declares Todos; one folder is one piece: move Stats to its own folder (pieces/todos/<name>/piece.ts)',
          line: 2,
        },
      ],
    },
    {
      code: 'export class TodoWorker extends Piece() {}',
      filename: privateFile,
      errors: [
        {
          message:
            'TodoWorker extends Piece(...) in repository.ts: a piece class lives only in piece.ts, one per folder (pieces/todos)',
        },
      ],
    },
    {
      code: 'export class Todos extends Piece() {}\nconst Extra = class extends Piece() {}\nexport const keep = Extra',
      filename: entry,
      errors: 1,
    },
    {
      code: 'export class Stray extends Piece() {}',
      filename: inApp('pieces/billing/helpers.ts'),
      errors: 1,
    },
  ],
});
