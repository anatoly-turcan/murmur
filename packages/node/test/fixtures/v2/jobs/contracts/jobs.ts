import { Command } from 'murmur';
import { z } from 'zod';

export class EnqueueInTx extends Command({ label: z.string(), rollback: z.boolean() }, {}) {}

export class Record extends Command({ label: z.string() }, {}) {}

export class Flaky extends Command({ label: z.string() }, {}) {}

export class Fatal extends Command({ label: z.string() }, {}) {}

export class Slow extends Command({ label: z.string(), ms: z.number() }, {}) {}

export class Again extends Command({ key: z.string(), times: z.number() }, {}) {}

export class Tick extends Command({}, {}) {}

export class Note extends Command({ label: z.string() }, {}) {}
