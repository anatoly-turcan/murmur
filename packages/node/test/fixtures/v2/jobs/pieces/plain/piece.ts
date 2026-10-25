import { sqlite } from '@murmur/node/capabilities';
import { Handle, Piece } from 'murmur';

import { Note } from '../../contracts/jobs.ts';

export class Plain extends Piece({ needs: { db: sqlite } }) {
  @Handle(Note)
  async note(input: Note): Promise<void> {
    await this.db.run('INSERT INTO plain_runs (label) VALUES (?)', input.label);
  }
}
