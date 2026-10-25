import { inApp, runRule } from '../../test/tester.ts';
import rule from './contracts-json-faithful.ts';

const publicFile = inApp('contracts/billing.ts');
const groupFile = inApp('pieces/billing/contracts.ts');
const message = 'contract schemas must be JSON-faithful and non-coercing; use strings/numbers/objects';

runRule('contracts-json-faithful', rule, {
  valid: [
    {
      code: 'export class A extends Event({ id: z.string() }) {}',
      filename: publicFile,
    },
    {
      code: 'export const at = z.date()\nexport class A extends Event({}) {}',
      filename: publicFile,
    },
    {
      code: 'export class A extends Event({ at: z.date() }) {}',
      filename: inApp('pieces/x/y/piece.ts'),
    },
    {
      code: 'export class CreateTodo extends Command({ title: z.string().min(1) }, Todo.nullable()) {}',
      filename: publicFile,
    },
    {
      code: 'export class Todo extends Model({ id: z.string(), tags: z.array(z.string()) }) {}',
      filename: groupFile,
    },
    { code: 'export class Ticked extends Event({ n: z.number().int() }) {}', filename: groupFile },
    {
      code: 'export class UpdateItem extends Command({ id: z.string(), ifMatch: IfMatch }, rejectable(Item)) {}',
      filename: publicFile,
    },
  ],
  invalid: [
    {
      code: 'export class A extends Query({ n: z.string().transform(Number) }, {}) {}',
      filename: publicFile,
      errors: [{ message }],
    },
    {
      code: 'export class A extends Event({ at: z.date() }) {}',
      filename: groupFile,
      errors: 1,
    },
    {
      code: 'export class A extends Event({ n: z.coerce.number() }) {}',
      filename: publicFile,
      errors: 1,
    },
    {
      code: 'export class A extends Command(\n  { a: z.bigint(), b: z.map(z.string(), z.string()), c: z.set(z.string()) },\n  { d: z.instanceof(Date), e: z.stringbool() },\n) {}',
      filename: publicFile,
      errors: 5,
    },
    {
      code: 'export class Todo extends Model({ createdAt: z.date() }) {}',
      filename: publicFile,
      errors: [{ message }],
    },
    {
      code: 'export class ListTodos extends Query({ limit: z.coerce.number() }, Todo.array()) {}',
      filename: publicFile,
      errors: 1,
    },
    {
      code: 'export class Ticked extends Event({ at: z.string().transform((s) => new Date(s)) }) {}',
      filename: groupFile,
      errors: 1,
    },
    {
      code: 'export class Admin extends Guard(Principal, { name: z.bigint() }) {}',
      filename: publicFile,
      errors: 1,
    },
    {
      code: 'export class Upload extends Command({ file: z.instanceof(Blob) }, { size: z.number() }) {}',
      filename: publicFile,
      errors: 1,
    },
  ],
});
