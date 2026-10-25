import { Event } from 'murmur';
import { z } from 'zod';

export class RatesTicked extends Event({ at: z.string() }) {}
