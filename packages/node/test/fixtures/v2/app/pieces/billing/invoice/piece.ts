import { Handle, Piece } from 'murmur';

import { TodoCreated } from '../../../contracts/todos.ts';
import { CountInvoices, InvoiceDrafted } from '../contracts.ts';

export class Invoices extends Piece({ emits: [InvoiceDrafted] }) {
  private drafted = 0;

  @Handle(TodoCreated)
  async draft(event: TodoCreated): Promise<void> {
    await this.emit(InvoiceDrafted, { todoId: event.id });
  }

  @Handle(InvoiceDrafted)
  async count(): Promise<void> {
    this.drafted += 1;
  }

  @Handle(CountInvoices)
  async total(): Promise<{ drafted: number }> {
    return { drafted: this.drafted };
  }
}
