import { inApp, runRule } from '../../test/tester.ts';
import rule from './no-typeof-types.ts';

const repository = inApp('pieces/todos/repository.ts');

runRule('no-typeof-types', rule, {
  valid: [
    { code: 'export async function create(input: CreateTodo): Promise<Todo> {}', filename: repository },
    { code: "export const isText = (value: unknown) => typeof value === 'string'", filename: repository },
    {
      code: 'export type WebRequest = RequestOf<typeof web>',
      filename: inApp('capabilities/web/capability.ts'),
    },
  ],
  invalid: [
    {
      code: 'const blank = { id: "" }\nexport type Row = typeof blank',
      filename: repository,
      errors: [
        {
          message:
            'typeof blank in a type: name the class (input: CreateTodo, Promise<Todo>) or a type exported next to its value',
          line: 2,
        },
      ],
    },
    {
      code: 'export async function create(input: InputOf<typeof CreateTodo>) {}',
      filename: inApp('pieces/todos/piece.ts'),
      errors: 1,
    },
    {
      code: "export type Store = ReturnType<typeof import('./store.ts').open>",
      filename: repository,
      errors: 1,
    },
    {
      code: 'export const x = 1 as unknown as typeof y',
      filename: inApp('pieces/todos/piece.test.ts'),
      errors: 1,
    },
  ],
});
