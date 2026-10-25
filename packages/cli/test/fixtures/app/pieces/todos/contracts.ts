import { Event } from 'murmur';
import { z } from 'zod';

export class TodosCacheInvalidate extends Event({ id: z.string() }, { name: 'todos.cache.invalidate' }) {}
