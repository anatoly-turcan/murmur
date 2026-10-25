import { Model, Query } from 'murmur';
import { z } from 'zod';

export class Stats extends Model({ total: z.number(), done: z.number() }) {}

export class GetStats extends Query({}, Stats) {}
