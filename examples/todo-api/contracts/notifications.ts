import { Command } from 'murmur';
import { z } from 'zod';

export class NotifyTodo extends Command({ id: z.string(), title: z.string() }, {}) {}

export class SweepNotifications extends Command({}, {}) {}
