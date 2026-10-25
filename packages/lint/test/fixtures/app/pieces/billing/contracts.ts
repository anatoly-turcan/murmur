import { Event } from 'murmur';
import { z } from 'zod';

export class SimTick extends Event({ n: z.number() }, { name: 'billing.sim.tick' }) {}
