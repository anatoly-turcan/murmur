import type { HttpResult } from '@murmur/node/capabilities';
import { Piece, Serve } from 'murmur';

import web, { type WebRequest } from '../../../capabilities/web/capability.ts';
import { Authenticate } from '../../../contracts/auth.ts';
import { GetStats } from '../../../contracts/stats.ts';
import { CompleteTodo, CreateTodo, GetTodo, ListTodos, RemoveTodo } from '../../../contracts/todos.ts';
import { etagOf } from './etag.ts';

@Serve(web.get('/todos'), ListTodos)
@Serve(web.post('/todos/:id/complete'), CompleteTodo)
@Serve(web.delete('/todos/:id', { status: 204 }), RemoveTodo)
@Serve(web.get('/stats', { skip: [Authenticate] }), GetStats)
export class RestApi extends Piece() {
  @Serve(web.post('/todos'))
  async create(req: WebRequest): Promise<HttpResult> {
    const { body } = await req.read({ body: CreateTodo.input });
    const todo = await this.request(CreateTodo, body);
    this.log.info('todo created', { id: todo.id, by: req.auth.userId });

    return req.reply(todo, { status: 201, headers: { location: `/todos/${todo.id}` }, etag: etagOf });
  }

  @Serve(web.get('/todos/:id'))
  async show(req: WebRequest): Promise<HttpResult> {
    const { params } = await req.read({ params: GetTodo.input });

    return req.reply(await this.request(GetTodo, params), { etag: etagOf });
  }
}
