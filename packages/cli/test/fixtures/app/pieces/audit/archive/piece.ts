import { Handle, Piece } from 'murmur';

import { AuditRecorded } from '#contracts/audit';

export class AuditArchive extends Piece() {
  @Handle(AuditRecorded)
  async archived(event: AuditRecorded): Promise<void> {
    this.log.info('archived', { todoId: event.todoId });
  }
}
