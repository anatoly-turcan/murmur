import { Handle, Piece } from 'murmur';
import { z } from 'zod';

import { AuditReport } from '../../contracts/audit.ts';
import { CountTodos, TodoCreated } from '../../contracts/todos.ts';

export class Audit extends Piece({ config: { label: z.string().default('audit') } }) {
  private todosAtStart = -1;
  private seen = 0;

  async onStart(): Promise<void> {
    const { total } = await this.request(CountTodos, {});
    this.todosAtStart = total;
    this.log.info('audit started', { total });
  }

  @Handle(TodoCreated)
  async created(event: TodoCreated): Promise<void> {
    this.seen += 1;
    this.log.info('todo created', { id: event.id });
  }

  @Handle(AuditReport)
  async report(): Promise<{ label: string; todosAtStart: number; seen: number }> {
    return { label: this.config.label, todosAtStart: this.todosAtStart, seen: this.seen };
  }
}
