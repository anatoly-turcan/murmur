import { Handle, Piece } from 'murmur';

import { Pinged } from '../../contracts/pings.ts';

export class First extends Piece() {
  @Handle(Pinged)
  async pinged(): Promise<void> {}
}

export class Second extends Piece() {}
