import { Event } from 'murmur';
import { z } from 'zod';

export class Odd_One extends Event({ id: z.string() }) {}
