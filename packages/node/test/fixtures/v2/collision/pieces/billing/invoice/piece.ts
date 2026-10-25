import { Piece } from 'murmur';
import { z } from 'zod';

export class Invoice extends Piece({ config: { taxRate: z.number().default(0.2) } }) {}
