import { inApp, runRule } from '../../test/tester.ts';
import rule from './contract-factory-wrapped.ts';

const filename = inApp('contracts/base.ts');
const imports = "import { Command, Event, Guard, Query } from 'murmur'\n";
const message = (kind: string) =>
  `${kind}(...) outside \`class X extends ${kind}(...)\` has no class name to derive the wire name from (a wrapper would name it after its own file): pass { name: 'domain.Name' } or write \`class X extends ${kind}(...)\``;

runRule('contract-factory-wrapped', rule, {
  valid: [
    { code: `${imports}export class CreateTodo extends Command({ title: z.string() }, Todo) {}`, filename },
    { code: `${imports}export const Created = class extends Event({ id: z.string() }) {}`, filename },
    {
      code: `${imports}export function Cmd(input, output) {\n  return Command(input, output, { name: 'todos.Create' })\n}`,
      filename,
    },
    { code: `${imports}export const Admin = Guard(Principal, { name: 'auth.Admin' })`, filename },
    {
      code: `${imports}export const Ticked = Event({ n: z.number() }, { name: 'sim.ticked', description: 'x' })`,
      filename,
    },
    { code: "import { Command } from './local.ts'\nexport const c = Command(1, 2)", filename },
    { code: 'export const e = Event({ id: 1 })', filename },
  ],
  invalid: [
    {
      code: `${imports}export function Cmd(input, output) {\n  return Command(input, output)\n}`,
      filename,
      errors: [{ message: message('Command'), line: 3 }],
    },
    {
      code: `${imports}export const Find = (input, output) => Query(input, output, { description: 'x' })`,
      filename,
      errors: [{ message: message('Query') }],
    },
    {
      code: "import { Event as Evt } from 'murmur'\nexport const make = (payload) => Evt(payload)",
      filename,
      errors: [{ message: message('Event') }],
    },
    {
      code: `${imports}export class Admin extends Mixin(Guard(Principal)) {}`,
      filename,
      errors: [{ message: message('Guard') }],
    },
    { code: `${imports}export const Ticked = Event({ n: z.number() }, options)`, filename, errors: 1 },
  ],
});
