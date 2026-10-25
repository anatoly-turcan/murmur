import { sqlite } from '@murmur/node/capabilities';
import { Handle, Piece } from 'murmur';

import { AuditItem } from '../../contracts/kit.ts';

export class Audit extends Piece({ needs: { db: sqlite } }) {
  @Handle(AuditItem)
  async audit(input: AuditItem): Promise<void> {
    await this.db.run('INSERT INTO audits (item_id) VALUES (?)', input.id);
  }
}
