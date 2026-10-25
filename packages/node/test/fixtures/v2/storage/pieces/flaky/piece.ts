import { kv, sqlite } from '@murmur/node/capabilities';
import { Handle, Piece } from 'murmur';

import { CountEffects, JobRequested } from '../../contracts/storage.ts';

let attempts = 0;

export class Flaky extends Piece({ needs: { kv, db: sqlite } }) {
  async onStart(): Promise<void> {
    await this.db.exec('CREATE TABLE effects (id TEXT NOT NULL)');
  }

  @Handle(JobRequested)
  async job(event: JobRequested): Promise<void> {
    await this.kv.once(event.id, async () => {
      await this.db.run('INSERT INTO effects (id) VALUES (?)', event.id);
      attempts += 1;

      if (attempts === 1) {
        throw new Error('effect failed once');
      }
    });
  }

  @Handle(CountEffects)
  async count(input: CountEffects): Promise<{ effects: number; markers: number }> {
    const effects = await this.db.get<{ n: number }>(
      'SELECT count(*) AS n FROM effects WHERE id = ?',
      input.id,
    );

    const markers = await this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM murmur_kv WHERE kind = 'once' AND key = ?",
      input.id,
    );

    return { effects: effects?.n ?? 0, markers: markers?.n ?? 0 };
  }
}
