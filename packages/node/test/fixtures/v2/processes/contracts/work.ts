import { Command } from 'murmur';
import { z } from 'zod';

export class Work extends Command({ label: z.string() }, {}) {}
