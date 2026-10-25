import { inApp, runRule } from '../../test/tester.ts';
import rule from './erasable-syntax-only.ts';

const filename = inApp('pieces/notify/send/legacy.ts');
const contracts = inApp('contracts/todos.ts');
const message =
  'not erasable: Node strips types only; use a const object + union / a module / a plain property';

runRule('erasable-syntax-only', rule, {
  valid: [
    { code: "export const Channel = { Email: 'email' } as const", filename },
    { code: "declare module 'murmur' {\n  interface CapabilityRegistry { x: 1 }\n}", filename },
    { code: 'declare global {\n  var y: number\n}\nexport {}', filename },
    { code: 'export class A {\n  x: number\n  constructor(x: number) {\n    this.x = x\n  }\n}', filename },
    { code: "import type { X } from './x.ts'\nexport type Y = X", filename },
    {
      code: 'export class Todos extends Piece() {\n  @Handle(GetTodo)\n  get() {}\n}',
      filename: inApp('pieces/todos/piece.ts'),
    },
    { code: '@logged\nexport class Mailer {}', filename },
    {
      code: 'export class Todos extends Piece() {\n  @Handle(GetTodo)\n  get() {}\n}',
      filename: inApp('src/todos.ts'),
    },
  ],
  invalid: [
    { code: 'export enum Channel { Email }', filename, errors: [{ message, line: 1 }] },
    { code: 'export const enum Channel { Email }', filename, errors: 1 },
    { code: 'export namespace N {\n  export const a = 1\n}', filename, errors: 1 },
    { code: '@logged\nexport class Mailer {}', filename: contracts, errors: [{ message, line: 1 }] },
    {
      code: 'export class Mailer {\n  constructor(private readonly url: string) {}\n}',
      filename,
      errors: [{ line: 2, message }],
    },
    {
      code: 'export class Todos extends Piece() {\n  @logged\n  @Serve(web.get("/x"))\n  get() {}\n}',
      filename: inApp('src/todos.ts'),
      errors: [{ message, line: 2 }],
    },
    { code: "import fs = require('node:fs')\nexport const r = fs", filename, errors: 1 },
  ],
});
