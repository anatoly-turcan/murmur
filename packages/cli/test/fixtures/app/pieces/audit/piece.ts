import { Handle, Piece } from 'murmur';

import { AuditRecorded } from '#contracts/audit';
import { TodoCreated } from '#contracts/todos';

export class Audit extends Piece({ emits: [AuditRecorded] }) {
  @Handle(TodoCreated)
  async created(event: TodoCreated): Promise<void> {
    await this.emit(AuditRecorded, { todoId: event.id });
  }
}
