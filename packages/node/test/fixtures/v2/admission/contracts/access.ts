import { Guard, Model } from 'murmur';
import { z } from 'zod';

export class Principal extends Model({ userId: z.string() }) {}

export class Authenticate extends Guard(Principal) {}

export class Scope extends Model({ role: z.string(), target: z.string() }) {}

export class ResolveTarget extends Guard(Scope, {
  after: [Authenticate],
  meta: {
    target: z.string().default('item'),
    param: z.string().default('id'),
    role: z.enum(['viewer', 'member']).default('viewer'),
  },
}) {}

export class Rate extends Model({ remaining: z.number(), bucket: z.string() }) {}

export class RateLimit extends Guard(Rate, { optional: [Authenticate] }) {}
