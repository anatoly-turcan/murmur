import { Event } from 'murmur';
import { z } from 'zod';

export class InvoiceCreated extends Event({ id: z.string() }, { name: 'billing.invoice.created' }) {}

export class InvoiceDue extends Event({ at: z.date() }, { name: 'billing.invoice.due' }) {}
