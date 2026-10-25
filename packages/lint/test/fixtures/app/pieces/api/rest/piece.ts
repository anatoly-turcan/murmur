import { Piece, Serve } from 'murmur';

import web, { type WebRequest } from '#capabilities/web';
import { CreateTodo, GetTodo } from '#contracts/todos';

import { TodoRepository } from '../../todos/repository.ts';

@Serve(web.get('/todos/:id'), GetTodo)
export class RestApi extends Piece() {
  private readonly peek = new TodoRepository();

  @Serve(web.post('/todos'))
  async create(req: WebRequest): Promise<Response> {
    const { body } = await req.read({ body: CreateTodo.input });
    const todo = await this.request(CreateTodo, body);

    return req.reply({ ...todo, known: this.peek.find(todo.id) !== null }, { status: 201 });
  }
}
