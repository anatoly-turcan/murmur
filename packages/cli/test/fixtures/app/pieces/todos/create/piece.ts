import { sqlite } from '@murmur/node/capabilities';
import { Handle, Piece } from 'murmur';
import { z } from 'zod';

import { TodoCreated, TodoCreateRequested, type Todo } from '#contracts/todos';

import { TodosCacheInvalidate } from '../contracts.ts';
import { todoId } from './ids.ts';

export class TodoCreator extends Piece({
  needs: { db: sqlite },
  config: { prefix: z.string().default('todo') },
  emits: [TodoCreated, TodosCacheInvalidate],
}) {
  @Handle(TodoCreateRequested)
  async create(input: TodoCreateRequested): Promise<Todo> {
    const id = todoId(this.config.prefix, this.ids.short());
    await this.emit(TodoCreated, { id, title: input.title });
    await this.emit(TodosCacheInvalidate, { id });

    return { id, title: input.title };
  }
}
