import { setTimeout as delay } from 'node:timers/promises';

import { sqlite } from '@murmur/node/capabilities';
import { Piece } from 'murmur';

export class Poller extends Piece({ needs: { db: sqlite } }) {
  onStart(): void {
    setTimeout(() => void this.settle('rolled-back', this.rolledBackTick()), 0);
    setTimeout(() => void this.settle('plain', this.plainTick()), 5);
    setTimeout(() => void this.settle('committed', this.committedTick()), 10);
  }

  private async rolledBackTick(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('INSERT INTO ticks (v) VALUES (?)', 'rolled-back');
      await delay(30);
      throw new Error('rolled back');
    });
  }

  private async plainTick(): Promise<void> {
    await this.db.run('INSERT INTO ticks (v) VALUES (?)', 'plain');
  }

  private async committedTick(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('INSERT INTO ticks (v) VALUES (?)', 'committed');
    });
  }

  private async settle(tick: string, work: Promise<void>): Promise<void> {
    const outcome = await work.then(
      () => 'ok',
      (error: unknown) => String(error),
    );

    await this.db.run('INSERT INTO outcomes (tick, outcome) VALUES (?, ?)', tick, outcome);
  }
}
