import { Event, Model, Query } from 'murmur';
import { z } from 'zod';

export class StreamStats extends Model({ clients: z.number(), aborted: z.number(), dropped: z.number() }) {}

export class GetStreamStats extends Query({}, StreamStats) {}

export class Tick extends Event({ n: z.number() }) {}
