import { Guard, Model } from 'murmur';
import { z } from 'zod';

export class Principal extends Model({ userId: z.string(), roles: z.array(z.string()) }) {}

export class Quota extends Model({ remaining: z.number() }) {}

export class Authenticate extends Guard(Principal) {}

export class RateLimit extends Guard(Quota, { optional: [Authenticate] }) {}
