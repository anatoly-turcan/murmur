import { format } from 'date-fns';
import { Handle, Piece } from 'murmur';

import { InvoiceCreated } from '#contracts/billing';

import { SimTick } from '../contracts.ts';
import { total } from './total.ts';

export class Invoice extends Piece({ emits: [InvoiceCreated] }) {
  @Handle(SimTick)
  async ticked(event: SimTick): Promise<void> {
    await this.emit(InvoiceCreated, { id: format(total(event.n), 'yyyy') });
  }
}
