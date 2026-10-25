import { sqlite } from '@murmur/node/capabilities';
import { Handle, Piece } from 'murmur';

import { Work } from '../../contracts/work.ts';

export class Worker extends Piece({ needs: { db: sqlite } }) {
  @Handle(Work)
  async work(input: Work): Promise<void> {
    await this.db.run('INSERT INTO runs (label) VALUES (?)', input.label);
  }
}
