import { Handle, Piece } from 'murmur';

import { TodoListRequested, type Todo } from '#contracts/todos';

import { TodosCacheInvalidate } from '../contracts.ts';

export class TodoQuery extends Piece() {
  @Handle(TodoListRequested)
  async list(): Promise<{ items: Todo[] }> {
    return { items: [] };
  }

  @Handle(TodosCacheInvalidate)
  async invalidated(event: TodosCacheInvalidate): Promise<void> {
    this.log.info('cache dropped', { id: event.id });
  }
}
