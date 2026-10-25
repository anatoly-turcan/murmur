import { Guard, Model } from 'murmur';
import { z } from 'zod';

export class Principal extends Model({ userId: z.string() }) {}

export class Authenticate extends Guard(Principal) {}
