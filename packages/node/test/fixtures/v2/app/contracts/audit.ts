import { Query } from 'murmur';
import { z } from 'zod';

export class AuditReport extends Query(
  {},
  { label: z.string(), todosAtStart: z.number(), seen: z.number() },
) {}
