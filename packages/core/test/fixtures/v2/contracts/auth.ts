import { Guard, Model } from 'murmur';
import { z } from 'zod';

export class Principal extends Model({ userId: z.string(), roles: z.array(z.string()) }) {}

export class Quota extends Model({ remaining: z.number() }) {}

export class AdminGrant extends Model({ admin: z.literal(true) }) {}

export class Authenticate extends Guard(Principal) {}

export class RateLimit extends Guard(Quota) {}

export class RequireAdmin extends Guard(AdminGrant) {}

export class Scope extends Model({ role: z.string(), target: z.string() }) {}

export class ResolveTarget extends Guard(Scope, {
  after: [Authenticate],
  optional: [RateLimit],
  meta: { target: z.string(), role: z.enum(['viewer', 'member']).default('viewer') },
}) {}
