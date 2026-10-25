import { Piece } from 'murmur';
import { z } from 'zod';

export class Cfg extends Piece({ config: { port: z.number() } }) {}
