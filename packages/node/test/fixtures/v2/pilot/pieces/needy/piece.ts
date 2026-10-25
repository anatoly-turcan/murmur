import { Piece } from 'murmur';

import web from '../../capabilities/web/capability.ts';

export class Needy extends Piece({ needs: { web } }) {}
