import { Handle, Piece } from 'murmur';

import { InvoiceCreated } from '#contracts/billing';

import { SimTick } from '../../billing/contracts.ts';
import { Channel, Mailer } from './legacy.ts';

export class Send extends Piece() {
  @Handle(InvoiceCreated)
  async created(event: InvoiceCreated): Promise<void> {
    const mailer = new Mailer(process.env.SMTP_URL ?? '');
    await mailer.send(Channel.Email, event.id);
    await this.emit(SimTick, { n: 1 });
  }
}
