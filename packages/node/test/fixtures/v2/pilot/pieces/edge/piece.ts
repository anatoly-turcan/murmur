import { Piece, Serve } from 'murmur';

import web, { type WebRequest } from '../../capabilities/web/capability.ts';

export class Edge extends Piece() {
  @Serve(web.get('/whoami'))
  async whoami(req: WebRequest): Promise<{ peer: string; ip: string }> {
    return { peer: req.peer, ip: req.ip };
  }
}
