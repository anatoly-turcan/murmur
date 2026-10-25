import { Command, Guard, Model } from 'murmur';
import { z } from 'zod';

export class Principal extends Model({ userId: z.string() }) {}

export class Authenticate extends Guard(Principal) {}

export class Item extends Model({ id: z.string(), title: z.string() }) {}

export class CreateItem extends Command({ title: z.string().min(1) }, Item) {}

export class ImportItem extends Command({ id: z.string(), title: z.string() }, {}) {}

export class IndexItem extends Command({ id: z.string() }, {}) {}

export class AuditItem extends Command({ id: z.string() }, {}) {}
