import { Guard, Model } from 'murmur';
import { z } from 'zod';

export class AdminGrant extends Model({ admin: z.boolean() }) {}

export class RequireAdmin extends Guard(AdminGrant) {}

export class ImpersonatedPrincipal extends Model({ userId: z.string() }) {}

export class Impersonate extends Guard(ImpersonatedPrincipal) {}
