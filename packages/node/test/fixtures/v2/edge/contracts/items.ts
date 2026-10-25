import { Command, IfMatch, Model, Query, rejectable } from 'murmur';
import { z } from 'zod';

export class Item extends Model({ id: z.string(), title: z.string(), version: z.number() }) {}

export class Empty extends Model({}) {}

export class GetItem extends Query({ id: z.string() }, Item.nullable()) {}

export class ListItems extends Query(
  { tag: z.array(z.string()).optional(), limit: z.number().int().optional() },
  Item.array(),
) {}

export class UpdateItem extends Command(
  { id: z.string(), ifMatch: IfMatch, title: z.string() },
  rejectable(Item),
) {}

export class DeleteItem extends Command({ id: z.string() }, rejectable(Empty)) {}

export class FailItem extends Command({ id: z.string() }, Item) {}
