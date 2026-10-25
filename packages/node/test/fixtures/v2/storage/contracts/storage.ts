import { Event, Query } from 'murmur';
import { z } from 'zod';

export class JobRequested extends Event({ id: z.string() }) {}

export class CountEffects extends Query({ id: z.string() }, { effects: z.number(), markers: z.number() }) {}
