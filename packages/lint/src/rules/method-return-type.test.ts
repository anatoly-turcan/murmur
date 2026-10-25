import { inApp, runRule } from '../../test/tester.ts';
import rule from './method-return-type.ts';

const filename = inApp('pieces/todos/piece.ts');
const message = 'class method without a return type: declare it (`: Promise<Todo | null>`, `: void`)';

runRule('method-return-type', rule, {
  valid: [
    { code: 'export class A { open(): number { return 1; } }', filename },
    {
      code: 'class B { constructor() {} set name(value: string) {} get size(): number { return 0; } }',
      filename,
    },
    { code: 'export class C { async #load(): Promise<void> {} private static hidden(): void {} }', filename },
    { code: 'export const helper = { run() { return 1; } };', filename },
    { code: 'export function plain() { return 1; }', filename },
  ],
  invalid: [
    { code: 'export class A { open() { return 1; } }', filename, errors: [{ message, line: 1 }] },
    { code: 'export class A { private hidden() {} }', filename, errors: 1 },
    { code: 'export class A { #secret() { return []; } }', filename, errors: 1 },
    { code: 'class Local { async load() {} }', filename, errors: 1 },
    { code: 'export class A { get size() { return 0; } static make() {} }', filename, errors: 2 },
    { code: 'export abstract class A { abstract open(); }', filename, errors: 1 },
  ],
});
