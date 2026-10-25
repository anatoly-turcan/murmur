import { sqlite } from '@murmur/node/capabilities';
import { Handle, Piece } from 'murmur';

import { Tick } from '../../contracts/jobs.ts';

export class Ticker extends Piece({ needs: { db: sqlite } }) {
  @Handle(Tick, { every: '1m' })
  async tick(): Promise<void> {
    await this.db.run('INSERT INTO ticks (at) VALUES (?)', this.clock.now().toString());
  }
}
