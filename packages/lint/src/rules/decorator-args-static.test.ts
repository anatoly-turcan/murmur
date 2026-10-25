import { inApp, runRule } from '../../test/tester.ts';
import rule from './decorator-args-static.ts';

const filename = inApp('pieces/api/rest/piece.ts');
const readers = 'catalog, ctx and the conflict check read it from source without running it';

function method(decorator: string): string {
  return `export class Rest extends Piece() {\n  ${decorator}\n  async run() {}\n}`;
}

runRule('decorator-args-static', rule, {
  valid: [
    { code: method('@Handle(CreateTodo)'), filename },
    { code: method("@Handle(SweepDue, { every: '1m' })"), filename },
    { code: method("@Handle(Deliver, { retry: { attempts: 3, after: ['30s', '5m'] } })"), filename },
    { code: method("@Serve(web.get('/todos/:id'))"), filename },
    { code: method("@Serve(web.delete('/todos/:id', { status: 204 }), RemoveTodo)"), filename },
    {
      code: method("@Serve(web.get('/stats', { skip: [Authenticate], timeoutMs: 500 }), GetStats)"),
      filename,
    },
    { code: method("@Serve(web.raw('GET', '/files/*rest'))"), filename },
    { code: method('@traced(todos.label)'), filename },
  ],
  invalid: [
    {
      code: method('@m.Handle(todos.GetTodo)'),
      filename,
      errors: [
        { message: `@Handle(todos.GetTodo): pass the contract class imported by name; ${readers}`, line: 2 },
      ],
    },
    {
      code: method('@Handle(todos.GetTodo)'),
      filename,
      errors: [
        { message: `@Handle(todos.GetTodo): pass the contract class imported by name; ${readers}`, line: 2 },
      ],
    },
    {
      code: method('@Serve(web.get(`/todos/${id}`))'),
      filename,
      errors: [
        {
          message: `@Serve(web.get(\`/todos/\${id}\`)): write it inline as token.method('/literal/path', { literal options }); ${readers}`,
        },
      ],
    },
    { code: method("@Serve(web.get('/todos/' + segment))"), filename, errors: 1 },
    { code: method('@Serve(route)'), filename, errors: 1 },
    { code: method('@Serve(web.get(path))'), filename, errors: 1 },
    { code: method("@Serve(caps.web.get('/todos'))"), filename, errors: 1 },
    { code: method("@Serve(web.get('/todos', { ...defaults }))"), filename, errors: 1 },
    { code: method("@Serve(web.get('/todos', { [key]: 1 }))"), filename, errors: 1 },
    { code: method("@Serve(web.get('/todos'), todos.ListTodos)"), filename, errors: 1 },
    { code: method('@Handle(GetOwner, options)'), filename, errors: 1 },
    { code: method('@Handle(contracts[0])'), filename, errors: 1 },
  ],
});
