import { jobs, sqlite } from '@murmur/node/capabilities';
import { Handle, NonRetryableError, Piece } from 'murmur';

import { EnqueueInTx, Record } from '../../contracts/jobs.ts';

export class Producer extends Piece({ needs: { db: sqlite, jobs } }) {
  @Handle(EnqueueInTx)
  async enqueue(input: EnqueueInTx): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('INSERT INTO marks (label) VALUES (?)', input.label);
      await this.jobs.enqueue(Record, { label: input.label });

      if (input.rollback) {
        throw new NonRetryableError('rolled back on purpose');
      }
    });
  }
}
