import { Model, Query } from 'murmur';
import { z } from 'zod';

export class Pong extends Model({ pong: z.boolean() }) {}

export class Ping extends Query({}, Pong) {}
