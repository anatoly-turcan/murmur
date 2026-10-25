import { Command } from 'murmur';
import { z } from 'zod';

export class Issue extends Command({ customerId: z.string() }, { invoiceId: z.string() }) {}
