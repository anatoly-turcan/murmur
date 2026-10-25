import { inApp, runRule } from '../../test/tester.ts';
import rule from './emit-declared.ts';

const invoice = inApp('pieces/billing/invoice/total.ts');
const todos = inApp('pieces/todos/piece.ts');

function piece(header: string, body: string): string {
  return `export class Todos extends Piece(${header}) {\n  async run() {\n    ${body}\n  }\n}`;
}

runRule('emit-declared', rule, {
  valid: [
    { code: piece('{ emits: [TodoCreated] }', 'await this.emit(TodoCreated, {})'), filename: todos },
    {
      code: piece('{ needs: { db }, emits: [TodoCreated, TodoRemoved] }', 'await this.emit(TodoRemoved, {})'),
      filename: todos,
    },
    { code: piece('{}', 'await this.request(GetTodo, { id: "1" })'), filename: todos },
    { code: piece('{ emits }', 'await this.emit(Anything, {})'), filename: todos },
    {
      code: `const declaration = { emits: [TodoCreated] }\n${piece('declaration', 'await this.emit(TodoCreated, {})')}`,
      filename: todos,
    },
    { code: 'export class Bus {\n  go() {\n    this.emit(Anything, {})\n  }\n}', filename: todos },
    { code: 'export const go = (bus) => bus.emit(InvoiceCreated, {})', filename: invoice },
  ],
  invalid: [
    {
      code: piece('{ emits: [TodoCreated] }', 'await this.emit(TodoRemoved, {})'),
      filename: todos,
      errors: [{ message: 'this.emit(TodoRemoved) but TodoRemoved is not in Piece({ emits })', line: 3 }],
    },
    { code: piece('', 'await this.emit(TodoCreated, {})'), filename: todos, errors: 1 },
    { code: piece('{ needs: { db } }', 'await this.emit(TodoCreated, {})'), filename: todos, errors: 1 },
    {
      code: piece('{ emits: [TodoCreated] }', 'const later = () => this.emit(todos.TodoCreated, {})'),
      filename: inApp('src/anywhere.ts'),
      errors: 1,
    },
  ],
});
