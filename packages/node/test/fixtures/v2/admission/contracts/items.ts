import { Model, Query } from 'murmur';
import { z } from 'zod';

export class Item extends Model({ id: z.string(), name: z.string() }) {}

export class GetItem extends Query({ id: z.string() }, Item.nullable()) {}
