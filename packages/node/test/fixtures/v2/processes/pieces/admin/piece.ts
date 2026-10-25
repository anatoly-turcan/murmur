import { Piece, Serve } from 'murmur';

import web from '../../capabilities/web/capability.ts';

export class Admin extends Piece() {
  @Serve(web.get('/status'))
  async status(): Promise<{ up: boolean }> {
    return { up: true };
  }
}
