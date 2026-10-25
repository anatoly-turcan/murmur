import { Event, Query } from 'murmur';
import { z } from 'zod';

export class InvoiceDrafted extends Event({ todoId: z.string() }) {}

export class CountInvoices extends Query({}, { drafted: z.number() }) {}
