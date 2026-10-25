import { Handle, Piece } from 'murmur';

import { Detonate } from '../../contracts/boom.ts';

function connect(): never {
  throw new Error('cannot reach the ledger');
}

export class Boom extends Piece() {
  private readonly ledger = connect();

  @Handle(Detonate)
  async detonate(): Promise<{ ok: boolean }> {
    return { ok: this.ledger };
  }
}
