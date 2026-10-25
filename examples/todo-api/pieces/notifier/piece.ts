import { sqlite } from '@murmur/node/capabilities';
import { type Delivery, Handle, Piece } from 'murmur';

import { NotifyTodo, SweepNotifications } from '#contracts/notifications';

export class Notifier extends Piece({ needs: { db: sqlite } }) {
  @Handle(NotifyTodo, { retry: { attempts: 5, after: ['30s', '2m', '10m'] } })
  async notify(input: NotifyTodo, delivery: Delivery): Promise<void> {
    await this.db.run(
      'INSERT OR IGNORE INTO notifications (todo_id, title, sent_at) VALUES (?, ?, ?)',
      input.id,
      input.title,
      this.clock.now().toString(),
    );

    this.log.info('todo notification sent', { todoId: input.id, attempt: delivery.attempt });
  }

  @Handle(SweepNotifications, { every: '1m' })
  async sweep(): Promise<void> {
    const cutoff = this.clock.now().subtract({ hours: 24 }).toString();
    await this.db.run('DELETE FROM notifications WHERE sent_at < ?', cutoff);
  }
}
