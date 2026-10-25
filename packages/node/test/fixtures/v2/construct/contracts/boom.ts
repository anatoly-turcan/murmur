import { Query } from 'murmur';
import { z } from 'zod';

export class Detonate extends Query({}, { ok: z.boolean() }) {}
