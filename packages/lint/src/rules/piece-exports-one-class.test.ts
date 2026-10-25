import { inApp, runRule } from '../../test/tester.ts';
import rule from './piece-exports-one-class.ts';

const entry = inApp('pieces/todos/piece.ts');
const onlyTheClass =
  'piece.ts exports one thing, `export class X extends Piece(...)`; move this to a private file of the folder';
const noDefault =
  'the piece class is a named export: `export class X extends Piece(...)`, not a default export';
const missing = 'piece.ts must export the piece class: `export class X extends Piece({ ... }) {}`';

runRule('piece-exports-one-class', rule, {
  valid: [
    { code: 'export class Todos extends Piece({ emits: [TodoCreated] }) {}', filename: entry },
    {
      code: "import { Piece } from 'murmur'\nconst limit = 10\nexport class Todos extends Piece() {\n  max = limit\n}",
      filename: entry,
    },
    {
      code: 'class Helper {}\nexport class Todos extends Piece() {\n  helper = new Helper()\n}',
      filename: entry,
    },
    { code: 'export const total = 1\nexport default total', filename: inApp('pieces/todos/repository.ts') },
    { code: 'export class Anything {}', filename: inApp('src/piece.ts') },
  ],
  invalid: [
    {
      code: 'export class Todos extends Piece() {}\nexport const limit = 10',
      filename: entry,
      errors: [{ message: onlyTheClass, line: 2 }],
    },
    {
      code: 'export default class Todos extends Piece() {}',
      filename: entry,
      errors: [{ message: noDefault }, { message: missing }],
    },
    {
      code: 'export class Todos extends Piece() {}\nexport type Row = { id: string }',
      filename: entry,
      errors: [{ message: onlyTheClass }],
    },
    {
      code: "export class Todos extends Piece() {}\nexport * from './repository.ts'",
      filename: entry,
      errors: [{ message: onlyTheClass }],
    },
    {
      code: 'class Todos extends Piece() {}\nexport { Todos }',
      filename: entry,
      errors: [
        {
          message: 'export the class where it is declared: `export class Todos extends Piece(...)`',
          line: 2,
        },
      ],
    },
    {
      code: 'export default class Todos {}',
      filename: entry,
      errors: [{ message: noDefault }, { message: missing }],
    },
    {
      code: 'export class Todos {}',
      filename: entry,
      errors: [{ message: onlyTheClass }, { message: missing }],
    },
    { code: '', filename: entry, errors: [{ message: missing, line: 1 }] },
  ],
});
