import { Handle, Piece } from 'murmur';

import { Ping, type Pong } from '../../contracts/ping.ts';

export class Domain extends Piece() {
  @Handle(Ping)
  async ping(): Promise<Pong> {
    return { pong: true };
  }
}
