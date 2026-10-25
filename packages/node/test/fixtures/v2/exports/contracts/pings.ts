import { Event } from 'murmur';
import { z } from 'zod';

export class Pinged extends Event({ at: z.string() }) {}
