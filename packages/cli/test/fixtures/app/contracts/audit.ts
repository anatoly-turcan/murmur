import { Event } from 'murmur';
import { z } from 'zod';

export class AuditRecorded extends Event({ todoId: z.string() }, { name: 'audit.recorded' }) {}
